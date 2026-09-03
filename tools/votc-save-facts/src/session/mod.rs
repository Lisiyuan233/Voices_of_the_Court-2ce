//! Persistent session subcommand (protocol v3).
//!
//! One process serves exactly one session bound to one exact-content snapshot:
//!
//! ```text
//! spawn session --input <save.ck3> --allowed-root <dir>
//! → session_open   : capture private artifact, verify envelope/fingerprint/
//!                    identity against the request, revalidate the source,
//!                    answer ready (index summary attached)
//! → character_*    : memory-index queries (bounded, serial; Task 4)
//! → session_close  : answer closed, release artifacts, exit 0
//! ```
//!
//! Protocol violations emit one bounded terminal error frame and exit;
//! recoverable query failures emit a typed error frame and keep serving.
//! stdout carries NDJSON frames only; diagnostics stay on stderr.

pub mod framing;
pub mod index;
pub mod profile;
pub mod protocol;
pub mod search;

use std::collections::HashSet;
use std::io::{BufRead, Write};
use std::path::Path;
use std::time::Instant;

use crate::envelope::{self, EnvelopeError};
use crate::error::ErrorCode;
use crate::identity::{self, IdentityError, ScanLimits};
use crate::limits;
use crate::session::framing::{emit_fatal_error, read_bounded_line, starts_with_bom, LineResult};
use crate::session::protocol::{
    validate_envelope, SessionCloseRequest, SessionCloseResponse, SessionDurationMetrics,
    SessionErrorFrame, SessionIdentityEcho, SessionManifest,
    SessionOpenRequest, SessionOpenResponse, SessionOperation, SessionProfileRequest,
    SessionSearchRequest, SESSION_PROTOCOL_VERSION,
};
use crate::snapshot::{BoundSnapshot, TempArtifact};

enum FrameOutcome {
    /// Keep serving.
    Continue,
    /// Close answered; release artifacts and exit cleanly.
    Close,
    /// Terminal error already emitted; stop.
    Fatal,
}

struct SessionState {
    session_id: Option<String>,
    seen_request_ids: HashSet<String>,
    bound: Option<BoundSnapshot>,
    gamestate: Option<TempArtifact>,
    source_fingerprint: Option<String>,
    header_line: Option<Vec<u8>>,
    index: Option<index::SessionIndex>,
    ready: bool,
    started: Instant,
}

impl SessionState {
    fn new() -> Self {
        Self {
            session_id: None,
            seen_request_ids: HashSet::new(),
            bound: None,
            gamestate: None,
            source_fingerprint: None,
            header_line: None,
            index: None,
            ready: false,
            started: Instant::now(),
        }
    }
}

/// Entry point used by main.rs. `input` is the CLI-provided save path,
/// `allowed_root` its canonicalized containment root.
pub fn run(
    input: &Path,
    allowed_root: &Path,
    reader: &mut impl BufRead,
    writer: &mut impl Write,
) -> i32 {
    let mut state = SessionState::new();
    loop {
        let line = match read_bounded_line(reader) {
            LineResult::Eof => {
                // EOF equals an implicit close: no response required.
                release(&mut state);
                return crate::EXIT_OK;
            }
            LineResult::Io => {
                let _ = emit_fatal_error(
                    None,
                    None,
                    None,
                    ErrorCode::SessionInternal,
                    "stdin read failure",
                    writer,
                );
                release(&mut state);
                return crate::EXIT_INTERNAL;
            }
            LineResult::TooLarge => {
                let _ = emit_fatal_error(
                    None,
                    None,
                    None,
                    ErrorCode::RequestLimitExceeded,
                    "frame exceeds 64 KiB input cap",
                    writer,
                );
                release(&mut state);
                return crate::EXIT_OK;
            }
            LineResult::Line(bytes) => bytes,
        };

        match handle_frame(input, allowed_root, &mut state, &line, writer) {
            FrameOutcome::Continue => {}
            FrameOutcome::Close | FrameOutcome::Fatal => {
                release(&mut state);
                return crate::EXIT_OK;
            }
        }
        note_activity();
    }
}

/// Millis since process start of the last completed frame.
static LAST_ACTIVITY_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static PROCESS_START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

fn note_activity() {
    let start = PROCESS_START.get_or_init(std::time::Instant::now);
    let millis = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
    LAST_ACTIVITY_MS.store(millis, std::sync::atomic::Ordering::Relaxed);
}

