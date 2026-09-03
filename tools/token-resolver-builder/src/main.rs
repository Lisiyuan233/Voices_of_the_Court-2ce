//! token-resolver-builder：通过配对存档结构对齐构建 CK3 token 表。
//!
//! 用法：
//! ```text
//! token-resolver-builder build \
//!   --pair "bin1.ck3=text1.ck3" [--pair ...] \
//!   --out-dir out/ [--game-version 1.19.0.6]
//! ```

mod align;
mod emit;
mod events;
mod unpack;
mod verify;
mod vote;

#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use jomini::text::TextTape;

use align::PairOutcome;
use events::{Key, Mode, walk_text_level};
use unpack::Gamestate;
use vote::FinalTable;

struct Config {
    pairs: Vec<(PathBuf, PathBuf)>,
    out_dir: PathBuf,
    game_version: Option<String>,
}

fn usage() -> String {
    "usage: token-resolver-builder build \\\n\
     \x20 --pair \"<binary.ck3>=<text.ck3>\" [--pair ...] \\\n\
     \x20 --out-dir <dir> [--game-version <x.y.z>]".to_string()
}

fn parse_args(args: &[String]) -> Result<Config, String> {
    if args.len() < 2 || args[1] != "build" {
        return Err(usage());
    }
    let mut pairs = Vec::new();
    let mut out_dir = None;
    let mut game_version = None;
    let mut i = 2;
    while i < args.len() {
        match args[i].as_str() {
            "--pair" => {
                let v = args.get(i + 1).ok_or_else(|| "--pair needs a value".to_string())?;
                let (bin, text) = v
                    .split_once('=')
                    .ok_or_else(|| format!("--pair expects \"bin=text\", got {v:?}"))?;
                pairs.push((PathBuf::from(bin), PathBuf::from(text)));
                i += 2;
            }
            "--out-dir" => {
                out_dir = Some(PathBuf::from(
                    args.get(i + 1).ok_or_else(|| "--out-dir needs a value".to_string())?,
                ));
                i += 2;
            }
            "--game-version" => {
                game_version = Some(
                    args.get(i + 1)
                        .ok_or_else(|| "--game-version needs a value".to_string())?
                        .clone(),
                );
                i += 2;
            }
            other => return Err(format!("unknown argument {other:?}\n{}", usage())),
        }
    }
    if pairs.is_empty() {
        return Err(format!("at least one --pair is required\n{}", usage()));
    }
    let out_dir = out_dir.ok_or_else(|| format!("--out-dir is required\n{}", usage()))?;
    Ok(Config {
        pairs,
        out_dir,
        game_version,
    })
}

/// 一对载入完毕的存档。
struct LoadedPair {
    name: String,
    text: Vec<u8>,
    bin: Vec<u8>,
}

fn load_pair(bin_path: &Path, text_path: &Path) -> Result<LoadedPair, String> {
    let name = bin_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "pair".to_string());
    let bin = match unpack::read_gamestate(bin_path)? {
        Gamestate::Binary(b) => b,
        Gamestate::Text(_) => {
            return Err(format!("{} is a text save, expected binary", bin_path.display()));
        }
    };
    let text = match unpack::read_gamestate(text_path)? {
        Gamestate::Text(b) => b,
        Gamestate::Binary(_) => {
            return Err(format!(
                "{} is a binary save, expected text",
                text_path.display()
            ));
        }
    };
    Ok(LoadedPair { name, text, bin })
}

