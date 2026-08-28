//! Protocol v3 wire DTOs for the persistent session subcommand.
//!
//! Strictness rules (plan §5.1):
//! - every frame is one JSON object on one line, UTF-8, no BOM;
//! - unknown fields are rejected (`deny_unknown_fields`);
//! - `requestId`/`sessionId` use a fixed safe charset and length;
//! - the first frame must be `session_open`; `session_close` is last.

// Frozen wire DTOs: some fields are validated here but consumed by later
// tasks (index/search/profile). Silence dead-code until those land.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use crate::error::ErrorCode;

pub const SESSION_PROTOCOL_VERSION: u32 = 3;

/// Safe charset for requestId/sessionId: 1..=64 chars of
/// `[A-Za-z0-9._:-]`. App sends randomUUIDs; this stays stricter.
pub fn is_valid_frame_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionOperation {
    SessionOpen,
    CharacterSearch,
    CharacterProfile,
    SessionClose,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationKind {
    Spouse,
    Parent,
    Child,
    Liege,
    DirectVassal,
    CourtMember,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileSection {
    Identity,
    PublicFamily,
    Realm,
    Court,
    Location,
}

pub const ALL_PROFILE_SECTIONS: [ProfileSection; 5] = [
    ProfileSection::Identity,
    ProfileSection::PublicFamily,
    ProfileSection::Realm,
    ProfileSection::Court,
    ProfileSection::Location,
];

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/// Exact-snapshot identity the App captured during preparation. Mirrors the
/// verify-v2 `expected` block (plan §5.2) including `sourceFingerprint`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionExpectedIdentity {
    pub player_character_id: String,
    pub participant_character_ids: Vec<String>,
    pub game_date_numeric: u64,
    pub campaign_id: String,
    pub campaign_id_parts: [u64; 4],
    pub snapshot_sequence: u64,
    pub snapshot_slot: u64,
    pub source_fingerprint: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionLimits {
    pub max_decompressed_bytes: u64,
    pub max_nesting_depth: u64,
    pub max_scalar_bytes: u64,
    pub max_characters: u64,
    pub max_titles: u64,
    pub max_relations_per_character: u64,
    pub max_idle_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionOpenRequest {
    pub protocol_version: u32,
    pub request_id: String,
    pub session_id: String,
    pub operation: SessionOperation,
    pub expected: SessionExpectedIdentity,
    pub limits: SessionLimits,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelationSelector {
    pub kind: RelationKind,
    pub anchor_character_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchSelectors {
    #[serde(default)]
    pub candidate_character_ids: Vec<String>,
    #[serde(default)]
    pub primary_title_keys: Vec<String>,
    #[serde(default)]
    pub literal_name_query: Option<String>,
    #[serde(default)]
    pub relation: Option<RelationSelector>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSearchRequest {
    pub protocol_version: u32,
    pub request_id: String,
    pub session_id: String,
    pub operation: SessionOperation,
    pub selectors: SearchSelectors,
    pub limit: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionProfileRequest {
    pub protocol_version: u32,
    pub request_id: String,
    pub session_id: String,
    pub operation: SessionOperation,
    pub character_id: String,
    pub sections: Vec<ProfileSection>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCloseRequest {
    pub protocol_version: u32,
    pub request_id: String,
    pub session_id: String,
    pub operation: SessionOperation,
}

// ---------------------------------------------------------------------------
// Responses / error frames
// ---------------------------------------------------------------------------

/// Uniform error shape. Fatal errors are followed by process exit; recoverable
/// ones (e.g. SESSION_NOT_READY) keep the session alive.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionErrorFrame {
    pub protocol_version: u32,
    pub request_id: Option<String>,
    pub session_id: Option<String>,
    pub operation: Option<SessionOperation>,
    pub status: &'static str,
    pub error_code: ErrorCode,
    pub message: String,
}

impl SessionErrorFrame {
    pub fn fatal(
        request_id: Option<&str>,
        session_id: Option<&str>,
        operation: Option<SessionOperation>,
        error_code: ErrorCode,
        message: impl Into<String>,
    ) -> Self {
        Self {
            protocol_version: SESSION_PROTOCOL_VERSION,
            request_id: request_id.map(str::to_owned),
            session_id: session_id.map(str::to_owned),
            operation,
            status: "error",
            error_code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexSummary {
    pub status: &'static str,
    pub living_character_count: u64,
    pub title_count: u64,
    pub warning_codes: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpenResponse {
    pub protocol_version: u32,
    pub request_id: String,
    pub session_id: String,
    pub operation: SessionOperation,
    pub status: &'static str,
    pub identity: SessionIdentityEcho,
    pub manifest: SessionManifest,
    pub index: SessionIndexSummary,
    pub metrics: SessionDurationMetrics,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdentityEcho {
    pub player_character_id: String,
    pub game_date_numeric: u64,
    pub campaign_id_parts: [u64; 4],
    pub snapshot_sequence: u64,
    pub snapshot_slot: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionManifest {
    pub source_fingerprint: String,
    pub source_format: String,
    pub parser_version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDurationMetrics {
    pub duration_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCloseResponse {
    pub protocol_version: u32,
    pub request_id: String,
    pub session_id: String,
    pub operation: SessionOperation,
    pub status: &'static str,
    pub metrics: SessionDurationMetrics,
}

/// Semantic validation shared by every parsed frame. Returns a fatal error
/// code when envelope fields violate the frozen contract.
pub fn validate_envelope(
    protocol_version: u32,
    request_id: &str,
    session_id: &str,
) -> Result<(), ErrorCode> {
    if protocol_version != SESSION_PROTOCOL_VERSION {
        return Err(ErrorCode::RequestInvalid);
    }
    if !is_valid_frame_id(request_id) || !is_valid_frame_id(session_id) {
        return Err(ErrorCode::RequestInvalid);
    }
    Ok(())
}
