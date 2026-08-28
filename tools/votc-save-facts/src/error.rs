//! 错误码全集（实施计划 5.6 节），外加 sidecar 请求侧的两个补充码。
//!
//! 序列化为 SCREAMING_SNAKE_CASE 字符串，与 App 端 TS 类型一一对应。
//! 部分变体由 Task 3+ 的解析/identity 校验路径使用，本任务先冻结全集。

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
// 全集按 5.6 节冻结，部分变体本任务（Task 2）尚未触达。
#[allow(dead_code)]
pub enum ErrorCode {
    // ---- 计划 5.6 节全集 ----
    SaveNotFound,
    SaveNotStable,
    SaveReadDenied,
    SaveTruncated,
    SaveEnvelopeUnknown,
    SaveEntryMissing,
    SaveBinaryUnsupported,
    SaveTokenResolverMissing,
    SaveVersionUnsupported,
    SaveParseFailed,
    SaveLimitExceeded,
    SaveIdentityMismatch,
    SavePlayerMismatch,
    SaveCampaignMismatch,
    SaveSequenceMismatch,
    SaveSlotMismatch,
    SaveDateMismatch,
    ParserNotFound,
    ParserTimeout,
    ParserCrashed,
    ParserOutputLimit,
    ParserOutputInvalid,
    ParserProtocolUnsupported,
    StartSuperseded,
    // ---- sidecar 请求侧补充 ----
    // 5.6 节未覆盖 stdin 请求本身的失败；Task 2 步骤 3 明确要求
    // REQUEST_LIMIT_EXCEEDED，配套的语法/语义失败统一用 REQUEST_INVALID。
    /// 请求 JSON 无法解析、含尾部垃圾、含 unknown 字段或语义校验失败。
    RequestInvalid,
    /// stdin 请求超过 64 KiB 上限。
    RequestLimitExceeded,
    // ---- protocol v3 persistent session（Plan B Task 2）----
    /// session 尚未 ready 时收到 search/profile；非致命，进程保留。
    SessionNotReady,
    /// session 内部 panic / 不可恢复状态；terminal。
    SessionInternal,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_serialize_as_screaming_snake_case() {
        assert_eq!(
            serde_json::to_string(&ErrorCode::SaveNotFound).unwrap(),
            "\"SAVE_NOT_FOUND\""
        );
        assert_eq!(
            serde_json::to_string(&ErrorCode::SaveEnvelopeUnknown).unwrap(),
            "\"SAVE_ENVELOPE_UNKNOWN\""
        );
        assert_eq!(
            serde_json::to_string(&ErrorCode::SaveLimitExceeded).unwrap(),
            "\"SAVE_LIMIT_EXCEEDED\""
        );
        assert_eq!(
            serde_json::to_string(&ErrorCode::ParserCrashed).unwrap(),
            "\"PARSER_CRASHED\""
        );
        assert_eq!(
            serde_json::to_string(&ErrorCode::RequestInvalid).unwrap(),
            "\"REQUEST_INVALID\""
        );
        assert_eq!(
            serde_json::to_string(&ErrorCode::RequestLimitExceeded).unwrap(),
            "\"REQUEST_LIMIT_EXCEEDED\""
        );
    }
}