/// Idle self-exit watchdog (plan §6): started once a session becomes ready.
/// When no frame completes for the negotiated idle window the sidecar exits
/// silently; the App observes EOF and marks the session failed/closed.
pub(crate) fn spawn_idle_watchdog(idle_ms: u64) {
    let idle = idle_ms.max(limits::SESSION_MIN_IDLE_MS);
    let start = PROCESS_START.get_or_init(std::time::Instant::now);
    let baseline = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
    LAST_ACTIVITY_MS.store(baseline, std::sync::atomic::Ordering::Relaxed);
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let now = u64::try_from(
            PROCESS_START
                .get_or_init(std::time::Instant::now)
                .elapsed()
                .as_millis(),
        )
        .unwrap_or(u64::MAX);
        let last = LAST_ACTIVITY_MS.load(std::sync::atomic::Ordering::Relaxed);
        if now.saturating_sub(last) >= idle {
            // Silent self-exit: no stdout output, exit code 0.
            std::process::exit(crate::EXIT_OK);
        }
    });
}

fn release(state: &mut SessionState) {
    // Deterministic cleanup of private temp artifacts on every exit path
    // (Drop still covers panic unwinding).
    state.gamestate = None;
    state.bound = None;
    state.ready = false;
}

fn fatal(
    state: &SessionState,
    request_id: Option<&str>,
    operation: Option<SessionOperation>,
    code: ErrorCode,
    message: impl Into<String>,
    writer: &mut impl Write,
) -> FrameOutcome {
    let _ = emit_fatal_error(
        request_id,
        state.session_id.as_deref(),
        operation,
        code,
        message,
        writer,
    );
    FrameOutcome::Fatal
}

