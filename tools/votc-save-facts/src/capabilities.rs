//! 独立 capabilities 子命令协议。
//!
//! capabilities 不接收 save path，也不创建、canonicalize 或读取任何 save
//! 文件。它只描述当前 executable 已经可以安全调用的 operation/protocol 对。

use std::io::Read;

use serde::{Deserialize, Serialize};

use crate::{limits, protocol::Operation};

pub const CAPABILITIES_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveFactCapabilitiesRequestV1 {
    pub protocol_version: u32,
    pub operation: Operation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFactCapabilityV1 {
    pub operation: Operation,
    pub protocol_version: u32,
}

/// binary 存档解析支持状态。App 端白名单已含 `binarySaveSupport`
///（saveFactVerificationSchemas.ts），可以安全上报。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinarySaveSupportV1 {
    pub status: CapabilitiesStatus,
    /// 编译进二进制的 token 表覆盖的 CK3 游戏版本。
    pub token_table_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFactCapabilitiesResultV1 {
    pub protocol_version: u32,
    pub operation: Operation,
    pub status: CapabilitiesStatus,
    pub capabilities: Vec<SaveFactCapabilityV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parser_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary_save_support: Option<BinarySaveSupportV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CapabilitiesStatus {
    Ok,
    Unsupported,
}

pub fn read_request(stdin: impl Read) -> Result<SaveFactCapabilitiesRequestV1, ()> {
    let mut limited = stdin.take(limits::HARD_MAX_STDIN_REQUEST_BYTES as u64 + 1);
    let mut buf = Vec::new();
    if limited.read_to_end(&mut buf).is_err() || buf.len() > limits::HARD_MAX_STDIN_REQUEST_BYTES {
        return Err(());
    }
    serde_json::from_slice(&buf).map_err(|_| ())
}

pub fn validate_request(request: SaveFactCapabilitiesRequestV1) -> Result<(), ()> {
    if request.protocol_version != CAPABILITIES_PROTOCOL_VERSION
        || request.operation != Operation::Capabilities
    {
        return Err(());
    }
    Ok(())
}

/// Every advertised pair has a production implementation and regression
/// coverage. Capabilities remains pure metadata and performs no save I/O.
pub fn supported_result() -> SaveFactCapabilitiesResultV1 {
    SaveFactCapabilitiesResultV1 {
        protocol_version: CAPABILITIES_PROTOCOL_VERSION,
        operation: Operation::Capabilities,
        status: CapabilitiesStatus::Ok,
        capabilities: vec![
            SaveFactCapabilityV1 {
                operation: Operation::Probe,
                protocol_version: crate::protocol::EXTRACT_PROTOCOL_VERSION,
            },
            SaveFactCapabilityV1 {
                operation: Operation::Extract,
                protocol_version: crate::protocol::EXTRACT_PROTOCOL_VERSION,
            },
            SaveFactCapabilityV1 {
                operation: Operation::Verify,
                protocol_version: crate::protocol::VERIFY_PROTOCOL_VERSION,
            },
            SaveFactCapabilityV1 {
                operation: Operation::Session,
                protocol_version: crate::session::protocol::SESSION_PROTOCOL_VERSION,
            },
        ],
        parser_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        binary_save_support: Some(BinarySaveSupportV1 {
            status: CapabilitiesStatus::Ok,
            token_table_version: crate::tokens::TOKEN_TABLE_CK3_VERSION.to_string(),
        }),
    }
}

pub fn unsupported_result() -> SaveFactCapabilitiesResultV1 {
    SaveFactCapabilitiesResultV1 {
        protocol_version: CAPABILITIES_PROTOCOL_VERSION,
        operation: Operation::Capabilities,
        status: CapabilitiesStatus::Unsupported,
        capabilities: Vec::new(),
        parser_version: None,
        binary_save_support: None,
    }
}
