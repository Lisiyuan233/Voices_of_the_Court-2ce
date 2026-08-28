//! 请求/响应协议 DTO（实施计划 5.3/5.4 节）、stdin 有界读取与请求校验。

use std::io::Read;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::error::ErrorCode;
use crate::limits;

pub const EXTRACT_PROTOCOL_VERSION: u32 = 2;
pub const VERIFY_PROTOCOL_VERSION: u32 = 2;
/// v1 compatibility alias. Existing probe/extract DTOs continue to serialize
/// exactly as before; versioning is now operation-specific.
pub const PROTOCOL_VERSION: u32 = EXTRACT_PROTOCOL_VERSION;
pub const FACT_SCHEMA_VERSION: u32 = 1;

/// manifest 占位值：snapshotId / sourceFingerprint 由 Task 3 实现、Task 5 冻结算法。
const MANIFEST_PLACEHOLDER: &str = "pending-task3";

// ---------------------------------------------------------------------------
// 请求（计划 5.3 节 SaveFactExtractionRequestV1）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Probe,
    Extract,
    Verify,
    Capabilities,
    /// Persistent session subcommand (protocol v3). Never valid inside v1/v2
    /// request DTOs; those reject it via operation-mismatch validation.
    Session,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Identity,
    Family,
    Realm,
    War,
    Activity,
    Location,
    Court,
}

/// unknown 字段策略：**拒绝**（deny_unknown_fields）。
/// 协议演进时显式新增字段并同步 App 与 sidecar 版本，避免版本漂移时
/// 新字段被旧 sidecar 静默忽略而产生难以排查的行为差异。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveFactExtractionRequestV1 {
    pub protocol_version: u64,
    pub operation: Operation,
    pub expected: ExpectedIdentity,
    pub categories: Vec<Category>,
    pub limits: RequestLimits,
}

