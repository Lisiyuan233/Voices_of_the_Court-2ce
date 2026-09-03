//! Protocol-v2 typed verification orchestration.

mod character;

use std::path::Path;
use std::time::Instant;

use crate::envelope::{self, EnvelopeError};
use crate::error::ErrorCode;
use crate::identity::{self, IdentityError, ScanLimits};
use crate::protocol::{
    self, SaveVerificationRequestV2, SaveVerificationResponseV2, Status, VerificationIdentityV2,
    VerificationUnknownReasonV2,
};

pub(crate) fn run(
    input: &Path,
    allowed_root: &Path,
    request: &SaveVerificationRequestV2,
    started: Instant,
) -> SaveVerificationResponseV2 {
    let checked_count = request.checks.len() as u64;
    let empty_identity = VerificationIdentityV2::default();
    let bound = match crate::snapshot::BoundSnapshot::capture(
        input,
        allowed_root,
        request.limits.max_decompressed_bytes,
    ) {
        Ok(bound) => bound,
        Err(code) => {
            return protocol::verification_response(
                started,
                Status::Invalid,
                String::new(),
                protocol::SourceFormat::Unknown,
                empty_identity,
                Vec::new(),
                Vec::new(),
                Some(code),
                checked_count,
            )
        }
    };

    let opened = match envelope::open(bound.raw_path()) {
        Ok(opened) => opened,
        Err(error) => {
            let (status, code) = map_envelope_error(error);
            return protocol::verification_response(
                started,
                status,
                String::new(),
                protocol::SourceFormat::Unknown,
                empty_identity,
                Vec::new(),
                Vec::new(),
                Some(code),
                checked_count,
            );
        }
    };
    let source_format = opened.format;
    let header_line = opened.header_line.clone();
    let source_fingerprint =
        match crate::fingerprint::source_fingerprint(bound.raw_path(), &opened.header_line) {
            Ok(fingerprint) => fingerprint,
            Err(_) => {
                return protocol::verification_response(
                    started,
                    Status::Invalid,
                    String::new(),
                    source_format,
                    empty_identity,
                    Vec::new(),
                    Vec::new(),
                    Some(ErrorCode::SaveReadDenied),
                    checked_count,
                )
            }
        };
    if !source_fingerprint.eq_ignore_ascii_case(&request.expected.source_fingerprint) {
        return protocol::verification_response(
            started,
            Status::Invalid,
            source_fingerprint,
            source_format,
            empty_identity,
            Vec::new(),
            Vec::new(),
            Some(ErrorCode::SaveIdentityMismatch),
            checked_count,
        );
    }

    // binary：版本门禁 → melt 成明文后走既有文本验证路径；未解析 token
    // 计数回传为 warning。text 路径行为不变。
    let mut melt_stats: Option<crate::melt::SharedMeltStats> = None;
    if opened.is_binary() {
        let gate_reader = match opened.gamestate_binary() {
            Ok(reader) => reader,
            Err(error) => {
                let (status, code) = map_envelope_error(error);
                return protocol::verification_response(
                    started,
                    status,
                    source_fingerprint,
                    source_format,
                    empty_identity,
                    Vec::new(),
                    Vec::new(),
                    Some(code),
                    checked_count,
                );
            }
        };
        let gate_result = crate::melt::check_version(gate_reader, crate::melt::VERSION_GATE_MAX_BYTES);
        let gate_failure = match gate_result {
            Ok(()) => None,
            Err(crate::melt::VersionGateError::Mismatch) => {
                Some((Status::Unsupported, ErrorCode::SaveTokenVersionMismatch))
            }
            Err(crate::melt::VersionGateError::Truncated) => {
                Some((Status::Invalid, ErrorCode::SaveTruncated))
            }
            Err(crate::melt::VersionGateError::ParseFailed) => {
                Some((Status::Invalid, ErrorCode::SaveParseFailed))
            }
        };
        if let Some((status, code)) = gate_failure {
            return protocol::verification_response(
                started,
                status,
                source_fingerprint,
                source_format,
                empty_identity,
                Vec::new(),
                Vec::new(),
                Some(code),
                checked_count,
            );
        }
        melt_stats = Some(crate::melt::new_stats());
    }

    let gamestate_reader: Box<dyn std::io::Read + '_> = if let Some(stats) = &melt_stats {
        match opened.gamestate_binary_verified() {
            Ok(reader) => Box::new(crate::melt::MeltReader::new(reader, stats.clone())),
            Err(error) => {
                let (status, code) = map_envelope_error(error);
                return protocol::verification_response(
                    started,
                    status,
                    source_fingerprint,
                    source_format,
                    empty_identity,
                    Vec::new(),
                    Vec::new(),
                    Some(code),
                    checked_count,
                );
            }
        }
    } else {
        match opened.gamestate_verified() {
            Ok(reader) => reader,
            Err(error) => {
                let (status, code) = map_envelope_error(error);
                return protocol::verification_response(
                    started,
                    status,
                    source_fingerprint,
                    source_format,
                    empty_identity,
                    Vec::new(),
                    Vec::new(),
                    Some(code),
                    checked_count,
                );
            }
        }
    };
    let gamestate = match bound
        .materialize_gamestate(gamestate_reader, request.limits.max_decompressed_bytes)
    {
        Ok(artifact) => artifact,
        Err(code) => {
            return protocol::verification_response(
                started,
                Status::Invalid,
                source_fingerprint,
                source_format,
                empty_identity,
                Vec::new(),
                Vec::new(),
                Some(code),
                checked_count,
            )
        }
    };
    drop(opened);

    let scan_limits = ScanLimits {
        max_bytes: request.limits.max_decompressed_bytes,
        max_nesting: request.limits.max_nesting_depth as u32,
        max_scalar: request.limits.max_scalar_bytes as usize,
    };
    let identity_root = match gamestate.open() {
        Ok(file) => file,
        Err(_) => {
            return protocol::verification_response(
                started,
                Status::Invalid,
                source_fingerprint,
                source_format,
                empty_identity,
                Vec::new(),
                Vec::new(),
                Some(ErrorCode::SaveReadDenied),
                checked_count,
            )
        }
    };
    let identity_player = match gamestate.open() {
        Ok(file) => file,
        Err(_) => {
            return protocol::verification_response(
                started,
                Status::Invalid,
                source_fingerprint,
                source_format,
                empty_identity,
                Vec::new(),
                Vec::new(),
                Some(ErrorCode::SaveReadDenied),
                checked_count,
            )
        }
    };
    let identity = match identity::extract(identity_root, identity_player, scan_limits) {
        Ok(mut identity) => {
            if let Some(stats) = &melt_stats {
                if stats.unresolved_tokens.get() > 0 {
                    identity.warnings.push(protocol::Warning {
                        code: crate::melt::WARN_TOKENS_PARTIALLY_UNRESOLVED.to_string(),
                        category: None,
                    });
                }
            }
            identity
        }
        Err(error) => {
            return protocol::verification_response(
                started,
                Status::Invalid,
                source_fingerprint,
                source_format,
                empty_identity,
                Vec::new(),
                Vec::new(),
                Some(map_identity_error(error)),
                checked_count,
            )
        }
    };
    let response_identity = VerificationIdentityV2 {
        player_character_id: identity.identity.player_character_id.clone(),
        game_date_numeric: identity.identity.game_date_numeric,
        campaign_id_parts: identity.identity.campaign_id_parts,
        snapshot_sequence: identity.identity.snapshot_sequence,
        snapshot_slot: identity.identity.snapshot_slot,
    };
    if let Some(code) = identity_mismatch(request, &response_identity) {
        return protocol::verification_response(
            started,
            Status::Invalid,
            source_fingerprint,
            source_format,
            response_identity,
            Vec::new(),
            identity.warnings,
            Some(code),
            checked_count,
        );
    }

    let unsupported_version = identity.warnings.iter().any(|warning| {
        warning.code == identity::WARN_VERSION_MISSING
            || warning.code == identity::WARN_VERSION_UNRECOGNIZED
    });
    let verification = if unsupported_version {
        None
    } else {
        let verification_reader = match gamestate.open() {
            Ok(file) => file,
            Err(_) => {
                return protocol::verification_response(
                    started,
                    Status::Invalid,
                    source_fingerprint,
                    source_format,
                    response_identity,
                    Vec::new(),
                    identity.warnings,
                    Some(ErrorCode::SaveReadDenied),
                    checked_count,
                )
            }
        };
        Some(character::scan(
            verification_reader,
            scan_limits,
            &request.checks,
        ))
    };
    let (status, results, error) = match verification {
        None => (
            Status::Partial,
            character::unknown_results(
                &request.checks,
                VerificationUnknownReasonV2::SaveVersionUnsupported,
            ),
            None,
        ),
        Some(Ok(verification)) => {
            let results = verification.results(&request.checks);
            let partial = results.iter().any(|result| result.is_unknown());
            (
                if partial { Status::Partial } else { Status::Ok },
                results,
                None,
            )
        }
        Some(Err(error)) => {
            let (reason, code) = match error {
                IdentityError::LimitExceeded => (
                    VerificationUnknownReasonV2::LimitExceeded,
                    ErrorCode::SaveLimitExceeded,
                ),
                IdentityError::Truncated | IdentityError::ParseFailed | IdentityError::Io => (
                    VerificationUnknownReasonV2::PartialParse,
                    map_identity_error(error),
                ),
            };
            (
                Status::Partial,
                character::unknown_results(&request.checks, reason),
                Some(code),
            )
        }
    };

    if let Err(code) = bound.revalidate_source(&header_line, &source_fingerprint) {
        return protocol::verification_response(
            started,
            Status::Invalid,
            source_fingerprint,
            source_format,
            response_identity,
            Vec::new(),
            identity.warnings,
            Some(code),
            checked_count,
        );
    }

    protocol::verification_response(
        started,
        status,
        source_fingerprint,
        source_format,
        response_identity,
        results,
        identity.warnings,
        error,
        checked_count,
    )
}

