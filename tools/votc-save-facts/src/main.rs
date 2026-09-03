//! votc-save-facts — CK3 存档事实提取 sidecar。
//!
//! v1 probe/extract 与 v2 verify 使用固定 subcommand 分派；capabilities
//! 是独立的无 save I/O 查询。

mod capabilities;
mod cli;
mod envelope;
mod error;
mod extract;
mod fingerprint;
mod identity;
mod limits;
mod melt;
mod output;
mod protocol;
mod session;
mod snapshot;
mod tokens;
mod verify;

use std::fs;
use std::io;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::time::Instant;

use error::ErrorCode;

/// 退出码约定（计划 5.4 协议规则）：
/// - 0：正常退出，含 unsupported / invalid / limit 协议响应；
/// - 2：CLI usage error；
/// - 3：panic 或进程级失败（来不及输出协议响应）。
const EXIT_OK: i32 = 0;
const EXIT_USAGE: i32 = 2;
const EXIT_INTERNAL: i32 = 3;

fn main() {
    install_panic_hook();
    let code = match catch_unwind(run) {
        Ok(code) => code,
        // run() 拿到 CLI 后会自行用 catch_unwind 包裹并输出 PARSER_CRASHED；
        // 走到这里说明 CLI 解析阶段就 panic 了，没有足够上下文构造安全
        // 响应，只能非零退出（panic hook 已在 stderr 写有界摘要）。
        Err(_) => EXIT_INTERNAL,
    };
    std::process::exit(code);
}

/// 抑制默认 panic 报告，只在 stderr 写有界摘要；绝不写 stdout，
/// 避免污染唯一的 stdout JSON 通道。
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            *s
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.as_str()
        } else {
            "<non-string payload>"
        };
        let summary: String = payload.chars().take(160).collect();
        match info.location() {
            Some(loc) => eprintln!(
                "votc-save-facts: panic at {}:{}: {}",
                loc.file(),
                loc.line(),
                summary
            ),
            None => eprintln!("votc-save-facts: panic: {}", summary),
        }
    }));
}

fn run() -> i32 {
    let argv: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let cli = match cli::parse(&argv) {
        Ok(cli) => cli,
        Err(message) => {
            // usage error：简短 stderr 说明，不写 stdout，非零退出。
            eprintln!("votc-save-facts: {}", message);
            eprintln!(
                "usage: votc-save-facts <probe|extract|verify> --input <file.ck3> \
                 --allowed-root <dir> --max-output-bytes <n>\n       \
                 votc-save-facts capabilities --max-output-bytes <n>\n       \
                 votc-save-facts session --input <file.ck3> --allowed-root <dir> --max-output-bytes <n>"
            );
            return EXIT_USAGE;
        }
    };
    if cli.operation == protocol::Operation::Capabilities {
        return run_capabilities(&cli);
    }
    if cli.operation == protocol::Operation::Session {
        return run_session(&cli);
    }
    match catch_unwind(AssertUnwindSafe(|| run_with_cli(&cli))) {
        Ok(code) => code,
        Err(_) => {
            // panic 边界：尽力输出小型 PARSER_CRASHED 安全响应，进程仍返回非零。
            if cli.operation == protocol::Operation::Verify {
                let response = protocol::invalid_verification_response(
                    Instant::now(),
                    0,
                    ErrorCode::ParserCrashed,
                );
                let _ = output::emit_json(&response, cli.max_output_bytes, &mut io::stdout());
            } else {
                let response = protocol::crash_response(cli.operation);
                let _ = output::emit(&response, cli.max_output_bytes, &mut io::stdout());
            }
            EXIT_INTERNAL
        }
    }
}

fn run_capabilities(cli: &cli::Cli) -> i32 {
    let response = match capabilities::read_request(io::stdin()) {
        Ok(request) => {
            if capabilities::validate_request(request).is_ok() {
                capabilities::supported_result()
            } else {
                capabilities::unsupported_result()
            }
        }
        _ => capabilities::unsupported_result(),
    };
    match output::emit_json(&response, cli.max_output_bytes, &mut io::stdout()) {
        Ok(()) => EXIT_OK,
        Err(err) => {
            eprintln!(
                "votc-save-facts: cannot emit capabilities response: {}",
                err
            );
            EXIT_INTERNAL
        }
    }
}

