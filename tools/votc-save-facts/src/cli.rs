//! CLI 白名单解析（实施计划 Task 2 步骤 2）。
//!
//! 只接受固定的 `probe` / `extract` / `verify` / `capabilities` 子命令。
//! save 操作接受 `--input`、`--allowed-root`、`--max-output-bytes`；
//! capabilities 只接受 `--max-output-bytes`，因此没有 save path 参数。
//! 未知参数、重复参数、缺参数一律 usage error（调用方非零退出）。
//! 不支持任意输出路径、archive entry 提取或 shell 命令。

use std::ffi::OsString;
use std::path::PathBuf;

use crate::limits;
use crate::protocol::Operation;

#[derive(Debug, Clone)]
pub struct Cli {
    pub operation: Operation,
    pub input: PathBuf,
    pub allowed_root: PathBuf,
    /// 已经过校验：1..=HARD_MAX_STDOUT_BYTES。
    pub max_output_bytes: u64,
}

pub fn parse(args: &[OsString]) -> Result<Cli, &'static str> {
    let operation = match args.first().and_then(|a| a.to_str()) {
        Some("probe") => Operation::Probe,
        Some("extract") => Operation::Extract,
        Some("verify") => Operation::Verify,
        Some("capabilities") => Operation::Capabilities,
        Some("session") => Operation::Session,
        Some(_) => {
            return Err(
                "first argument must be 'probe', 'extract', 'verify', 'capabilities', or 'session'",
            )
        }
        None => {
            return Err(
                "missing subcommand 'probe', 'extract', 'verify', 'capabilities', or 'session'",
            )
        }
    };

    let mut input: Option<PathBuf> = None;
    let mut allowed_root: Option<PathBuf> = None;
    let mut max_output_bytes: Option<u64> = None;

    let rest = &args[1..];
    let mut i = 0;
    while i < rest.len() {
        let flag = rest[i].to_str().ok_or("arguments must be valid UTF-8")?;
        // 值允许非 UTF-8（Windows 路径），但 UTF-8 且以 `--` 开头视为缺值。
        let value = |i: usize| -> Result<&OsString, &'static str> {
            match rest.get(i + 1) {
                Some(v) if v.to_str().is_none_or(|s| !s.starts_with("--")) => Ok(v),
                _ => Err("missing value for flag"),
            }
        };
        match flag {
            "--input" => {
                if operation == Operation::Capabilities {
                    return Err("capabilities does not accept --input");
                }
                if input.is_some() {
                    return Err("duplicate --input");
                }
                input = Some(PathBuf::from(value(i)?));
            }
            "--allowed-root" => {
                if operation == Operation::Capabilities {
                    return Err("capabilities does not accept --allowed-root");
                }
                if allowed_root.is_some() {
                    return Err("duplicate --allowed-root");
                }
                allowed_root = Some(PathBuf::from(value(i)?));
            }
            "--max-output-bytes" => {
                if max_output_bytes.is_some() {
                    return Err("duplicate --max-output-bytes");
                }
                let raw = value(i)?
                    .to_str()
                    .ok_or("--max-output-bytes must be valid UTF-8")?;
                let parsed: u64 = raw
                    .parse()
                    .map_err(|_| "--max-output-bytes must be a positive integer")?;
                // CLI 侧同样受编译时硬上限约束，App 不能放大。
                if parsed == 0 || parsed > limits::HARD_MAX_STDOUT_BYTES {
                    return Err("--max-output-bytes out of allowed range");
                }
                max_output_bytes = Some(parsed);
            }
            _ => return Err("unknown argument"),
        }
        i += 2;
    }

    let requires_save_path = operation != Operation::Capabilities;
    if requires_save_path && input.is_none() {
        return Err("missing --input");
    }
    if requires_save_path && allowed_root.is_none() {
        return Err("missing --allowed-root");
    }
    if operation == Operation::Capabilities && (input.is_some() || allowed_root.is_some()) {
        return Err("capabilities accepts no save path");
    }

    Ok(Cli {
        operation,
        input: input.unwrap_or_default(),
        allowed_root: allowed_root.unwrap_or_default(),
        max_output_bytes: max_output_bytes.ok_or("missing --max-output-bytes")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_full_invocation() {
        let cli = parse(&args(&[
            "probe",
            "--input",
            "a.ck3",
            "--allowed-root",
            "root",
            "--max-output-bytes",
            "2097152",
        ]))
        .unwrap();
        assert_eq!(cli.operation, Operation::Probe);
        assert_eq!(cli.input, PathBuf::from("a.ck3"));
        assert_eq!(cli.allowed_root, PathBuf::from("root"));
        assert_eq!(cli.max_output_bytes, 2_097_152);
    }

    #[test]
    fn flags_may_appear_in_any_order() {
        let cli = parse(&args(&[
            "extract",
            "--max-output-bytes",
            "1024",
            "--allowed-root",
            "root",
            "--input",
            "a.ck3",
        ]))
        .unwrap();
        assert_eq!(cli.operation, Operation::Extract);
    }

    #[test]
    fn rejects_unknown_subcommand() {
        assert!(parse(&args(&["dump", "--input", "a.ck3"])).is_err());
    }

    #[test]
    fn rejects_missing_subcommand() {
        assert!(parse(&args(&[])).is_err());
    }

    #[test]
    fn rejects_unknown_flag() {
        assert!(parse(&args(&[
            "probe",
            "--input",
            "a.ck3",
            "--allowed-root",
            "r",
            "--max-output-bytes",
            "10",
            "--output",
            "x"
        ]))
        .is_err());
    }

    #[test]
    fn rejects_equals_style_flag() {
        assert!(parse(&args(&["probe", "--input=a.ck3"])).is_err());
    }

    #[test]
    fn rejects_duplicate_flag() {
        assert!(parse(&args(&[
            "probe",
            "--input",
            "a.ck3",
            "--input",
            "b.ck3",
            "--allowed-root",
            "r",
            "--max-output-bytes",
            "10"
        ]))
        .is_err());
    }

    #[test]
    fn rejects_missing_value() {
        assert!(parse(&args(&["probe", "--input", "--allowed-root", "r"])).is_err());
    }

    #[test]
    fn rejects_missing_required_flag() {
        assert!(parse(&args(&["probe", "--input", "a.ck3"])).is_err());
    }

    #[test]
    fn rejects_trailing_positional() {
        assert!(parse(&args(&[
            "probe",
            "--input",
            "a.ck3",
            "--allowed-root",
            "r",
            "--max-output-bytes",
            "10",
            "extra"
        ]))
        .is_err());
    }

    #[test]
    fn rejects_non_numeric_max_output_bytes() {
        assert!(parse(&args(&[
            "probe",
            "--input",
            "a.ck3",
            "--allowed-root",
            "r",
            "--max-output-bytes",
            "abc"
        ]))
        .is_err());
    }

    #[test]
    fn rejects_zero_and_over_hard_cap_max_output_bytes() {
        assert!(parse(&args(&[
            "probe",
            "--input",
            "a.ck3",
            "--allowed-root",
            "r",
            "--max-output-bytes",
            "0"
        ]))
        .is_err());
        assert!(parse(&args(&[
            "probe",
            "--input",
            "a.ck3",
            "--allowed-root",
            "r",
            "--max-output-bytes",
            "2097153"
        ]))
        .is_err());
    }
}