fn identity_mismatch(
    request: &SaveVerificationRequestV2,
    actual: &VerificationIdentityV2,
) -> Option<ErrorCode> {
    if actual.player_character_id.as_deref() != Some(request.expected.player_character_id.as_str())
    {
        return Some(ErrorCode::SavePlayerMismatch);
    }
    if actual.campaign_id_parts != Some(request.expected.campaign_id_parts) {
        return Some(ErrorCode::SaveCampaignMismatch);
    }
    if actual.snapshot_sequence != Some(request.expected.snapshot_sequence) {
        return Some(ErrorCode::SaveSequenceMismatch);
    }
    if actual.snapshot_slot != Some(request.expected.snapshot_slot) {
        return Some(ErrorCode::SaveSlotMismatch);
    }
    if actual.game_date_numeric != Some(request.expected.game_date_numeric) {
        return Some(ErrorCode::SaveDateMismatch);
    }
    None
}

fn map_envelope_error(error: EnvelopeError) -> (Status, ErrorCode) {
    match error {
        EnvelopeError::Unknown => (Status::Unsupported, ErrorCode::SaveEnvelopeUnknown),
        EnvelopeError::Truncated => (Status::Invalid, ErrorCode::SaveTruncated),
        EnvelopeError::EntryMissing => (Status::Invalid, ErrorCode::SaveEntryMissing),
        EnvelopeError::DuplicateGamestate => (Status::Invalid, ErrorCode::SaveParseFailed),
        EnvelopeError::DeclaredTooLarge => (Status::Invalid, ErrorCode::SaveLimitExceeded),
        EnvelopeError::UnsupportedCompression => {
            (Status::Unsupported, ErrorCode::SaveVersionUnsupported)
        }
    }
}

fn map_identity_error(error: IdentityError) -> ErrorCode {
    match error {
        IdentityError::Truncated => ErrorCode::SaveTruncated,
        IdentityError::LimitExceeded => ErrorCode::SaveLimitExceeded,
        IdentityError::ParseFailed | IdentityError::Io => ErrorCode::SaveParseFailed,
    }
}