/// Persistent session subcommand (protocol v3). Panic boundary emits a
/// best-effort bounded SESSION_INTERNAL frame; stdout stays clean otherwise.
fn run_session(cli: &cli::Cli) -> i32 {
    let allowed_root = match fs::canonicalize(&cli.allowed_root) {
        Ok(path) if path.is_dir() => path,
        _ => {
            eprintln!("votc-save-facts: --allowed-root is not an existing directory");
            return EXIT_USAGE;
        }
    };
    let result = catch_unwind(AssertUnwindSafe(|| {
        let stdin = io::stdin();
        let mut reader = io::BufReader::new(stdin.lock());
        let stdout = io::stdout();
        let mut writer = stdout.lock();
        session::run(&cli.input, &allowed_root, &mut reader, &mut writer)
    }));
    match result {
        Ok(code) => code,
        Err(_) => {
            let _ = session::framing::emit_fatal_error(
                None,
                None,
                None,
                error::ErrorCode::SessionInternal,
                "session panicked",
                &mut io::stdout(),
            );
            EXIT_INTERNAL
        }
    }
}

fn run_with_cli(cli: &cli::Cli) -> i32 {
    let started = Instant::now();

    if cli.operation == protocol::Operation::Verify {
        return run_verify_with_cli(cli, started);
    }

    // --allowed-root 必须是已存在目录，否则属于 CLI 使用错误。
    // canonicalize 同时归一 Windows 大小写与分隔符，供后续组件级比较。
    let allowed_root = match fs::canonicalize(&cli.allowed_root) {
        Ok(path) if path.is_dir() => path,
        _ => {
            eprintln!("votc-save-facts: --allowed-root is not an existing directory");
            return EXIT_USAGE;
        }
    };

    let stdout = &mut io::stdout();

    // 1) 有界读取并解析 stdin 请求。
    let request = match protocol::read_request(io::stdin()) {
        Ok(request) => request,
        Err(err) => {
            let code = match err {
                protocol::RequestReadError::TooLarge => ErrorCode::RequestLimitExceeded,
                protocol::RequestReadError::Invalid => ErrorCode::RequestInvalid,
            };
            let response = protocol::error_response(cli.operation, code, started, 0);
            return emit(&response, cli.max_output_bytes, stdout);
        }
    };

    // 2) 语义校验（协议版本、operation 一致、categories、limits 硬上限等）。
    let validated = match protocol::validate_request(request, cli.operation, cli.max_output_bytes) {
        Ok(validated) => validated,
        Err(code) => {
            let response = protocol::error_response(cli.operation, code, started, 0);
            return emit(&response, cli.max_output_bytes, stdout);
        }
    };

    // 3) 双重路径 containment（canonicalize 后组件级比较）。
    let input_bytes = match check_save_path(&cli.input, &allowed_root) {
        Ok(size) => size,
        Err(code) => {
            let response = protocol::error_response(cli.operation, code, started, 0);
            return emit(&response, validated.max_output_bytes, stdout);
        }
    };

    // 4) envelope 识别 + identity probe（extract 在 identity 后仍降级，
    //    事实提取属 Task 4）。
    let response = probe_save(cli.operation, &cli.input, input_bytes, &validated, started);
    emit(&response, validated.max_output_bytes, stdout)
}

/// Protocol-v2 typed verification. Request validation is completed before any
/// save path is touched; the verify module then binds all work to one bounded
/// private content snapshot and revalidates the original file before returning.
fn run_verify_with_cli(cli: &cli::Cli, started: Instant) -> i32 {
    let request = match protocol::read_verification_request(io::stdin()) {
        Ok(request) => request,
        Err(err) => {
            let code = match err {
                protocol::RequestReadError::TooLarge => ErrorCode::RequestLimitExceeded,
                protocol::RequestReadError::Invalid => ErrorCode::RequestInvalid,
            };
            let response = protocol::invalid_verification_response(started, 0, code);
            return emit_verification(&response, cli.max_output_bytes);
        }
    };
    if let Err(code) = protocol::validate_verification_request(&request, cli.max_output_bytes) {
        let response =
            protocol::invalid_verification_response(started, request.checks.len() as u64, code);
        return emit_verification(&response, cli.max_output_bytes);
    }
    let allowed_root = match fs::canonicalize(&cli.allowed_root) {
        Ok(path) if path.is_dir() => path,
        _ => {
            eprintln!("votc-save-facts: --allowed-root is not an existing directory");
            return EXIT_USAGE;
        }
    };
    let output_cap = cli.max_output_bytes.min(request.limits.max_output_bytes);
    let response = verify::run(&cli.input, &allowed_root, &request, started);
    emit_verification(&response, output_cap)
}