fn handle_frame(
    input: &Path,
    allowed_root: &Path,
    state: &mut SessionState,
    line: &[u8],
    writer: &mut impl Write,
) -> FrameOutcome {
    // BOM / empty-line rejection precedes any parsing.
    if starts_with_bom(line) {
        return fatal(
            state,
            None,
            None,
            ErrorCode::RequestInvalid,
            "BOM is not allowed before a frame",
            writer,
        );
    }
    if line.iter().all(|b| b.is_ascii_whitespace()) {
        return fatal(
            state,
            None,
            None,
            ErrorCode::RequestInvalid,
            "empty lines are not valid frames",
            writer,
        );
    }

    // Exactly one JSON document per line; trailing content is rejected by
    // from_slice. The Value round-trip lets us dispatch while keeping
    // deny_unknown_fields enforcement on the concrete DTOs.
    let value: serde_json::Value = match serde_json::from_slice(line) {
        Ok(value) => value,
        Err(_) => {
            return fatal(
                state,
                None,
                None,
                ErrorCode::RequestInvalid,
                "frame is not a single JSON object",
                writer,
            );
        }
    };
    let request_id = value.get("requestId").and_then(|v| v.as_str()).map(str::to_owned);
    let operation = parse_operation_tag(&value);

    macro_rules! parse_request {
        ($ty:ty, $op:expr) => {
            match serde_json::from_value::<$ty>(value.clone()) {
                Ok(request) => request,
                Err(_) => {
                    return fatal(
                        state,
                        request_id.as_deref(),
                        $op,
                        ErrorCode::RequestInvalid,
                        "frame failed schema validation",
                        writer,
                    );
                }
            }
        };
    }

    macro_rules! reject_if {
        ($condition:expr, $req_id:expr, $op:expr, $message:expr) => {
            if $condition {
                return fatal(
                    state,
                    $req_id,
                    $op,
                    ErrorCode::RequestInvalid,
                    $message,
                    writer,
                );
            }
        };
    }

    match value.get("operation").and_then(|op| op.as_str()) {
        Some("session_open") => {
            let request = parse_request!(SessionOpenRequest, Some(SessionOperation::SessionOpen));
            reject_if!(
                validate_envelope(
                    request.protocol_version,
                    &request.request_id,
                    &request.session_id
                )
                .is_err(),
                None,
                Some(SessionOperation::SessionOpen),
                "invalid envelope"
            );
            reject_if!(
                state.session_id.is_some(),
                Some(request.request_id.as_str()),
                Some(SessionOperation::SessionOpen),
                "session is already open"
            );
            reject_if!(
                !state.seen_request_ids.insert(request.request_id.clone()),
                Some(request.request_id.as_str()),
                Some(SessionOperation::SessionOpen),
                "duplicate requestId"
            );
            state.session_id = Some(request.session_id.clone());
            handle_open(input, allowed_root, state, &request, writer)
        }
        Some("character_search") => {
            let request =
                parse_request!(SessionSearchRequest, Some(SessionOperation::CharacterSearch));
            reject_if!(
                validate_envelope(
                    request.protocol_version,
                    &request.request_id,
                    &request.session_id
                )
                .is_err(),
                None,
                Some(SessionOperation::CharacterSearch),
                "invalid envelope"
            );
            reject_if!(
                !check_known_session(state, &request.session_id),
                Some(request.request_id.as_str()),
                Some(SessionOperation::CharacterSearch),
                "unknown sessionId"
            );
            reject_if!(
                !state.seen_request_ids.insert(request.request_id.clone()),
                Some(request.request_id.as_str()),
                Some(SessionOperation::CharacterSearch),
                "duplicate requestId"
            );
            handle_search(state, &request, writer)
        }
        Some("character_profile") => {
            let request =
                parse_request!(SessionProfileRequest, Some(SessionOperation::CharacterProfile));
            reject_if!(
                validate_envelope(
                    request.protocol_version,
                    &request.request_id,
                    &request.session_id
                )
                .is_err(),
                None,
                Some(SessionOperation::CharacterProfile),
                "invalid envelope"
            );
            reject_if!(
                !check_known_session(state, &request.session_id),
                Some(request.request_id.as_str()),
                Some(SessionOperation::CharacterProfile),
                "unknown sessionId"
            );
            reject_if!(
                !state.seen_request_ids.insert(request.request_id.clone()),
                Some(request.request_id.as_str()),
                Some(SessionOperation::CharacterProfile),
                "duplicate requestId"
            );
            handle_profile(state, &request, writer)
        }
        Some("session_close") => {
            let request = parse_request!(SessionCloseRequest, Some(SessionOperation::SessionClose));
            reject_if!(
                validate_envelope(
                    request.protocol_version,
                    &request.request_id,
                    &request.session_id
                )
                .is_err(),
                None,
                Some(SessionOperation::SessionClose),
                "invalid envelope"
            );
            reject_if!(
                !check_known_session(state, &request.session_id),
                Some(request.request_id.as_str()),
                Some(SessionOperation::SessionClose),
                "unknown sessionId"
            );
            reject_if!(
                !state.seen_request_ids.insert(request.request_id.clone()),
                Some(request.request_id.as_str()),
                Some(SessionOperation::SessionClose),
                "duplicate requestId"
            );
            let response = SessionCloseResponse {
                protocol_version: SESSION_PROTOCOL_VERSION,
                request_id: request.request_id,
                session_id: request.session_id,
                operation: SessionOperation::SessionClose,
                status: "closed",
                metrics: SessionDurationMetrics {
                    duration_ms: elapsed_ms(state.started),
                },
            };
            if !framing::emit_frame(&response, writer) {
                return FrameOutcome::Fatal;
            }
            FrameOutcome::Close
        }
        _ => fatal(
            state,
            request_id.as_deref(),
            operation,
            ErrorCode::RequestInvalid,
            "unknown operation",
            writer,
        ),
    }
}

fn check_known_session(state: &SessionState, session_id: &str) -> bool {
    state.session_id.as_deref() == Some(session_id)
}

/// Recoverable typed error: same wire shape as fatal errors but the session
/// stays alive so the client can continue or close cleanly.
fn recoverable(
    state: &SessionState,
    request_id: &str,
    operation: SessionOperation,
    code: ErrorCode,
    message: &str,
    writer: &mut impl Write,
) -> FrameOutcome {
    let frame = SessionErrorFrame {
        protocol_version: SESSION_PROTOCOL_VERSION,
        request_id: Some(request_id.to_string()),
        session_id: state.session_id.clone(),
        operation: Some(operation),
        status: "error",
        error_code: code,
        message: message.to_string(),
    };
    if !framing::emit_frame(&frame, writer) {
        return FrameOutcome::Fatal;
    }
    FrameOutcome::Continue
}

