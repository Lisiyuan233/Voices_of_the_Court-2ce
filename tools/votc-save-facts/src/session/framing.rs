//! Bounded NDJSON framing for the persistent session subcommand.
//!
//! stdin: one JSON object per line, each line capped at
//! `HARD_MAX_SESSION_STDIN_FRAME_BYTES` before any unbounded allocation.
//! stdout: exactly one serialized frame per response, capped at
//! `HARD_MAX_SESSION_STDOUT_FRAME_BYTES`; no partial document is ever
//! written. Logs never touch stdout.

use std::io::{BufRead, Write};

use serde::Serialize;

use crate::error::ErrorCode;
use crate::limits;
use crate::session::protocol::SessionErrorFrame;

pub const STDIN_FRAME_CAP: usize = limits::HARD_MAX_SESSION_STDIN_FRAME_BYTES;
pub const STDOUT_FRAME_CAP: usize = limits::HARD_MAX_SESSION_STDOUT_FRAME_BYTES;

pub enum LineResult {
    /// One line without its terminator.
    Line(Vec<u8>),
    Eof,
    TooLarge,
    Io,
}

/// Incremental bounded line reader. Reads byte-by-byte up to `cap + 1`
/// bytes; a line longer than the cap reports `TooLarge` immediately without
/// growing an unbounded buffer.
pub fn read_bounded_line(reader: &mut impl BufRead) -> LineResult {
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    loop {
        let mut byte = [0u8; 1];
        match reader.read(&mut byte) {
            Ok(0) => {
                // EOF. A trailing partial line without newline is still EOF
                // for our purposes (the client always terminates lines).
                return if buf.is_empty() {
                    LineResult::Eof
                } else if buf.len() > STDIN_FRAME_CAP {
                    LineResult::TooLarge
                } else {
                    LineResult::Line(buf)
                };
            }
            Ok(_) => {
                let b = byte[0];
                if b == b'\n' {
                    if let Some(&b'\r') = buf.last() {
                        buf.pop();
                    }
                    return if buf.len() > STDIN_FRAME_CAP {
                        LineResult::TooLarge
                    } else {
                        LineResult::Line(buf)
                    };
                }
                if buf.len() > STDIN_FRAME_CAP {
                    // Cap hit before newline: report immediately. The caller
                    // terminates the process, so drain-sync is unnecessary.
                    return LineResult::TooLarge;
                }
                buf.push(b);
            }
            Err(_) => return LineResult::Io,
        }
    }
}

/// Serialize one response frame and write it as a single NDJSON line.
/// Returns false when the frame exceeds the stdout cap; the caller then
/// emits the small fallback error frame instead. Never writes partial JSON.
pub fn emit_frame<T: Serialize>(value: &T, out: &mut impl Write) -> bool {
    let doc_cap = STDOUT_FRAME_CAP.saturating_sub(1);
    let mut writer = crate::output::BoundedWriter::new(doc_cap);
    if serde_json::to_writer(&mut writer, value).is_err() {
        return false;
    }
    let mut doc = writer.into_vec();
    doc.push(b'\n');
    out.write_all(&doc).is_ok() && out.flush().is_ok()
}

/// Emit a fatal error frame; falls back to a minimal guaranteed-size frame
/// when the original serialization could not fit the budget. Last-resort
/// failure (even the fallback does not fit) writes nothing and returns false.
pub fn emit_fatal_error(
    request_id: Option<&str>,
    session_id: Option<&str>,
    operation: Option<crate::session::protocol::SessionOperation>,
    error_code: ErrorCode,
    message: impl Into<String>,
    out: &mut impl Write,
) -> bool {
    let frame = SessionErrorFrame::fatal(request_id, session_id, operation, error_code, message);
    if emit_frame(&frame, out) {
        return true;
    }
    let fallback = SessionErrorFrame::fatal(
        None,
        None,
        None,
        error_code,
        "frame exceeded output budget",
    );
    emit_frame(&fallback, out)
}

/// True when the payload starts with a UTF-8 BOM, which is forbidden.
pub fn starts_with_bom(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xEF, 0xBB, 0xBF])
}
