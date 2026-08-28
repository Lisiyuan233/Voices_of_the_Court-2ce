//! 有界 JSON 输出（实施计划 Task 2 步骤 5）。
//!
//! 先在内存中把受限 DTO 序列化到带 byte cap 的 writer；超过
//! maxOutputBytes 时降级为小型 SAVE_LIMIT_EXCEEDED 响应，绝不把截断
//! JSON 写到 stdout。stdout 只有这一份 JSON（结尾一个换行），日志只走
//! stderr（见 main.rs）。

use std::io::{self, Write};

use crate::protocol::{self, SaveFactExtractionResultV1};
use serde::Serialize;

/// 带字节上限的内存 writer。写超限时返回错误，已缓冲内容随 writer 一起
/// 被调用方丢弃，不会外泄部分文档。
pub struct BoundedWriter {
    buf: Vec<u8>,
    cap: usize,
}

impl BoundedWriter {
    pub fn new(cap: usize) -> Self {
        Self {
            buf: Vec::with_capacity(cap.min(1 << 20)),
            cap,
        }
    }

    pub fn into_vec(self) -> Vec<u8> {
        self.buf
    }
}

impl Write for BoundedWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if self.buf.len() + data.len() > self.cap {
            return Err(io::Error::other("bounded writer capacity exceeded"));
        }
        self.buf.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// 序列化响应并在 cap 内写出（JSON 文档 + 结尾一个换行都计入 cap）。
///
/// - 正常响应超限 → 降级为 SAVE_LIMIT_EXCEEDED 小型响应；
/// - 小型响应也放不下 → 返回 Err，调用方进程级失败（非零退出），
///   stdout 什么都不写。
pub fn emit(
    response: &SaveFactExtractionResultV1,
    cap: u64,
    out: &mut impl Write,
) -> io::Result<()> {
    match serialize_capped(response, cap) {
        Some(doc) => write_doc(out, &doc),
        None => {
            let fallback = protocol::limit_exceeded_response(response.operation);
            match serialize_capped(&fallback, cap) {
                Some(doc) => write_doc(out, &doc),
                None => Err(io::Error::other(
                    "max-output-bytes below minimum response size",
                )),
            }
        }
    }
}

/// Emit a non-v1 DTO as one bounded JSON document. Unlike v1 `emit`, callers
/// choose the fallback semantics because capabilities and verify have distinct
/// response envelopes. No partial document is ever written.
pub fn emit_json<T: Serialize>(value: &T, cap: u64, out: &mut impl Write) -> io::Result<()> {
    let doc_cap = usize::try_from(cap.saturating_sub(1)).unwrap_or(usize::MAX);
    let mut writer = BoundedWriter::new(doc_cap);
    serde_json::to_writer(&mut writer, value)
        .map_err(|_| io::Error::other("JSON response exceeds output budget"))?;
    let doc = writer.into_vec();
    out.write_all(&doc)?;
    out.write_all(b"\n")?;
    out.flush()
}

/// 序列化到 BoundedWriter；超出 cap（为结尾换行预留 1 字节）返回 None。
fn serialize_capped(response: &SaveFactExtractionResultV1, cap: u64) -> Option<Vec<u8>> {
    let doc_cap = usize::try_from(cap.saturating_sub(1)).unwrap_or(usize::MAX);
    let mut writer = BoundedWriter::new(doc_cap);
    serde_json::to_writer(&mut writer, response).ok()?;
    Some(writer.into_vec())
}

fn write_doc(out: &mut impl Write, doc: &[u8]) -> io::Result<()> {
    out.write_all(doc)?;
    out.write_all(b"\n")?;
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Operation;
    use std::time::Instant;

    #[test]
    fn bounded_writer_allows_up_to_cap() {
        let mut writer = BoundedWriter::new(5);
        writer.write_all(b"abc").unwrap();
        writer.write_all(b"de").unwrap();
        assert_eq!(writer.into_vec(), b"abcde");
    }

    #[test]
    fn bounded_writer_rejects_beyond_cap() {
        let mut writer = BoundedWriter::new(5);
        writer.write_all(b"abc").unwrap();
        assert!(writer.write(b"def").is_err());
    }

    #[test]
    fn emit_writes_single_json_doc_with_one_newline() {
        let response = protocol::unsupported_response(Operation::Probe, Instant::now(), 1234);
        let mut out = Vec::new();
        emit(&response, crate::limits::HARD_MAX_STDOUT_BYTES, &mut out).unwrap();
        assert!(out.ends_with(b"}\n"));
        assert!(!out.ends_with(b"}\n\n"));
        let parsed: serde_json::Value = serde_json::from_slice(&out[..out.len() - 1]).unwrap();
        assert_eq!(parsed["status"], "unsupported");
    }

    #[test]
    fn emit_falls_back_to_limit_exceeded_when_over_cap() {
        let response = protocol::unsupported_response(Operation::Probe, Instant::now(), 1234);
        let full_len = serde_json::to_vec(&response).unwrap().len() as u64 + 1;
        let mut out = Vec::new();
        emit(&response, full_len - 1, &mut out).unwrap();
        assert!((out.len() as u64) < full_len);
        let parsed: serde_json::Value = serde_json::from_slice(&out[..out.len() - 1]).unwrap();
        assert_eq!(parsed["error"]["code"], "SAVE_LIMIT_EXCEEDED");
    }

    #[test]
    fn emit_fails_closed_when_cap_below_minimum_response() {
        let response = protocol::unsupported_response(Operation::Probe, Instant::now(), 1234);
        let mut out = Vec::new();
        assert!(emit(&response, 8, &mut out).is_err());
        assert!(out.is_empty(), "no partial JSON may escape");
    }
}