/// Terminal output-budget failure (frozen cap table: stdout frame overflow).
fn limit_fatal(
    state: &SessionState,
    writer: &mut impl Write,
) -> FrameOutcome {
    let _ = emit_fatal_error(
        None,
        state.session_id.as_deref(),
        None,
        ErrorCode::ParserOutputLimit,
        "response exceeded the frozen stdout frame cap",
        writer,
    );
    FrameOutcome::Fatal
}

/// Canonical decimal character/title id (`[0-9]+`, no leading zeros beyond
/// a single zero digit).
fn is_canonical_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 19
        && value.bytes().all(|b| b.is_ascii_digit())
        && (value.len() == 1 || value.as_bytes()[0] != b'0')
}

fn parse_operation_tag(value: &serde_json::Value) -> Option<SessionOperation> {
    match value.get("operation").and_then(|op| op.as_str()) {
        Some("session_open") => Some(SessionOperation::SessionOpen),
        Some("character_search") => Some(SessionOperation::CharacterSearch),
        Some("character_profile") => Some(SessionOperation::CharacterProfile),
        Some("session_close") => Some(SessionOperation::SessionClose),
        _ => None,
    }
}

/// Queries answered before the public index exists. With serial frame
/// processing this is only reachable if a future change breaks open-first;
/// kept as an honest defensive state.
fn handle_not_ready_query(
    request_id: &str,
    operation: SessionOperation,
    state: &SessionState,
    writer: &mut impl Write,
) -> FrameOutcome {
    let frame = SessionErrorFrame {
        protocol_version: SESSION_PROTOCOL_VERSION,
        request_id: Some(request_id.to_owned()),
        session_id: state.session_id.clone(),
        operation: Some(operation),
        status: "error",
        error_code: ErrorCode::SessionNotReady,
        message: "public index is not available".into(),
    };
    if !framing::emit_frame(&frame, writer) {
        return FrameOutcome::Fatal;
    }
    FrameOutcome::Continue
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PrimaryTitleRef {
    title_id: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchCandidateDto {
    character_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    literal_name: Option<String>,
    /// Nested per the frozen wire contract (§5.3): raw numeric id stays
    /// main-only; loc-key resolution happens App-side.
    #[serde(skip_serializing_if = "Option::is_none")]
    primary_title: Option<PrimaryTitleRef>,
    matched_by: Vec<&'static str>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchResponseFrame {
    protocol_version: u32,
    request_id: String,
    session_id: String,
    operation: SessionOperation,
    status: &'static str,
    candidates: Vec<SearchCandidateDto>,
    truncated: bool,
    warning_codes: Vec<String>,
    metrics: SessionDurationMetrics,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileResponseFrame {
    protocol_version: u32,
    request_id: String,
    session_id: String,
    operation: SessionOperation,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile: Option<profile::ProfileData>,
    warning_codes: Vec<String>,
    metrics: SessionDurationMetrics,
}

fn handle_search(
    state: &mut SessionState,
    request: &SessionSearchRequest,
    writer: &mut impl Write,
) -> FrameOutcome {
    let Some(index) = state.index.as_ref() else {
        return handle_not_ready_query(
            &request.request_id,
            SessionOperation::CharacterSearch,
            state,
            writer,
        );
    };

    // Semantic selector validation (plan §5.2): at least one selector, all
    // values canonical and within frozen caps.
    let selectors = &request.selectors;
    let has_any = !selectors.candidate_character_ids.is_empty()
        || !selectors.primary_title_keys.is_empty()
        || selectors.literal_name_query.is_some()
        || selectors.relation.is_some();
    if !has_any {
        return recoverable(
            state,
            &request.request_id,
            SessionOperation::CharacterSearch,
            ErrorCode::RequestInvalid,
            "search requires at least one selector",
            writer,
        );
    }
    if !selectors.candidate_character_ids.is_empty() {
        let ids = &selectors.candidate_character_ids;
        if ids.len() > limits::MAX_SEARCH_CANDIDATE_IDS
            || ids.iter().any(|id| !is_canonical_id(id))
        {
            return recoverable(
                state,
                &request.request_id,
                SessionOperation::CharacterSearch,
                ErrorCode::RequestInvalid,
                "candidateCharacterIds must be 1..16 canonical decimal ids",
                writer,
            );
        }
    }
    if !selectors.primary_title_keys.is_empty()
        && selectors.primary_title_keys.len() > limits::MAX_SEARCH_TITLE_KEYS
    {
        return recoverable(
            state,
            &request.request_id,
            SessionOperation::CharacterSearch,
            ErrorCode::RequestInvalid,
            "primaryTitleKeys must be 1..16 title keys",
            writer,
        );
    }
    if let Some(query) = &selectors.literal_name_query {
        if query.is_empty() || query.chars().count() > limits::MAX_SEARCH_LITERAL_QUERY_CHARS {
            return recoverable(
                state,
                &request.request_id,
                SessionOperation::CharacterSearch,
                ErrorCode::RequestInvalid,
                "literalNameQuery length out of range",
                writer,
            );
        }
    }
    if !(1..=limits::MAX_SEARCH_RESULTS).contains(&request.limit) {
        return recoverable(
            state,
            &request.request_id,
            SessionOperation::CharacterSearch,
            ErrorCode::RequestInvalid,
            "limit must be within 1..=8",
            writer,
        );
    }

    let started = Instant::now();
    let output = search::execute(index, selectors, request.limit);
    let response = SearchResponseFrame {
        protocol_version: SESSION_PROTOCOL_VERSION,
        request_id: request.request_id.clone(),
        session_id: request.session_id.clone(),
        operation: SessionOperation::CharacterSearch,
        status: output.status,
        candidates: output
            .candidates
            .into_iter()
            .map(|candidate| SearchCandidateDto {
                character_id: candidate.character_id,
                literal_name: candidate.literal_name,
                primary_title: candidate.primary_title_id.map(|title_id| PrimaryTitleRef { title_id }),
                matched_by: candidate.matched_by,
            })
            .collect(),
        truncated: output.truncated,
        warning_codes: Vec::new(),
        metrics: SessionDurationMetrics {
            duration_ms: elapsed_ms(started),
        },
    };
    if !framing::emit_frame(&response, writer) {
        return limit_fatal(state, writer);
    }
    FrameOutcome::Continue
}

fn handle_profile(
    state: &mut SessionState,
    request: &SessionProfileRequest,
    writer: &mut impl Write,
) -> FrameOutcome {
    let Some(index) = state.index.as_ref() else {
        return handle_not_ready_query(
            &request.request_id,
            SessionOperation::CharacterProfile,
            state,
            writer,
        );
    };

    // Exactly one character (protocol shape), canonical id, bounded sections.
    if !is_canonical_id(&request.character_id) {
        return recoverable(
            state,
            &request.request_id,
            SessionOperation::CharacterProfile,
            ErrorCode::RequestInvalid,
            "characterId must be a canonical decimal id",
            writer,
        );
    }
    let unique_sections = profile::canonical_sections(&request.sections);
    if unique_sections.len() != request.sections.len()
        || request.sections.is_empty()
        || request.sections.len() > profile::MAX_PROFILE_SECTIONS
    {
        return recoverable(
            state,
            &request.request_id,
            SessionOperation::CharacterProfile,
            ErrorCode::RequestInvalid,
            "sections must be 1..5 unique entries",
            writer,
        );
    }

    let started = Instant::now();
    let output = match profile::build_profile(index, &request.character_id, &request.sections) {
        Some(output) => output,
        None => {
            // Unknown character: honest not_found, not a fake empty profile.
            let response = ProfileResponseFrame {
                protocol_version: SESSION_PROTOCOL_VERSION,
                request_id: request.request_id.clone(),
                session_id: request.session_id.clone(),
                operation: SessionOperation::CharacterProfile,
                status: "not_found",
                profile: None,
                warning_codes: Vec::new(),
                metrics: SessionDurationMetrics {
                    duration_ms: elapsed_ms(started),
                },
            };
            if !framing::emit_frame(&response, writer) {
                return limit_fatal(state, writer);
            }
            return FrameOutcome::Continue;
        }
    };
    let status = output.status;
    let response = ProfileResponseFrame {
        protocol_version: SESSION_PROTOCOL_VERSION,
        request_id: request.request_id.clone(),
        session_id: request.session_id.clone(),
        operation: SessionOperation::CharacterProfile,
        status,
        profile: output.data,
        warning_codes: Vec::new(),
        metrics: SessionDurationMetrics {
            duration_ms: elapsed_ms(started),
        },
    };
    if !framing::emit_frame(&response, writer) {
        return limit_fatal(state, writer);
    }
    FrameOutcome::Continue
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

// ---------------------------------------------------------------------------
// session_open: exact snapshot binding (Task 2 scope; index arrives in Task 3)
// ---------------------------------------------------------------------------

fn handle_open(
    input: &Path,
    allowed_root: &Path,
    state: &mut SessionState,
    request: &SessionOpenRequest,
    writer: &mut impl Write,
) -> FrameOutcome {
    let open_started = Instant::now();
    let expected = &request.expected;
    let limits_requested = &request.limits;

    // App may lower but never raise hard caps.
    if limits_requested.max_decompressed_bytes > limits::HARD_MAX_DECOMPRESSED_BYTES
        || limits_requested.max_nesting_depth > limits::HARD_MAX_NESTING_DEPTH
        || limits_requested.max_scalar_bytes > limits::HARD_MAX_SCALAR_BYTES
        || limits_requested.max_characters > limits::HARD_MAX_SESSION_CHARACTERS
        || limits_requested.max_titles > limits::HARD_MAX_SESSION_TITLES
        || limits_requested.max_relations_per_character
            > limits::HARD_MAX_SESSION_RELATIONS_PER_CHARACTER
        || limits_requested.max_idle_ms > limits::SESSION_HARD_MAX_IDLE_MS
        || expected.snapshot_slot > 1
    {
        return fatal(
            state,
            Some(&request.request_id),
            Some(SessionOperation::SessionOpen),
            ErrorCode::RequestInvalid,
            "open limits exceed frozen hard caps",
            writer,
        );
    }

    let scan_limits = ScanLimits {
        max_bytes: limits_requested.max_decompressed_bytes,
        max_nesting: limits_requested.max_nesting_depth as u32,
        max_scalar: limits_requested.max_scalar_bytes as usize,
    };

    let bound = match BoundSnapshot::capture(
        input,
        allowed_root,
        limits_requested.max_decompressed_bytes,
    ) {
        Ok(bound) => bound,
        Err(code) => {
            return fatal(
                state,
                Some(&request.request_id),
                Some(SessionOperation::SessionOpen),
                code,
                "could not bind exact snapshot",
                writer,
            );
        }
    };

    let opened = match envelope::open(bound.raw_path()) {
        Ok(opened) => opened,
        Err(error) => {
            let code = map_envelope_error(error);
            return fatal(
                state,
                Some(&request.request_id),
                Some(SessionOperation::SessionOpen),
                code.1,
                "save envelope rejected",
                writer,
            );
        }
    };
    let header_line = opened.header_line.clone();
    let source_fingerprint =
        match crate::fingerprint::source_fingerprint(bound.raw_path(), &opened.header_line) {
            Ok(fingerprint) => fingerprint,
            Err(_) => {
                return fatal(
                    state,
                    Some(&request.request_id),
                    Some(SessionOperation::SessionOpen),
                    ErrorCode::SaveReadDenied,
                    "fingerprint failed",
                    writer,
                );
            }
        };
    if !source_fingerprint.eq_ignore_ascii_case(&expected.source_fingerprint) {
        return fatal(
            state,
            Some(&request.request_id),
            Some(SessionOperation::SessionOpen),
            ErrorCode::SaveIdentityMismatch,
            "source fingerprint mismatch",
            writer,
        );
    }
    // binary：版本门禁 → melt 成明文，物化为私有临时 artifact 后走既有
    // 文本索引路径；melt 输出经 materialize_gamestate 流式写盘并受
    // max_decompressed_bytes 上限约束（不整体进内存）。text 路径行为不变。
    let mut melt_stats: Option<crate::melt::SharedMeltStats> = None;
    if opened.is_binary() {
        let gate_reader = match opened.gamestate_binary() {
            Ok(reader) => reader,
            Err(error) => {
                let (_, code) = map_envelope_error(error);
                return fatal(
                    state,
                    Some(&request.request_id),
                    Some(SessionOperation::SessionOpen),
                    code,
                    "binary gamestate stream rejected",
                    writer,
                );
            }
        };
        let gate_failure = match crate::melt::check_version(
            gate_reader,
            crate::melt::VERSION_GATE_MAX_BYTES,
        ) {
            Ok(()) => None,
            Err(crate::melt::VersionGateError::Mismatch) => Some((
                ErrorCode::SaveTokenVersionMismatch,
                "save version does not match token table",
            )),
            Err(crate::melt::VersionGateError::Truncated) => {
                Some((ErrorCode::SaveTruncated, "binary meta section unreadable"))
            }
            Err(crate::melt::VersionGateError::ParseFailed) => {
                Some((ErrorCode::SaveParseFailed, "binary meta section malformed"))
            }
        };
        if let Some((code, message)) = gate_failure {
            return fatal(
                state,
                Some(&request.request_id),
                Some(SessionOperation::SessionOpen),
                code,
                message,
                writer,
            );
        }
        melt_stats = Some(crate::melt::new_stats());
    }

    let gamestate_reader: Box<dyn std::io::Read + '_> = if let Some(stats) = &melt_stats {
        match opened.gamestate_binary_verified() {
            Ok(reader) => Box::new(crate::melt::MeltReader::new(reader, stats.clone())),
            Err(error) => {
                let (_, code) = map_envelope_error(error);
                return fatal(
                    state,
                    Some(&request.request_id),
                    Some(SessionOperation::SessionOpen),
                    code,
                    "gamestate stream rejected",
                    writer,
                );
            }
        }
    } else {
        match opened.gamestate_verified() {
            Ok(reader) => reader,
            Err(error) => {
                let (_, code) = map_envelope_error(error);
                return fatal(
                    state,
                    Some(&request.request_id),
                    Some(SessionOperation::SessionOpen),
                    code,
                    "gamestate stream rejected",
                    writer,
                );
            }
        }
    };
    let gamestate = match bound.materialize_gamestate(
        gamestate_reader,
        limits_requested.max_decompressed_bytes,
    ) {
        Ok(artifact) => artifact,
        Err(code) => {
            return fatal(
                state,
                Some(&request.request_id),
                Some(SessionOperation::SessionOpen),
                code,
                "gamestate materialization failed",
                writer,
            );
        }
    };
    // session_open 响应无 warnings 通道；未解析 token 计数只写有界 stderr 诊断。
    if let Some(stats) = &melt_stats {
        let unresolved = stats.unresolved_tokens.get();
        if unresolved > 0 {
            eprintln!(
                "votc-save-facts: session melt produced {} unresolved token(s) ({})",
                unresolved.min(9_999_999),
                crate::melt::WARN_TOKENS_PARTIALLY_UNRESOLVED
            );
        }
    }
    let source_format = match opened.format {
        crate::protocol::SourceFormat::UnifiedText => "unified_text",
        crate::protocol::SourceFormat::ZipText => "zip_text",
        crate::protocol::SourceFormat::ZipBinary => "zip_binary",
        crate::protocol::SourceFormat::UnifiedBinary => "unified_binary",
        crate::protocol::SourceFormat::Unknown => "unknown",
    };
    drop(opened);

    let extraction = {
        let root = match gamestate.open() {
            Ok(file) => file,
            Err(_) => {
                return fatal(
                    state,
                    Some(&request.request_id),
                    Some(SessionOperation::SessionOpen),
                    ErrorCode::SaveReadDenied,
                    "artifact unreadable",
                    writer,
                );
            }
        };
        let player = match gamestate.open() {
            Ok(file) => file,
            Err(_) => {
                return fatal(
                    state,
                    Some(&request.request_id),
                    Some(SessionOperation::SessionOpen),
                    ErrorCode::SaveReadDenied,
                    "artifact unreadable",
                    writer,
                );
            }
        };
        match identity::extract(root, player, scan_limits) {
            Ok(extraction) => extraction,
            Err(error) => {
                return fatal(
                    state,
                    Some(&request.request_id),
                    Some(SessionOperation::SessionOpen),
                    map_identity_error(error),
                    "identity scan failed",
                    writer,
                );
            }
        }
    };
    let actual = &extraction.identity;
    let mismatch = |code| Some((code, "identity mismatch"));
    let failure = if actual.player_character_id.as_deref()
        != Some(expected.player_character_id.as_str())
    {
        mismatch(ErrorCode::SavePlayerMismatch)
    } else if actual.campaign_id_parts != Some(expected.campaign_id_parts) {
        mismatch(ErrorCode::SaveCampaignMismatch)
    } else if actual.snapshot_sequence != Some(expected.snapshot_sequence) {
        mismatch(ErrorCode::SaveSequenceMismatch)
    } else if actual.snapshot_slot != Some(expected.snapshot_slot) {
        mismatch(ErrorCode::SaveSlotMismatch)
    } else if actual.game_date_numeric != Some(expected.game_date_numeric) {
        mismatch(ErrorCode::SaveDateMismatch)
    } else {
        None
    };
    if let Some((code, message)) = failure {
        return fatal(
            state,
            Some(&request.request_id),
            Some(SessionOperation::SessionOpen),
            code,
            message,
            writer,
        );
    }

    // One-pass bounded public index build (plan §7) from the private
    // artifact; queries afterwards never rescan the source (R3).
    let session_index = {
        let reader = match gamestate.open() {
            Ok(file) => file,
            Err(_) => {
                return fatal(
                    state,
                    Some(&request.request_id),
                    Some(SessionOperation::SessionOpen),
                    ErrorCode::SaveReadDenied,
                    "artifact unreadable",
                    writer,
                );
            }
        };
        match index::build(reader, scan_limits, limits_requested) {
            Ok(built) => built,
            Err(error) => {
                return fatal(
                    state,
                    Some(&request.request_id),
                    Some(SessionOperation::SessionOpen),
                    map_identity_error(error),
                    "public index build failed",
                    writer,
                );
            }
        }
    };

    // Source must still be the exact bytes we captured before answering ready.
    if let Err(code) = bound.revalidate_source(&header_line, &source_fingerprint) {
        return fatal(
            state,
            Some(&request.request_id),
            Some(SessionOperation::SessionOpen),
            code,
            "source changed during open",
            writer,
        );
    }

    state.bound = Some(bound);
    state.gamestate = Some(gamestate);
    state.source_fingerprint = Some(source_fingerprint);
    state.header_line = Some(header_line);
    let summary = session_index.summary();
    state.index = Some(session_index);
    state.ready = true;
    spawn_idle_watchdog(limits_requested.max_idle_ms);

    let response = SessionOpenResponse {
        protocol_version: SESSION_PROTOCOL_VERSION,
        request_id: request.request_id.clone(),
        session_id: request.session_id.clone(),
        operation: SessionOperation::SessionOpen,
        status: "ready",
        identity: SessionIdentityEcho {
            player_character_id: expected.player_character_id.clone(),
            game_date_numeric: expected.game_date_numeric,
            campaign_id_parts: expected.campaign_id_parts,
            snapshot_sequence: expected.snapshot_sequence,
            snapshot_slot: expected.snapshot_slot,
        },
        manifest: SessionManifest {
            source_fingerprint: state.source_fingerprint.clone().unwrap_or_default(),
            source_format: source_format.into(),
            parser_version: env!("CARGO_PKG_VERSION").to_string(),
        },
        index: summary,
        metrics: SessionDurationMetrics {
            duration_ms: elapsed_ms(open_started),
        },
    };
    if !framing::emit_frame(&response, writer) {
        return FrameOutcome::Fatal;
    }
    FrameOutcome::Continue
}

fn map_envelope_error(error: EnvelopeError) -> (crate::protocol::Status, ErrorCode) {
    match error {
        EnvelopeError::Unknown => (crate::protocol::Status::Unsupported, ErrorCode::SaveEnvelopeUnknown),
        EnvelopeError::Truncated => (crate::protocol::Status::Invalid, ErrorCode::SaveTruncated),
        EnvelopeError::EntryMissing => (crate::protocol::Status::Invalid, ErrorCode::SaveEntryMissing),
        EnvelopeError::DuplicateGamestate => (crate::protocol::Status::Invalid, ErrorCode::SaveParseFailed),
        EnvelopeError::DeclaredTooLarge => (crate::protocol::Status::Invalid, ErrorCode::SaveLimitExceeded),
        EnvelopeError::UnsupportedCompression => (
            crate::protocol::Status::Unsupported,
            ErrorCode::SaveVersionUnsupported,
        ),
    }
}

fn map_identity_error(error: IdentityError) -> ErrorCode {
    match error {
        IdentityError::Truncated => ErrorCode::SaveTruncated,
        IdentityError::LimitExceeded => ErrorCode::SaveLimitExceeded,
        IdentityError::ParseFailed | IdentityError::Io => ErrorCode::SaveParseFailed,
    }
}