/// 从明文存档提取游戏版本（meta_data.version）。
fn extract_version(tokens: &[jomini::text::TextToken]) -> Option<String> {
    let items = walk_text_level(tokens, 0, tokens.len(), Mode::Object);
    for item in &items {
        if item.key == Some(Key::Str("meta_data".to_string())) {
            if let Some((cs, ce)) = item.range {
                for sub in walk_text_level(tokens, cs + 1, ce, Mode::Object) {
                    if sub.key == Some(Key::Str("version".to_string())) {
                        return sub.value_raw;
                    }
                }
            }
        }
    }
    None
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

/// 从当前工作目录加载 overrides.json（不存在则返回 Ok(None)）。
/// 格式：`{ "tokens": { "0x3fcc": "needs_external_help" }, "_note": "..." }`。
fn load_overrides() -> Result<Option<std::collections::BTreeMap<u16, String>>, String> {
    let path = std::path::Path::new("overrides.json");
    let data = match std::fs::read_to_string(path) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let v: serde_json::Value =
        serde_json::from_str(&data).map_err(|e| format!("parse: {e}"))?;
    let mut out = std::collections::BTreeMap::new();
    if let Some(tokens) = v.get("tokens").and_then(|t| t.as_object()) {
        for (k, name) in tokens {
            let tok = u16::from_str_radix(k.trim_start_matches("0x"), 16)
                .map_err(|e| format!("token key {k}: {e}"))?;
            let name = name
                .as_str()
                .ok_or_else(|| format!("token {k}: value must be string"))?;
            out.insert(tok, name.to_string());
        }
    }
    Ok(Some(out))
}

fn run(args: &[String]) -> Result<(), String> {
    let config = parse_args(args)?;

    // 1. 载入配对。
    let mut pairs = Vec::new();
    for (bin_path, text_path) in &config.pairs {
        eprintln!("loading {} ...", bin_path.display());
        pairs.push(load_pair(bin_path, text_path)?);
    }

    // 2. 解析明文 tape + 对齐。
    let mut tapes = Vec::new();
    let mut outcomes: Vec<PairOutcome> = Vec::new();
    for pair in &pairs {
        let tape = TextTape::from_slice(&pair.text)
            .map_err(|e| format!("text tape {}: {e}", pair.name))?;
        let mut outcome = PairOutcome::default();
        align::align_pair(tape.tokens(), &pair.bin, &mut outcome)?;
        eprintln!(
            "aligned {}: {} items, {} anchors, {} ambiguous items",
            pair.name, outcome.aligned_items, outcome.anchor_pairs, outcome.ambiguous_items
        );
        tapes.push(tape);
        outcomes.push(outcome);
    }

    // 3. 游戏版本。
    let version = config
        .game_version
        .or_else(|| tapes.first().and_then(|t| extract_version(t.tokens())))
        .unwrap_or_else(|| "unknown".to_string());

    // 4. 跨配对投票 + 人工订正（overrides.json，存在才加载）。
    let mut table = vote::finalize(&outcomes.iter().collect::<Vec<_>>());
    let applied_overrides = match load_overrides() {
        Ok(Some(ov)) => {
            let applied = vote::apply_overrides(&mut table, &ov);
            for a in &applied {
                eprintln!("override applied: {a}");
            }
            applied
        }
        Ok(None) => Vec::new(),
        Err(e) => return Err(format!("overrides.json: {e}")),
    };

    // 5. 单对独立建表的一致性（验收：零冲突）。
    let single_tables: Vec<FinalTable> = outcomes
        .iter()
        .map(|o| vote::finalize(&[o]))
        .collect();
    let mut cross_conflicts: Vec<String> = Vec::new();
    for i in 0..single_tables.len() {
        for j in i + 1..single_tables.len() {
            for (tok, name) in &single_tables[i].tokens {
                if let Some(other) = single_tables[j].tokens.get(tok) {
                    if other != name {
                        cross_conflicts.push(format!(
                            "token 0x{tok:04x}: {}={name} vs {}={other}",
                            pairs[i].name, pairs[j].name
                        ));
                    }
                }
            }
            for (idx, s) in &single_tables[i].lookup {
                if let Some(other) = single_tables[j].lookup.get(idx) {
                    if other != s {
                        cross_conflicts.push(format!(
                            "lookup {idx}: {}={s} vs {}={other}",
                            pairs[i].name, pairs[j].name
                        ));
                    }
                }
            }
        }
    }

    // 6. 写产物。
    std::fs::create_dir_all(&config.out_dir)
        .map_err(|e| format!("create {}: {e}", config.out_dir.display()))?;
    let total_ambiguous_windows: u64 = outcomes.iter().map(|o| o.ambiguous_windows).sum();
    let total_ambiguous_items: u64 = outcomes.iter().map(|o| o.ambiguous_items).sum();
    let stats = serde_json::json!({
        "pairs": pairs.len(),
        "tokens_resolved": table.tokens.len(),
        "lookup_resolved": table.lookup.len(),
        "conflicts": table.conflicts,
        "ambiguous_windows": total_ambiguous_windows,
        "ambiguous_items": total_ambiguous_items,
    });
    let json_path = emit::write_json(&config.out_dir, &version, &table, stats)?;
    let rs_path = emit::write_rust(&config.out_dir, &version, &table)?;
    eprintln!("wrote {}", json_path.display());
    eprintln!("wrote {}", rs_path.display());

    // 7. 验证：覆盖率 + 路径交叉比对。
    let mut report = String::new();
    report.push_str(&format!("# Token Resolver Build Report\n\n"));
    report.push_str(&format!("- game version: `{version}`\n"));
    report.push_str(&format!("- pairs: {}\n", pairs.len()));
    report.push_str(&format!("- tokens resolved: {}\n", table.tokens.len()));
    report.push_str(&format!("- lookup entries: {}\n", table.lookup.len()));
    report.push_str(&format!("- conflicts: {}\n", table.conflicts.len()));
    if !applied_overrides.is_empty() {
        report.push_str(&format!(
            "- overrides applied: {} ({})\n",
            applied_overrides.len(),
            applied_overrides.join("; ")
        ));
    }
    report.push_str(&format!(
        "- ambiguous: {total_ambiguous_windows} windows / {total_ambiguous_items} items\n"
    ));
    report.push_str(&format!("- outputs: `{}`, `{}`\n\n",
        json_path.display(), rs_path.display()));

    let mut min_match_rate = 1.0f64;
    for (pair, tape) in pairs.iter().zip(tapes.iter()) {
        eprintln!("verifying {} ...", pair.name);
        let cov = verify::coverage(&pair.bin, &table);
        let text_flat = verify::flatten_text(tape.tokens());
        let bin_flat = verify::flatten_bin(&pair.bin, &table)?;
        let cmp = verify::compare_paths(&text_flat, &bin_flat);
        min_match_rate = min_match_rate.min(cmp.match_rate);

        let resolve_rate = if cov.id_occurrences == 0 {
            1.0
        } else {
            cov.resolved_occurrences as f64 / cov.id_occurrences as f64
        };
        report.push_str(&format!("## {}\n\n", pair.name));
        report.push_str(&format!(
            "- id tokens: {} occurrences, resolved {} ({:.2}%), unresolved distinct: {}\n",
            cov.id_occurrences,
            cov.resolved_occurrences,
            resolve_rate * 100.0,
            cov.unresolved_tokens.len()
        ));
        report.push_str(&format!(
            "- lookup indices: {} occurrences, resolved {} ({:.2}%), unresolved distinct: {}\n",
            cov.lookup_occurrences,
            cov.lookup_resolved,
            if cov.lookup_occurrences == 0 {
                100.0
            } else {
                cov.lookup_resolved as f64 / cov.lookup_occurrences as f64 * 100.0
            },
            cov.unresolved_lookups.len()
        ));
        report.push_str(&format!(
            "- deserializer re-parse (Stringify): {}\n",
            if cov.deserializer_ok { "ok" } else { "FAILED" }
        ));
        if let Some(err) = &cov.deserializer_err {
            report.push_str(&format!("  - error: {err}\n"));
        }
        report.push_str(&format!(
            "- path match: {} text / {} bin paths, matched {} ({:.2}%)\n",
            cmp.text_paths,
            cmp.bin_paths,
            cmp.matched,
            cmp.match_rate * 100.0
        ));
        report.push_str(&format!(
            "- drift: {} text-only / {} bin-only path occurrences; value mismatches: {}\n",
            cmp.text_only_count, cmp.bin_only_count, cmp.value_mismatches
        ));
        if !cmp.text_only_samples.is_empty() {
            report.push_str("- text-only samples:\n");
            for s in &cmp.text_only_samples {
                report.push_str(&format!("  - `{s}`\n"));
            }
        }
        if !cmp.bin_only_samples.is_empty() {
            report.push_str("- bin-only samples:\n");
            for s in &cmp.bin_only_samples {
                report.push_str(&format!("  - `{s}`\n"));
            }
        }
        if !cmp.value_samples.is_empty() {
            report.push_str("- value mismatch samples:\n");
            for s in &cmp.value_samples {
                report.push_str(&format!("  - {s}\n"));
            }
        }
        if !cov.unresolved_tokens.is_empty() && cov.unresolved_tokens.len() <= 40 {
            report.push_str("- unresolved tokens:\n");
            for t in &cov.unresolved_tokens {
                report.push_str(&format!("  - `0x{t:04x}`\n"));
            }
        }
        report.push('\n');

        eprintln!(
            "{}: resolve {:.2}%, path match {:.2}%",
            pair.name,
            resolve_rate * 100.0,
            cmp.match_rate * 100.0
        );
    }

    report.push_str("## Single-pair consistency\n\n");
    if cross_conflicts.is_empty() {
        report.push_str("3 份单对独立建表之间零冲突。\n\n");
    } else {
        report.push_str(&format!("发现 {} 处跨表冲突：\n\n", cross_conflicts.len()));
        for c in cross_conflicts.iter().take(50) {
            report.push_str(&format!("- {c}\n"));
        }
        report.push('\n');
    }

    if !table.conflicts.is_empty() {
        report.push_str("## Conflicts\n\n");
        for c in &table.conflicts {
            report.push_str(&format!("- {c}\n"));
        }
        report.push('\n');
    }

    let report_path = config.out_dir.join("report.md");
    std::fs::write(&report_path, &report)
        .map_err(|e| format!("write {}: {e}", report_path.display()))?;
    eprintln!("wrote {}", report_path.display());

    println!(
        "done: {} tokens, {} lookup entries, {} conflicts, min path match {:.2}%",
        table.tokens.len(),
        table.lookup.len(),
        table.conflicts.len(),
        min_match_rate * 100.0
    );
    Ok(())
}