fn emit_verification(response: &protocol::SaveVerificationResponseV2, cap: u64) -> i32 {
    match output::emit_json(response, cap, &mut io::stdout()) {
        Ok(()) => EXIT_OK,
        Err(err) => {
            eprintln!("votc-save-facts: cannot emit verify response: {}", err);
            EXIT_INTERNAL
        }
    }
}

/// envelope → fingerprint → identity 的主流程，所有分支都只产出一份
/// 协议响应（不出异常、不写 stdout）。
fn probe_save(
    operation: protocol::Operation,
    path: &Path,
    input_bytes: u64,
    validated: &protocol::ValidatedRequest,
    started: Instant,
) -> protocol::SaveFactExtractionResultV1 {
    use protocol::{ResponseParts, Status};

    let opened = match envelope::open(path) {
        Ok(opened) => opened,
        Err(err) => {
            let (status, code) = match err {
                envelope::EnvelopeError::Unknown => {
                    (Status::Unsupported, ErrorCode::SaveEnvelopeUnknown)
                }
                envelope::EnvelopeError::Truncated => (Status::Invalid, ErrorCode::SaveTruncated),
                envelope::EnvelopeError::EntryMissing => {
                    (Status::Invalid, ErrorCode::SaveEntryMissing)
                }
                envelope::EnvelopeError::DuplicateGamestate => {
                    (Status::Invalid, ErrorCode::SaveParseFailed)
                }
                envelope::EnvelopeError::DeclaredTooLarge => {
                    (Status::Invalid, ErrorCode::SaveLimitExceeded)
                }
                // 压缩方式不属于已支持变体（jomini 只支持 deflate）。
                envelope::EnvelopeError::UnsupportedCompression => {
                    (Status::Unsupported, ErrorCode::SaveVersionUnsupported)
                }
            };
            return protocol::response(
                operation,
                started,
                ResponseParts {
                    status,
                    source_format: protocol::SourceFormat::Unknown,
                    snapshot_id: String::new(),
                    source_fingerprint: fingerprint::source_fingerprint(path, &[])
                        .unwrap_or_default(),
                    ck3_version: None,
                    identity: None,
                    join_candidates: None,
                    entities: Vec::new(),
                    facts: Vec::new(),
                    warnings: Vec::new(),
                    error: Some(code),
                    input_bytes,
                    decompressed_bytes: None,
                    scanned_bytes: None,
                },
            );
        }
    };

    let fingerprint =
        fingerprint::source_fingerprint(path, &opened.header_line).unwrap_or_default();

    // 小型错误响应构造（本函数内所有失败分支共用，避免重复铺 ResponseParts）。
    let source_format = opened.format;
    let fail = |status: Status, code: ErrorCode| {
        protocol::response(
            operation,
            started,
            ResponseParts {
                status,
                source_format,
                snapshot_id: String::new(),
                source_fingerprint: fingerprint.clone(),
                ck3_version: None,
                identity: None,
                join_candidates: None,
                entities: Vec::new(),
                facts: Vec::new(),
                warnings: Vec::new(),
                error: Some(code),
                input_bytes,
                decompressed_bytes: None,
                scanned_bytes: None,
            },
        )
    };

    // text gamestate：有界扫描 identity，提前停止。
    let scan_limits = identity::ScanLimits {
        max_bytes: validated.limits.max_decompressed_bytes,
        max_nesting: validated.limits.max_nesting_depth as u32,
        max_scalar: validated.limits.max_scalar_bytes as usize,
    };
    let is_zip = opened.gamestate_uncompressed_hint.is_some();

    // binary（zip_binary / unified_binary）：版本门禁（meta_data.version 与
    // token 表版本比对）→ melt 成明文，复用既有文本扫描路径；未解析 token
    // 计数经 melt_stats 回传为 warning。text 路径行为不变。
    let mut melt_stats: Option<melt::SharedMeltStats> = None;
    let reader: Box<dyn io::Read + '_>;
    let player_reader: Box<dyn io::Read + '_>;
    if opened.is_binary() {
        let gate_reader = match opened.gamestate_binary() {
            Ok(reader) => reader,
            Err(envelope::EnvelopeError::UnsupportedCompression) => {
                return fail(Status::Unsupported, ErrorCode::SaveVersionUnsupported)
            }
            Err(_) => return fail(Status::Invalid, ErrorCode::SaveTruncated),
        };
        match melt::check_version(gate_reader, melt::VERSION_GATE_MAX_BYTES) {
            Ok(()) => {}
            Err(melt::VersionGateError::Truncated) => {
                return fail(Status::Invalid, ErrorCode::SaveTruncated)
            }
            Err(melt::VersionGateError::ParseFailed) => {
                return fail(Status::Invalid, ErrorCode::SaveParseFailed)
            }
            Err(melt::VersionGateError::Mismatch) => {
                return fail(Status::Unsupported, ErrorCode::SaveTokenVersionMismatch)
            }
        }
        let stats = melt::new_stats();
        reader = match opened.gamestate_binary() {
            Ok(r) => Box::new(melt::MeltReader::new(r, stats.clone())),
            Err(_) => return fail(Status::Invalid, ErrorCode::SaveTruncated),
        };
        player_reader = match opened.gamestate_binary() {
            Ok(r) => Box::new(melt::MeltReader::new(r, stats.clone())),
            Err(_) => return fail(Status::Invalid, ErrorCode::SaveTruncated),
        };
        melt_stats = Some(stats);
    } else {
        reader = match opened.gamestate() {
            Ok(reader) => reader,
            Err(_) => return fail(Status::Invalid, ErrorCode::SaveTruncated),
        };
        player_reader = match opened.gamestate() {
            Ok(reader) => reader,
            Err(_) => return fail(Status::Invalid, ErrorCode::SaveTruncated),
        };
    }
    let extraction = match identity::extract(reader, player_reader, scan_limits) {
        Ok(mut extraction) => {
            if let Some(stats) = &melt_stats {
                if stats.unresolved_tokens.get() > 0 {
                    extraction.warnings.push(protocol::Warning {
                        code: melt::WARN_TOKENS_PARTIALLY_UNRESOLVED.to_string(),
                        category: None,
                    });
                }
            }
            extraction
        }
        Err(err) => {
            let code = match err {
                identity::IdentityError::Truncated => ErrorCode::SaveTruncated,
                identity::IdentityError::LimitExceeded => ErrorCode::SaveLimitExceeded,
                identity::IdentityError::ParseFailed | identity::IdentityError::Io => {
                    ErrorCode::SaveParseFailed
                }
            };
            return fail(Status::Invalid, code);
        }
    };

    let snapshot_id = fingerprint::snapshot_id(
        extraction.identity.player_character_id.as_deref(),
        extraction.identity.campaign_id_parts,
        extraction.identity.snapshot_sequence,
        extraction.identity.snapshot_slot,
    )
    .unwrap_or_default();

    let snapshot_id_opt = if snapshot_id.is_empty() {
        None
    } else {
        Some(snapshot_id.clone())
    };

    // probe：identity 齐全即 ok，缺核心字段降级 partial，entities/facts 为空。
    // extract：identity 已在本次调用内重跑校验（不信任此前 probe），随后做
    // 参与者邻域的稀疏 family/realm extraction。
    let (status, error, entities, facts, warnings, total_scanned) = match operation {
        protocol::Operation::Probe => {
            let status = if extraction.core_complete {
                Status::Ok
            } else {
                Status::Partial
            };
            (
                status,
                None,
                Vec::new(),
                Vec::new(),
                extraction.warnings,
                extraction.scanned_bytes,
            )
        }
        protocol::Operation::Extract => {
            // extract 会读完整条 gamestate 流，使用带 CRC/size 校验的
            // reader（读到 EOF 时验证；probe 提前停止不校验尾部）。
            // binary 走 verified binary reader + melt 包装（同一 stats）。
            let reader: Box<dyn io::Read + '_> = if let Some(stats) = &melt_stats {
                match opened.gamestate_binary_verified() {
                    Ok(r) => Box::new(melt::MeltReader::new(r, stats.clone())),
                    Err(err) => {
                        let (status, code) = match err {
                            envelope::EnvelopeError::UnsupportedCompression => {
                                (Status::Unsupported, ErrorCode::SaveVersionUnsupported)
                            }
                            _ => (Status::Invalid, ErrorCode::SaveTruncated),
                        };
                        return fail(status, code);
                    }
                }
            } else {
                match opened.gamestate_verified() {
                    Ok(reader) => reader,
                    Err(err) => {
                        let (status, code) = match err {
                            envelope::EnvelopeError::UnsupportedCompression => {
                                (Status::Unsupported, ErrorCode::SaveVersionUnsupported)
                            }
                            _ => (Status::Invalid, ErrorCode::SaveTruncated),
                        };
                        return fail(status, code);
                    }
                }
            };
            let extract_limits = extract::ExtractionLimits {
                scan: scan_limits,
                max_facts: validated.limits.max_facts,
                max_entities: validated.limits.max_entities,
                max_related_characters: validated.limits.max_related_characters,
            };
            let ctx = extract::ExtractionContext {
                participants: validated.participants.clone(),
                categories: validated.categories.clone(),
                game_date_numeric: extraction.identity.game_date_numeric,
                game_date_display: extraction.identity.game_date_display.clone(),
                snapshot_id: snapshot_id_opt.clone(),
                campaign_id: extraction
                    .identity
                    .campaign_id_parts
                    .map(|p| format!("{}.{}.{}.{}", p[0], p[1], p[2], p[3])),
                snapshot_sequence: extraction.identity.snapshot_sequence,
            };
            match extract::extract(reader, extract_limits, &ctx) {
                Ok(result) => {
                    let mut warnings = extraction.warnings;
                    warnings.extend(result.warnings);
                    let status = if extraction.core_complete && !result.partial {
                        Status::Ok
                    } else {
                        Status::Partial
                    };
                    (
                        status,
                        None,
                        result.entities,
                        result.facts,
                        warnings,
                        extraction.scanned_bytes + result.scanned_bytes,
                    )
                }
                Err(err) => {
                    let code = match err {
                        identity::IdentityError::Truncated => ErrorCode::SaveTruncated,
                        identity::IdentityError::LimitExceeded => ErrorCode::SaveLimitExceeded,
                        identity::IdentityError::ParseFailed | identity::IdentityError::Io => {
                            ErrorCode::SaveParseFailed
                        }
                    };
                    return fail(Status::Invalid, code);
                }
            }
        }
        protocol::Operation::Verify | protocol::Operation::Capabilities | protocol::Operation::Session => {
            unreachable!("non-extraction operation reached v1 probe/extract path")
        }
    };

    protocol::response(
        operation,
        started,
        ResponseParts {
            status,
            source_format: opened.format,
            snapshot_id,
            source_fingerprint: fingerprint,
            ck3_version: extraction.ck3_version,
            identity: Some(extraction.identity),
            join_candidates: extraction.join_candidates,
            entities,
            facts,
            warnings,
            error,
            input_bytes,
            decompressed_bytes: if is_zip { Some(total_scanned) } else { None },
            scanned_bytes: Some(total_scanned),
        },
    )
}