/// 请求中的 expected identity。Task 3 做 identity 校验时消费全部字段，
/// 本任务只消费 participant_character_ids 与 snapshot_slot。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
pub struct ExpectedIdentity {
    pub player_character_id: String,
    pub participant_character_ids: Vec<String>,
    pub game_date_numeric: u64,
    pub campaign_id: String,
    pub campaign_id_parts: [u64; 4],
    pub snapshot_sequence: u64,
    pub snapshot_slot: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestLimits {
    pub max_facts: u64,
    pub max_entities: u64,
    pub max_related_characters: u64,
    pub max_output_bytes: u64,
    pub max_decompressed_bytes: u64,
    pub max_nesting_depth: u64,
    pub max_scalar_bytes: u64,
}

/// 校验后的请求。participants / categories / limits 供 Task 3 提取路径
/// 消费，本任务只校验不消费（max_output_bytes 除外）。
#[derive(Debug)]
#[allow(dead_code)]
pub struct ValidatedRequest {
    /// participantCharacterIds 已去重并做稳定排序。
    pub participants: Vec<String>,
    pub categories: Vec<Category>,
    pub limits: RequestLimits,
    /// 生效输出上限 = min(CLI --max-output-bytes, request.limits.maxOutputBytes)。
    pub max_output_bytes: u64,
}

// ---------------------------------------------------------------------------
// protocol v2 typed verification DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveVerificationRequestV2 {
    pub protocol_version: u32,
    pub operation: Operation,
    pub expected: SaveVerificationExpectedIdentityV2,
    pub checks: Vec<SaveVerificationCheckV2>,
    pub limits: VerificationLimitsV2,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveVerificationExpectedIdentityV2 {
    pub player_character_id: String,
    pub participant_character_ids: Vec<String>,
    pub game_date_numeric: u64,
    pub campaign_id: String,
    pub campaign_id_parts: [u64; 4],
    pub snapshot_sequence: u64,
    pub snapshot_slot: u64,
    pub source_fingerprint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationSkillV2 {
    Diplomacy,
    Martial,
    Stewardship,
    Intrigue,
    Learning,
    Prowess,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationCouncilPositionV2 {
    Chancellor,
    Marshal,
    Steward,
    Spymaster,
    CourtChaplain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationCourtPositionV2 {
    Physician,
    Bodyguard,
    Seneschal,
    FoodTaster,
    CourtTutor,
}

/// Closed typed allowlist: no fieldPath, JSONPath, arbitrary predicate, or
/// living-character enumeration is accepted by this wire DTO.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[allow(clippy::enum_variant_names)] // wire kinds intentionally share the frozen character_ prefix
pub enum SaveVerificationCheckV2 {
    CharacterLifeState {
        check_id: String,
        character_id: String,
    },
    CharacterHasTrait {
        check_id: String,
        character_id: String,
        trait_id: u64,
    },
    CharacterSkillAtLeast {
        check_id: String,
        character_id: String,
        skill: VerificationSkillV2,
        value: i64,
    },
    CharacterHasCouncilPosition {
        check_id: String,
        character_id: String,
        position: VerificationCouncilPositionV2,
    },
    CharacterHasCourtPosition {
        check_id: String,
        character_id: String,
        position: VerificationCourtPositionV2,
    },
    CharacterIsCommander {
        check_id: String,
        character_id: String,
    },
    CharacterGoldAtLeast {
        check_id: String,
        character_id: String,
        value: i64,
    },
}

impl SaveVerificationCheckV2 {
    pub(crate) fn check_id(&self) -> &str {
        match self {
            Self::CharacterLifeState { check_id, .. }
            | Self::CharacterHasTrait { check_id, .. }
            | Self::CharacterSkillAtLeast { check_id, .. }
            | Self::CharacterHasCouncilPosition { check_id, .. }
            | Self::CharacterHasCourtPosition { check_id, .. }
            | Self::CharacterIsCommander { check_id, .. }
            | Self::CharacterGoldAtLeast { check_id, .. } => check_id,
        }
    }

    pub(crate) fn character_id(&self) -> &str {
        match self {
            Self::CharacterLifeState { character_id, .. }
            | Self::CharacterHasTrait { character_id, .. }
            | Self::CharacterSkillAtLeast { character_id, .. }
            | Self::CharacterHasCouncilPosition { character_id, .. }
            | Self::CharacterHasCourtPosition { character_id, .. }
            | Self::CharacterIsCommander { character_id, .. }
            | Self::CharacterGoldAtLeast { character_id, .. } => character_id,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerificationLimitsV2 {
    pub max_checks: u64,
    pub max_characters: u64,
    pub max_output_bytes: u64,
    pub max_decompressed_bytes: u64,
    pub max_nesting_depth: u64,
    pub max_scalar_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum VerificationUnknownReasonV2 {
    CharacterNotFound,
    FieldNotAvailable,
    SaveVersionUnsupported,
    PartialParse,
    LimitExceeded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VerificationLifeStateV2 {
    Living,
    Dead,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum VerificationLifeOutcomeV2 {
    Known {
        life_state: VerificationLifeStateV2,
    },
    Unknown {
        reason_code: VerificationUnknownReasonV2,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum VerificationBooleanOutcomeV2 {
    Known {
        value: bool,
    },
    Unknown {
        reason_code: VerificationUnknownReasonV2,
    },
}

/// Flat wire result. `kind` is the outer discriminant and `status` is the
/// inner discriminant, so known life-state results cannot carry `value`, and
/// unknown results cannot carry either known payload.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[allow(clippy::enum_variant_names)] // mirrors the closed request discriminants one-for-one
pub enum SaveVerificationResultV2 {
    CharacterLifeState {
        check_id: String,
        #[serde(flatten)]
        outcome: VerificationLifeOutcomeV2,
    },
    CharacterHasTrait {
        check_id: String,
        #[serde(flatten)]
        outcome: VerificationBooleanOutcomeV2,
    },
    CharacterSkillAtLeast {
        check_id: String,
        #[serde(flatten)]
        outcome: VerificationBooleanOutcomeV2,
    },
    CharacterHasCouncilPosition {
        check_id: String,
        #[serde(flatten)]
        outcome: VerificationBooleanOutcomeV2,
    },
    CharacterHasCourtPosition {
        check_id: String,
        #[serde(flatten)]
        outcome: VerificationBooleanOutcomeV2,
    },
    CharacterIsCommander {
        check_id: String,
        #[serde(flatten)]
        outcome: VerificationBooleanOutcomeV2,
    },
    CharacterGoldAtLeast {
        check_id: String,
        #[serde(flatten)]
        outcome: VerificationBooleanOutcomeV2,
    },
}

impl SaveVerificationResultV2 {
    pub(crate) fn is_unknown(&self) -> bool {
        match self {
            Self::CharacterLifeState { outcome, .. } => {
                matches!(outcome, VerificationLifeOutcomeV2::Unknown { .. })
            }
            Self::CharacterHasTrait { outcome, .. }
            | Self::CharacterSkillAtLeast { outcome, .. }
            | Self::CharacterHasCouncilPosition { outcome, .. }
            | Self::CharacterHasCourtPosition { outcome, .. }
            | Self::CharacterIsCommander { outcome, .. }
            | Self::CharacterGoldAtLeast { outcome, .. } => {
                matches!(outcome, VerificationBooleanOutcomeV2::Unknown { .. })
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationManifestV2 {
    pub source_fingerprint: String,
    pub source_format: SourceFormat,
    pub parser_version: String,
    pub fact_schema_version: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationIdentityV2 {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player_character_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_date_numeric: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub campaign_id_parts: Option<[u64; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_sequence: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_slot: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationMetricsV2 {
    pub duration_ms: u64,
    pub checked_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveVerificationResponseV2 {
    pub protocol_version: u32,
    pub operation: Operation,
    pub status: Status,
    pub manifest: VerificationManifestV2,
    pub identity: VerificationIdentityV2,
    pub results: Vec<SaveVerificationResultV2>,
    pub warnings: Vec<Warning>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
    pub metrics: VerificationMetricsV2,
}

pub fn read_verification_request(
    stdin: impl Read,
) -> Result<SaveVerificationRequestV2, RequestReadError> {
    let mut limited = stdin.take(limits::HARD_MAX_STDIN_REQUEST_BYTES as u64 + 1);
    let mut buf = Vec::new();
    if limited.read_to_end(&mut buf).is_err() {
        return Err(RequestReadError::Invalid);
    }
    if buf.len() > limits::HARD_MAX_STDIN_REQUEST_BYTES {
        return Err(RequestReadError::TooLarge);
    }
    serde_json::from_slice(&buf).map_err(|_| RequestReadError::Invalid)
}

pub fn validate_verification_request(
    request: &SaveVerificationRequestV2,
    cli_max_output_bytes: u64,
) -> Result<(), ErrorCode> {
    if request.protocol_version != VERIFY_PROTOCOL_VERSION || request.operation != Operation::Verify
    {
        return Err(ErrorCode::RequestInvalid);
    }
    let l = &request.limits;
    if l.max_checks == 0
        || l.max_checks > limits::HARD_MAX_VERIFY_CHECKS
        || l.max_characters == 0
        || l.max_characters > limits::HARD_MAX_VERIFY_CHARACTERS
        || l.max_output_bytes == 0
        || l.max_output_bytes > limits::HARD_MAX_VERIFY_OUTPUT_BYTES
        || l.max_decompressed_bytes == 0
        || l.max_decompressed_bytes > limits::HARD_MAX_DECOMPRESSED_BYTES
        || l.max_nesting_depth == 0
        || l.max_nesting_depth > limits::HARD_MAX_NESTING_DEPTH
        || l.max_scalar_bytes == 0
        || l.max_scalar_bytes > limits::HARD_MAX_SCALAR_BYTES
        || l.max_output_bytes.min(cli_max_output_bytes) == 0
        || request.checks.len() > l.max_checks as usize
    {
        return Err(ErrorCode::RequestInvalid);
    }
    if request.expected.snapshot_slot > 1
        || !is_decimal_character_id(&request.expected.player_character_id)
        || request.expected.game_date_numeric > 9_007_199_254_740_991
        || request.expected.snapshot_sequence > 9_007_199_254_740_991
        || request
            .expected
            .campaign_id_parts
            .iter()
            .any(|part| *part > i32::MAX as u64)
        || request.expected.campaign_id.is_empty()
        || request.expected.campaign_id.len() > 128
        || request.expected.source_fingerprint.len() != 64
        || !request
            .expected
            .source_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || request.expected.participant_character_ids.len() > limits::HARD_MAX_RELATED_CHARACTERS
    {
        return Err(ErrorCode::RequestInvalid);
    }
    let mut participant_ids = std::collections::BTreeSet::new();
    for participant_id in &request.expected.participant_character_ids {
        if !is_decimal_character_id(participant_id)
            || !participant_ids.insert(participant_id.as_str())
        {
            return Err(ErrorCode::RequestInvalid);
        }
    }

    let mut check_ids = std::collections::BTreeSet::new();
    let mut character_ids = std::collections::BTreeSet::new();
    for check in &request.checks {
        let check_id = check.check_id();
        if check_id.is_empty()
            || check_id.len() > 64
            || !check_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
            || !check_ids.insert(check_id.to_string())
        {
            return Err(ErrorCode::RequestInvalid);
        }
        if !is_decimal_character_id(check.character_id()) {
            return Err(ErrorCode::RequestInvalid);
        }
        character_ids.insert(check.character_id().to_string());
        match check {
            SaveVerificationCheckV2::CharacterHasTrait { trait_id, .. }
                if *trait_id > 1_000_000 =>
            {
                return Err(ErrorCode::RequestInvalid)
            }
            SaveVerificationCheckV2::CharacterSkillAtLeast { value, .. }
            | SaveVerificationCheckV2::CharacterGoldAtLeast { value, .. }
                if *value < 0 || *value > 1_000_000_000 =>
            {
                return Err(ErrorCode::RequestInvalid)
            }
            _ => {}
        }
    }
    if character_ids.len() > limits::HARD_MAX_VERIFY_CHARACTERS as usize
        || character_ids.len() > l.max_characters as usize
    {
        return Err(ErrorCode::RequestInvalid);
    }
    Ok(())
}

fn is_decimal_character_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.bytes().all(|byte| byte.is_ascii_digit())
}

#[allow(clippy::too_many_arguments)] // flat wire envelope constructor; callers must set every security field explicitly
pub fn verification_response(
    started: Instant,
    status: Status,
    source_fingerprint: String,
    source_format: SourceFormat,
    identity: VerificationIdentityV2,
    results: Vec<SaveVerificationResultV2>,
    warnings: Vec<Warning>,
    error: Option<ErrorCode>,
    checked_count: u64,
) -> SaveVerificationResponseV2 {
    SaveVerificationResponseV2 {
        protocol_version: VERIFY_PROTOCOL_VERSION,
        operation: Operation::Verify,
        status,
        manifest: VerificationManifestV2 {
            source_fingerprint,
            source_format,
            parser_version: env!("CARGO_PKG_VERSION").to_string(),
            fact_schema_version: FACT_SCHEMA_VERSION,
        },
        identity,
        results,
        warnings,
        error: error.map(|code| ErrorBody { code }),
        metrics: VerificationMetricsV2 {
            duration_ms: started.elapsed().as_millis() as u64,
            checked_count,
        },
    }
}

pub fn unsupported_verification_response(
    started: Instant,
    checked_count: u64,
) -> SaveVerificationResponseV2 {
    SaveVerificationResponseV2 {
        protocol_version: VERIFY_PROTOCOL_VERSION,
        operation: Operation::Verify,
        status: Status::Unsupported,
        manifest: VerificationManifestV2 {
            source_fingerprint: String::new(),
            source_format: SourceFormat::Unknown,
            parser_version: env!("CARGO_PKG_VERSION").to_string(),
            fact_schema_version: FACT_SCHEMA_VERSION,
        },
        identity: VerificationIdentityV2::default(),
        results: Vec::new(),
        warnings: Vec::new(),
        error: Some(ErrorBody {
            code: ErrorCode::ParserProtocolUnsupported,
        }),
        metrics: VerificationMetricsV2 {
            duration_ms: started.elapsed().as_millis() as u64,
            checked_count,
        },
    }
}

pub fn invalid_verification_response(
    started: Instant,
    checked_count: u64,
    code: ErrorCode,
) -> SaveVerificationResponseV2 {
    let mut response = unsupported_verification_response(started, checked_count);
    response.status = Status::Invalid;
    response.error = Some(ErrorBody { code });
    response
}

#[derive(Debug)]
pub enum RequestReadError {
    /// stdin 超过 64 KiB，已停止读取。
    TooLarge,
    /// IO 失败或 JSON 无法完整消费（含尾部垃圾、unknown 字段、类型不符）。
    Invalid,
}

/// 有界读取 stdin 请求：最多读 64 KiB + 1 字节用于判定超限，超限即停读。
pub fn read_request(stdin: impl Read) -> Result<SaveFactExtractionRequestV1, RequestReadError> {
    let mut limited = stdin.take(limits::HARD_MAX_STDIN_REQUEST_BYTES as u64 + 1);
    let mut buf = Vec::new();
    if limited.read_to_end(&mut buf).is_err() {
        return Err(RequestReadError::Invalid);
    }
    if buf.len() > limits::HARD_MAX_STDIN_REQUEST_BYTES {
        return Err(RequestReadError::TooLarge);
    }
    // serde_json::from_slice 要求完整消费，尾部垃圾报 trailing characters → Invalid。
    serde_json::from_slice(&buf).map_err(|_| RequestReadError::Invalid)
}

/// 语义校验：协议版本、operation 与子命令一致、snapshotSlot ∈ {0,1}、
/// participant 去重+稳定排序+限量、limits 各字段不得超过编译时硬上限
///（App 只能更低，超出即 invalid）。
pub fn validate_request(
    request: SaveFactExtractionRequestV1,
    cli_operation: Operation,
    cli_max_output_bytes: u64,
) -> Result<ValidatedRequest, ErrorCode> {
    if request.protocol_version != u64::from(PROTOCOL_VERSION) {
        return Err(ErrorCode::RequestInvalid);
    }
    if request.operation != cli_operation {
        return Err(ErrorCode::RequestInvalid);
    }
    // Probe is an identity-only envelope operation.  Keep the pre-P1-C
    // request contract for probe while allowing the new category on extract,
    // where war facts are actually materialized.
    if cli_operation == Operation::Probe && request.categories.contains(&Category::War) {
        return Err(ErrorCode::RequestInvalid);
    }
    if request.expected.snapshot_slot > 1 {
        return Err(ErrorCode::RequestInvalid);
    }

    let mut participants = request.expected.participant_character_ids;
    participants.sort();
    participants.dedup();
    if participants.len() > limits::HARD_MAX_RELATED_CHARACTERS {
        return Err(ErrorCode::RequestInvalid);
    }

    let l = &request.limits;
    if l.max_facts > limits::HARD_MAX_FACTS
        || l.max_entities > limits::HARD_MAX_ENTITIES
        || l.max_related_characters > limits::HARD_MAX_RELATED_CHARACTERS as u64
        || l.max_output_bytes > limits::HARD_MAX_STDOUT_BYTES
        || l.max_decompressed_bytes > limits::HARD_MAX_DECOMPRESSED_BYTES
        || l.max_nesting_depth > limits::HARD_MAX_NESTING_DEPTH
        || l.max_scalar_bytes > limits::HARD_MAX_SCALAR_BYTES
    {
        return Err(ErrorCode::RequestInvalid);
    }

    Ok(ValidatedRequest {
        participants,
        categories: request.categories,
        max_output_bytes: cli_max_output_bytes.min(request.limits.max_output_bytes),
        limits: request.limits,
    })
}

// ---------------------------------------------------------------------------
// 响应（计划 5.4 节 SaveFactExtractionResultV1）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ok,
    Partial,
    Unsupported,
    Invalid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceFormat {
    UnifiedText,
    ZipText,
    ZipBinary,
    UnifiedBinary,
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub snapshot_id: String,
    pub source_fingerprint: String,
    pub source_format: SourceFormat,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ck3_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub save_game_version: Option<u64>,
    pub parser_version: String,
    pub fact_schema_version: u32,
}

/// probe/extract 的 identity 块。字段按 5.4 节冻结，Task 3 起填充。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player_character_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_date_numeric: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_date_display: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub campaign_id_parts: Option<[u64; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_sequence: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_slot: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub script_variable_scale: Option<u64>,
}

// ---------------------------------------------------------------------------
// 实体与事实（计划 Task 4 步骤 4/5；字段对齐 5.4 节与设计规格 GameFact 模型）
// ---------------------------------------------------------------------------

/// sidecar 产出 character / title / war 三类实体。war ID 只作内部关联；
/// war 的玩家可见名称只能来自安全 literal candidate。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntityType {
    Character,
    Title,
    War,
    Activity,
    Location,
}

/// display name 候选：literal 只是 candidate（App 仍需 sanitizer/name
/// authority），localization_key 不得当 display string 直接渲染。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DisplayNameKind {
    Literal,
    LocalizationKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DisplayNameCandidate {
    pub kind: DisplayNameKind,
    pub value: String,
}

/// CanonicalEntityV1（Task 4 步骤 4）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalEntityV1 {
    #[serde(rename = "type")]
    pub entity_type: EntityType,
    /// CK3 十进制 ID 字符串。
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name_candidate: Option<DisplayNameCandidate>,
}

/// 事实的稳定 subject/object 引用：只含 type/id，不含 display name
///（改名不改变事实 ID）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntityRefV1 {
    #[serde(rename = "type")]
    pub entity_type: EntityType,
    pub id: String,
}

/// 首版 predicate registry（计划 5.5 节）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Predicate {
    #[serde(rename = "character.spouse")]
    CharacterSpouse,
    #[serde(rename = "character.parent")]
    CharacterParent,
    #[serde(rename = "character.child")]
    CharacterChild,
    #[serde(rename = "character.liege")]
    CharacterLiege,
    #[serde(rename = "character.primary_title")]
    CharacterPrimaryTitle,
    #[serde(rename = "character.direct_vassal_of")]
    CharacterDirectVassalOf,
    #[serde(rename = "character.realm_capital")]
    CharacterRealmCapital,
    #[serde(rename = "title.holder")]
    TitleHolder,
    #[serde(rename = "character.at_war")]
    CharacterAtWar,
    #[serde(rename = "war.attacker")]
    WarAttacker,
    #[serde(rename = "war.defender")]
    WarDefender,
    #[serde(rename = "war.casus_belli")]
    WarCasusBelli,
    #[serde(rename = "character.war_score_band")]
    CharacterWarScoreBand,
    #[serde(rename = "character.current_activity")]
    CharacterCurrentActivity,
    #[serde(rename = "character.traveling")]
    CharacterTraveling,
    #[serde(rename = "character.public_location")]
    CharacterPublicLocation,
    #[serde(rename = "activity.location")]
    ActivityLocation,
    #[serde(rename = "character.council_position")]
    CharacterCouncilPosition,
    #[serde(rename = "character.court_position")]
    CharacterCourtPosition,
    #[serde(rename = "character.court_owner")]
    CharacterCourtOwner,
}

/// sidecar 只产出 save_snapshot 来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactSource {
    SaveSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    Exact,
    Mapped,
    // 首版没有 heuristic 输出；保留 variant 供后续 predicate 使用。
    #[allow(dead_code)]
    Heuristic,
}

/// 默认 omniscient_internal；公开关系按 registry 标 public。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactVisibility {
    Public,
    OmniscientInternal,
}

/// 首版只输出 personal / political 两档。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactSensitivity {
    Personal,
    Political,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AsOfGameDate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub numeric: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
}

/// provenance 中 sidecar 可知的部分（timelineNodeId/checkpointEpoch 属
/// App 侧上下文，sidecar 不输出）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactProvenance {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub campaign_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_sequence: Option<u64>,
}

/// ExtractedGameFactV1（Task 4 步骤 5）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedGameFactV1 {
    /// 稳定 fact ID：subject+predicate+object 派生 hash，不含 display name。
    pub id: String,
    pub category: Category,
    pub subject: EntityRefV1,
    pub predicate: Predicate,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object: Option<EntityRefV1>,
    /// War CB and participant-relative score bands are bounded strings. Other
    /// predicates leave this absent; no raw save value crosses the wire.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub as_of_game_date: AsOfGameDate,
    pub source: FactSource,
    /// canonical source path 枚举值（character_mother/father/child/spouse/liege/
    /// primary_title、title_holder、character_at_war/war_attacker/
    /// war_defender/war_casus_belli/character_war_score_band），raw save
    /// 路径永不过线；与 App
    /// `saveFactTypes.ts` 的 `SAVE_FACT_SOURCE_PATHS` 一一对应。
    pub source_path: String,
    pub confidence: Confidence,
    pub visibility: FactVisibility,
    pub sensitivity: FactSensitivity,
    pub provenance: FactProvenance,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Warning {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub code: ErrorCode,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub input_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decompressed_bytes: Option<u64>,
    pub duration_ms: u64,
    pub emitted_facts: u64,
    pub emitted_entities: u64,
    /// probe 实际扫描的 gamestate（解压后）字节数；Task 3 新增的可选字段，
    /// 未执行扫描的路径不输出。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scanned_bytes: Option<u64>,
}

/// 响应 DTO。Task 4 起 entities/facts 为具体类型，排序在序列化前完成。
/// 结构体字段顺序固定，serde_json 输出对同一逻辑响应是确定性的。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFactExtractionResultV1 {
    pub protocol_version: u32,
    pub operation: Operation,
    pub status: Status,
    pub manifest: Manifest,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<Identity>,
    /// root `variables.list` 中 `votc_join_candidates` 全局列表（保序，十进制
    /// CK3 局内 ID 字符串）。App 侧 join 协调器传输数据，**不进入 facts/
    /// predicate 流**；列表缺失/无效 = 字段缺省。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub join_candidates: Option<Vec<String>>,
    pub entities: Vec<CanonicalEntityV1>,
    pub facts: Vec<ExtractedGameFactV1>,
    pub warnings: Vec<Warning>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
    pub metrics: Metrics,
}

fn base_response(
    operation: Operation,
    status: Status,
    started: Instant,
    input_bytes: u64,
) -> SaveFactExtractionResultV1 {
    SaveFactExtractionResultV1 {
        protocol_version: PROTOCOL_VERSION,
        operation,
        status,
        manifest: Manifest {
            snapshot_id: MANIFEST_PLACEHOLDER.to_string(),
            source_fingerprint: MANIFEST_PLACEHOLDER.to_string(),
            source_format: SourceFormat::Unknown,
            ck3_version: None,
            save_game_version: None,
            parser_version: env!("CARGO_PKG_VERSION").to_string(),
            fact_schema_version: FACT_SCHEMA_VERSION,
        },
        identity: None,
        join_candidates: None,
        entities: Vec::new(),
        facts: Vec::new(),
        warnings: Vec::new(),
        error: None,
        metrics: Metrics {
            input_bytes,
            decompressed_bytes: None,
            duration_ms: started.elapsed().as_millis() as u64,
            emitted_facts: 0,
            emitted_entities: 0,
            scanned_bytes: None,
        },
    }
}

/// 完整响应构造参数（envelope + identity + extract 路径使用）。
pub struct ResponseParts {
    pub status: Status,
    pub source_format: SourceFormat,
    pub snapshot_id: String,
    pub source_fingerprint: String,
    pub ck3_version: Option<String>,
    pub identity: Option<Identity>,
    pub join_candidates: Option<Vec<String>>,
    pub entities: Vec<CanonicalEntityV1>,
    pub facts: Vec<ExtractedGameFactV1>,
    pub warnings: Vec<Warning>,
    pub error: Option<ErrorCode>,
    pub input_bytes: u64,
    pub decompressed_bytes: Option<u64>,
    pub scanned_bytes: Option<u64>,
}

/// 用真实 manifest（sourceFormat / snapshotId / sourceFingerprint /
/// ck3Version）构造一份响应。entities/facts 必须在传入前完成稳定排序。
pub fn response(
    operation: Operation,
    started: Instant,
    parts: ResponseParts,
) -> SaveFactExtractionResultV1 {
    SaveFactExtractionResultV1 {
        protocol_version: PROTOCOL_VERSION,
        operation,
        status: parts.status,
        manifest: Manifest {
            snapshot_id: parts.snapshot_id,
            source_fingerprint: parts.source_fingerprint,
            source_format: parts.source_format,
            ck3_version: parts.ck3_version,
            save_game_version: None, // 来源待 Task 0 确认，先不输出
            parser_version: env!("CARGO_PKG_VERSION").to_string(),
            fact_schema_version: FACT_SCHEMA_VERSION,
        },
        identity: parts.identity,
        join_candidates: parts.join_candidates,
        warnings: parts.warnings,
        error: parts.error.map(|code| ErrorBody { code }),
        metrics: Metrics {
            input_bytes: parts.input_bytes,
            decompressed_bytes: parts.decompressed_bytes,
            duration_ms: started.elapsed().as_millis() as u64,
            emitted_facts: parts.facts.len() as u64,
            emitted_entities: parts.entities.len() as u64,
            scanned_bytes: parts.scanned_bytes,
        },
        entities: parts.entities,
        facts: parts.facts,
    }
}

/// unsupported 响应占位（Task 2 遗留，现仅 output.rs 单测使用；
/// 生产路径一律走 `response()` 构造带真实 manifest 的响应）。
#[cfg(test)]
pub fn unsupported_response(
    operation: Operation,
    started: Instant,
    input_bytes: u64,
) -> SaveFactExtractionResultV1 {
    let mut response = base_response(operation, Status::Unsupported, started, input_bytes);
    response.error = Some(ErrorBody {
        code: ErrorCode::SaveEnvelopeUnknown,
    });
    response
}

/// 请求/路径类失败的 invalid 响应。
pub fn error_response(
    operation: Operation,
    code: ErrorCode,
    started: Instant,
    input_bytes: u64,
) -> SaveFactExtractionResultV1 {
    let mut response = base_response(operation, Status::Invalid, started, input_bytes);
    response.error = Some(ErrorBody { code });
    response
}

/// SAVE_LIMIT_EXCEEDED 小型降级响应。刻意最小化（空 manifest 占位串、
/// 零 metrics），保证它显著小于正常响应，从而在原响应超过
/// maxOutputBytes 时仍能落入预算。正常 manifest 占位由 Task 3 替换为
/// 真实的 snapshotId/sourceFingerprint（哈希级长度），落差会更大。
pub fn limit_exceeded_response(operation: Operation) -> SaveFactExtractionResultV1 {
    let mut response = base_response(operation, Status::Invalid, Instant::now(), 0);
    response.manifest.snapshot_id = String::new();
    response.manifest.source_fingerprint = String::new();
    response.error = Some(ErrorBody {
        code: ErrorCode::SaveLimitExceeded,
    });
    response
}

/// panic 边界的 PARSER_CRASHED 小型安全响应：不含任何解析上下文。
pub fn crash_response(operation: Operation) -> SaveFactExtractionResultV1 {
    let mut response = base_response(operation, Status::Invalid, Instant::now(), 0);
    response.manifest.snapshot_id = String::new();
    response.manifest.source_fingerprint = String::new();
    response.error = Some(ErrorBody {
        code: ErrorCode::ParserCrashed,
    });
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request_json() -> serde_json::Value {
        serde_json::json!({
            "protocolVersion": 2,
            "operation": "probe",
            "expected": {
                "playerCharacterId": "1001",
                "participantCharacterIds": ["1003", "1002", "1003"],
                "gameDateNumeric": 8670101,
                "campaignId": "abc",
                "campaignIdParts": [1, 2, 3, 4],
                "snapshotSequence": 7,
                "snapshotSlot": 0
            },
            "categories": ["identity", "family"],
            "limits": {
                "maxFacts": 100,
                "maxEntities": 50,
                "maxRelatedCharacters": 20,
                "maxOutputBytes": 1048576,
                "maxDecompressedBytes": 1048576,
                "maxNestingDepth": 64,
                "maxScalarBytes": 1024
            }
        })
    }

    #[test]
    fn v2_request_shape_accepts_camel_case_and_limits() {
        let value = serde_json::json!({
            "protocolVersion": 2,
            "operation": "verify",
            "expected": {
                "playerCharacterId": "1001",
                "participantCharacterIds": ["1001", "1002"],
                "gameDateNumeric": 316470,
                "campaignId": "1-2-3-4",
                "campaignIdParts": [1, 2, 3, 4],
                "snapshotSequence": 17,
                "snapshotSlot": 0,
                "sourceFingerprint": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
            },
            "checks": [
                { "checkId": "c1", "kind": "character_life_state", "characterId": "1002" },
                { "checkId": "c2", "kind": "character_has_trait", "characterId": "1002", "traitId": 17 },
                { "checkId": "c3", "kind": "character_skill_at_least", "characterId": "1002", "skill": "martial", "value": 12 }
            ],
            "limits": {
                "maxChecks": 64,
                "maxCharacters": 32,
                "maxOutputBytes": 262144,
                "maxDecompressedBytes": 536870912,
                "maxNestingDepth": 128,
                "maxScalarBytes": 65536
            }
        });
        let parsed: Result<SaveVerificationRequestV2, _> = serde_json::from_str(&value.to_string());
        assert!(parsed.is_ok(), "v2 parse error: {:?}", parsed.err());
        assert!(validate_verification_request(&parsed.unwrap(), 262144).is_ok());
    }

    #[test]
    fn war_wire_allowlist_roundtrips_and_rejects_unknown_predicates() {
        for (wire, expected) in [
            ("character.at_war", Predicate::CharacterAtWar),
            ("war.attacker", Predicate::WarAttacker),
            ("war.defender", Predicate::WarDefender),
            ("war.casus_belli", Predicate::WarCasusBelli),
            ("character.war_score_band", Predicate::CharacterWarScoreBand),
        ] {
            assert_eq!(
                serde_json::from_str::<Predicate>(&format!("\"{wire}\""))
                    .expect("war predicate must deserialize"),
                expected
            );
            assert_eq!(
                serde_json::to_string(&expected).unwrap(),
                format!("\"{wire}\"")
            );
        }
        assert!(serde_json::from_str::<Predicate>("\"war.score\"").is_err());
        assert_eq!(
            serde_json::from_str::<Category>("\"war\"").unwrap(),
            Category::War
        );
        assert_eq!(serde_json::to_string(&Category::War).unwrap(), "\"war\"");

        let fact: ExtractedGameFactV1 = serde_json::from_value(serde_json::json!({
            "id": "fact-war",
            "category": "war",
            "subject": { "type": "war", "id": "7001" },
            "predicate": "war.casus_belli",
            "value": "claim",
            "asOfGameDate": { "numeric": 316470 },
            "source": "save_snapshot",
            "sourcePath": "war_casus_belli",
            "confidence": "mapped",
            "visibility": "public",
            "sensitivity": "political",
            "provenance": {}
        }))
        .unwrap();
        assert_eq!(fact.subject.entity_type, EntityType::War);
        assert_eq!(fact.value.as_deref(), Some("claim"));
        assert_eq!(
            serde_json::to_value(fact).unwrap()["subject"]["type"],
            "war"
        );
    }

    #[test]
    fn v2_result_is_flat_and_keeps_known_false_separate_from_unknown() {
        let life = serde_json::to_value(SaveVerificationResultV2::CharacterLifeState {
            check_id: "c1".into(),
            outcome: VerificationLifeOutcomeV2::Known {
                life_state: VerificationLifeStateV2::Dead,
            },
        })
        .unwrap();
        assert_eq!(life["kind"], "character_life_state");
        assert_eq!(life["status"], "known");
        assert_eq!(life["lifeState"], "dead");
        assert!(life.get("value").is_none());

        let known_false = serde_json::to_value(SaveVerificationResultV2::CharacterHasTrait {
            check_id: "c2".into(),
            outcome: VerificationBooleanOutcomeV2::Known { value: false },
        })
        .unwrap();
        assert_eq!(known_false["status"], "known");
        assert_eq!(known_false["value"], false);
        assert!(known_false.get("reasonCode").is_none());

        let unknown = serde_json::to_value(SaveVerificationResultV2::CharacterHasTrait {
            check_id: "c3".into(),
            outcome: VerificationBooleanOutcomeV2::Unknown {
                reason_code: VerificationUnknownReasonV2::CharacterNotFound,
            },
        })
        .unwrap();
        assert_eq!(unknown["status"], "unknown");
        assert_eq!(unknown["reasonCode"], "CHARACTER_NOT_FOUND");
        assert!(unknown.get("value").is_none());
    }

    fn parse_request(value: serde_json::Value) -> SaveFactExtractionRequestV1 {
        read_request(std::io::Cursor::new(value.to_string().into_bytes())).unwrap()
    }

    #[test]
    fn read_request_accepts_valid_json() {
        parse_request(request_json());
    }

    #[test]
    fn read_request_rejects_oversized_stdin() {
        let big = vec![b' '; limits::HARD_MAX_STDIN_REQUEST_BYTES + 1];
        assert!(matches!(
            read_request(std::io::Cursor::new(big)),
            Err(RequestReadError::TooLarge)
        ));
    }

    #[test]
    fn read_request_accepts_exactly_at_limit() {
        // 构造总长恰好 64 KiB 的请求。
        let mut raw = request_json().to_string().into_bytes();
        // 在 JSON 尾部加空格不属于合法输入（尾部垃圾），把 padding 放进字符串字段。
        let pad_len = limits::HARD_MAX_STDIN_REQUEST_BYTES - raw.len();
        let mut value = request_json();
        value["expected"]["playerCharacterId"] =
            serde_json::Value::String("x".repeat(pad_len + "1001".len()));
        raw = value.to_string().into_bytes();
        assert_eq!(raw.len(), limits::HARD_MAX_STDIN_REQUEST_BYTES);
        assert!(read_request(std::io::Cursor::new(raw)).is_ok());
    }

    #[test]
    fn read_request_rejects_trailing_garbage() {
        let mut raw = request_json().to_string().into_bytes();
        raw.extend_from_slice(b" x");
        assert!(matches!(
            read_request(std::io::Cursor::new(raw)),
            Err(RequestReadError::Invalid)
        ));
    }

    #[test]
    fn read_request_rejects_unknown_field() {
        let mut value = request_json();
        value["recentUserText"] = serde_json::Value::String("hello".into());
        assert!(matches!(
            read_request(std::io::Cursor::new(value.to_string().into_bytes())),
            Err(RequestReadError::Invalid)
        ));
    }

    #[test]
    fn validate_dedups_and_sorts_participants() {
        let validated =
            validate_request(parse_request(request_json()), Operation::Probe, 2_097_152).unwrap();
        assert_eq!(validated.participants, vec!["1002", "1003"]);
    }

    #[test]
    fn validate_effective_output_cap_is_min_of_cli_and_request() {
        let validated =
            validate_request(parse_request(request_json()), Operation::Probe, 2_097_152).unwrap();
        assert_eq!(validated.max_output_bytes, 1_048_576);
    }

    #[test]
    fn validate_rejects_wrong_protocol_version() {
        let mut value = request_json();
        value["protocolVersion"] = serde_json::json!(3);
        assert!(matches!(
            validate_request(parse_request(value), Operation::Probe, 2_097_152),
            Err(ErrorCode::RequestInvalid)
        ));
    }

    #[test]
    fn validate_rejects_operation_mismatch() {
        assert!(matches!(
            validate_request(parse_request(request_json()), Operation::Extract, 2_097_152),
            Err(ErrorCode::RequestInvalid)
        ));
    }

    #[test]
    fn validate_rejects_snapshot_slot_above_one() {
        let mut value = request_json();
        value["expected"]["snapshotSlot"] = serde_json::json!(2);
        assert!(matches!(
            validate_request(parse_request(value), Operation::Probe, 2_097_152),
            Err(ErrorCode::RequestInvalid)
        ));
    }

    #[test]
    fn validate_rejects_limits_above_hard_caps() {
        for (field, over) in [
            ("maxFacts", limits::HARD_MAX_FACTS + 1),
            ("maxEntities", limits::HARD_MAX_ENTITIES + 1),
            (
                "maxRelatedCharacters",
                limits::HARD_MAX_RELATED_CHARACTERS as u64 + 1,
            ),
            ("maxOutputBytes", limits::HARD_MAX_STDOUT_BYTES + 1),
            (
                "maxDecompressedBytes",
                limits::HARD_MAX_DECOMPRESSED_BYTES + 1,
            ),
            ("maxNestingDepth", limits::HARD_MAX_NESTING_DEPTH + 1),
            ("maxScalarBytes", limits::HARD_MAX_SCALAR_BYTES + 1),
        ] {
            let mut value = request_json();
            value["limits"][field] = serde_json::json!(over);
            assert!(
                matches!(
                    validate_request(parse_request(value), Operation::Probe, 2_097_152),
                    Err(ErrorCode::RequestInvalid)
                ),
                "field {field} above hard cap must be rejected"
            );
        }
    }

    #[test]
    fn validate_rejects_too_many_participants() {
        let mut value = request_json();
        let ids: Vec<String> = (0..limits::HARD_MAX_RELATED_CHARACTERS + 1)
            .map(|i| format!("p{i}"))
            .collect();
        value["expected"]["participantCharacterIds"] = serde_json::json!(ids);
        assert!(matches!(
            validate_request(parse_request(value), Operation::Probe, 2_097_152),
            Err(ErrorCode::RequestInvalid)
        ));
    }

    #[test]
    fn limit_exceeded_response_is_smaller_than_normal_response() {
        // output::emit 的降级依赖这个大小关系：小型响应必须能落入
        // 正常响应放不下的预算。
        let started = Instant::now();
        let normal =
            serde_json::to_vec(&unsupported_response(Operation::Probe, started, 1234)).unwrap();
        let small = serde_json::to_vec(&limit_exceeded_response(Operation::Probe)).unwrap();
        assert!(small.len() + 16 < normal.len());
    }
}