/// 序列化并写出唯一一份响应；emit 内部负责超限降级。连小型响应都放不
/// 下时进程级失败（非零），stdout 不留任何截断 JSON。
fn emit(response: &protocol::SaveFactExtractionResultV1, cap: u64, stdout: &mut io::Stdout) -> i32 {
    match output::emit(response, cap, stdout) {
        Ok(()) => EXIT_OK,
        Err(err) => {
            eprintln!(
                "votc-save-facts: cannot emit response within output budget: {}",
                err
            );
            EXIT_INTERNAL
        }
    }
}

/// 路径 containment 检查，返回文件大小（计入 metrics.inputBytes）。
/// 错误码不含任何路径信息；响应 DTO 的 error 只有 code，stderr 也不回显
/// 完整路径，天然满足脱敏要求。
fn check_save_path(input: &Path, allowed_root: &Path) -> Result<u64, ErrorCode> {
    // canonicalize 解析 symlink/reparse point：逃逸 root 的链接会解析到
    // root 之外，被下面的 starts_with 拒绝。
    let canonical = match fs::canonicalize(input) {
        Ok(path) => path,
        Err(err) => {
            return Err(match err.kind() {
                io::ErrorKind::PermissionDenied => ErrorCode::SaveReadDenied,
                _ => ErrorCode::SaveNotFound,
            })
        }
    };
    // canonical path 组件级比较（Windows 大小写/separator 已由 canonicalize
    // 归一），不做字符串前缀比较。
    if !canonical.starts_with(allowed_root) {
        return Err(ErrorCode::SaveReadDenied);
    }
    let metadata = fs::metadata(&canonical).map_err(|_| ErrorCode::SaveReadDenied)?;
    if !metadata.is_file() {
        // 拒绝目录和其他非普通文件。
        return Err(ErrorCode::SaveReadDenied);
    }
    match canonical.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("ck3") => {}
        _ => return Err(ErrorCode::SaveReadDenied), // 拒绝非 .ck3 扩展名
    }
    Ok(metadata.len())
}
