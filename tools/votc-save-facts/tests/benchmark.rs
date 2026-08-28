//! 合成大输入 benchmark（实施计划 Task 5 步骤 5）。
//!
//! 本测试 `#[ignore]`，不进入默认测试套件。手动运行：
//!
//! ```bash
//! cargo test --manifest-path tools/votc-save-facts/Cargo.toml \
//!   --test benchmark -- --ignored --nocapture
//! ```
//!
//! 生成 ~100 MB 合成 unified text（living 块含数十万个角色，绝大多数与
//! participant 无关），测量 probe / extract 的耗时、子进程峰值 RSS
//! （Linux /proc/<pid>/status VmHWM）、输出字节与 fact 数。
//! 合成输入，不含真实存档；真实存档的 p50/p95 留待 Task 21 E2E。

mod common;

use common::*;
use std::io::Write as _;
use std::time::Instant;

/// 目标输入大小（约 100 MB）。
const TARGET_BYTES: usize = 100 * 1024 * 1024;

fn generate_big_save(path: &std::path::Path) -> u64 {
    let mut out = std::io::BufWriter::new(std::fs::File::create(path).unwrap());
    let meta = "meta_data={\n\tversion=\"1.13.0\"\n\tmeta_player_id=1001\n\tmeta_player_name=\"Placeholder Player\"\n}\n";
    let mut content = sav_header_line(0, meta.len());
    out.write_all(&content).unwrap();
    content.clear();
    out.write_all(meta.as_bytes()).unwrap();
    out.write_all(b"date=867.1.15\n").unwrap();

    // variables：完整七变量（scale=1）。
    let vars = default_vars(1);
    let mut body = String::from("variables={\n\tdata={\n");
    for (flag, raw) in &vars {
        body.push_str(&format!(
            "\t\t{{\n\t\t\tflag=\"{flag}\"\n\t\t\tdata={{\n\t\t\t\ttype=integer\n\t\t\t\tvalue={raw}\n\t\t\t}}\n\t\t}}\n"
        ));
    }
    body.push_str(&format!("\t}}\n\tsize={}\n}}\n", vars.len()));
    out.write_all(body.as_bytes()).unwrap();

    // living：participant 在最前，随后是大量无关角色。
    out.write_all(b"living={\n").unwrap();
    let participant = char_entry(
        "1001",
        "\t\tfirst_name=\"Placeholder Alpha\"\n\t\tmother=1002\n\t\tfather=1003\n\t\tspouse=1004\n\t\talive_data={\n\t\t\tliege=1005\n\t\t\tprimary_title=200\n\t\t}\n",
    );
    out.write_all(participant.as_bytes()).unwrap();

    let mut written = 0usize;
    let mut id = 2_000_000u32;
    let mut chunk = String::new();
    while written < TARGET_BYTES {
        chunk.clear();
        for _ in 0..1000 {
            id += 1;
            chunk.push_str(&char_entry(
                &id.to_string(),
                &format!(
                    "\t\tfirst_name=\"Placeholder {id}\"\n\t\tmother=99999998\n\t\tfather=99999999\n\t\tspouse=99999997\n\t\talive_data={{\n\t\t\tliege=99999996\n\t\t\tprimary_title=88\n\t\t}}\n"
                ),
            ));
        }
        written += chunk.len();
        out.write_all(chunk.as_bytes()).unwrap();
    }
    out.write_all(b"}\n").unwrap();
    out.write_all(
        landed_titles_block(&title_entry(
            "200",
            "\t\tkey=\"title_placeholder_duchy\"\n\t\tholder=1001\n",
        ))
        .as_bytes(),
    )
    .unwrap();
    out.flush().unwrap();
    std::fs::metadata(path).unwrap().len()
}

/// 轮询子进程 VmHWM（Linux /proc），返回峰值 KB。
struct RssSampler {
    peak_kb: u64,
}

#[cfg(target_os = "linux")]
fn sample_rss_kilobytes(pid: u32) -> Option<u64> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmHWM:") {
            return rest
                .trim()
                .strip_suffix("kB")
                .and_then(|v| v.trim().parse::<u64>().ok());
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn sample(sampler: &mut RssSampler, pid: u32) {
    if let Some(kb) = sample_rss_kilobytes(pid) {
        sampler.peak_kb = sampler.peak_kb.max(kb);
    }
}

#[cfg(not(target_os = "linux"))]
fn sample(_sampler: &mut RssSampler, _pid: u32) {}

fn run_timed(args: &[String], stdin: &[u8]) -> (std::process::Output, u128, RssSampler) {
    let start = Instant::now();
    let mut child = std::process::Command::new(binary_path_for_bench())
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let pid = child.id();
    let mut sampler = RssSampler { peak_kb: 0 };
    let mut stdin_pipe = child.stdin.take().unwrap();
    let _ = stdin_pipe.write_all(stdin);
    drop(stdin_pipe);
    loop {
        sample(&mut sampler, pid);
        match child.try_wait().unwrap() {
            Some(_) => break,
            None => std::thread::sleep(std::time::Duration::from_millis(20)),
        }
    }
    let out = child.wait_with_output().unwrap();
    (out, start.elapsed().as_millis(), sampler)
}

fn binary_path_for_bench() -> std::path::PathBuf {
    // host target 下是原生 Linux 可执行文件，直接可用。
    std::path::PathBuf::from(
        std::env::var("CARGO_BIN_EXE_votc-save-facts")
            .unwrap_or_else(|_| env!("CARGO_BIN_EXE_votc-save-facts").to_string()),
    )
}

#[test]
#[ignore = "benchmark: 手动运行，见文件头注释"]
fn benchmark_synthetic_100mb_unified_text() {
    let dir = TempDir::new("bench");
    let save_path = dir.path().join("big.ck3");

    let gen_start = Instant::now();
    let size = generate_big_save(&save_path);
    let gen_ms = gen_start.elapsed().as_millis();

    let probe_req = valid_request("probe");
    let (probe_out, probe_ms, _) =
        run_timed(&probe_args(&save_path, dir.path()), probe_req.as_bytes());
    assert!(probe_out.status.success());
    let probe_json: serde_json::Value =
        serde_json::from_slice(&probe_out.stdout[..probe_out.stdout.len() - 1]).unwrap();
    assert_eq!(probe_json["status"], "ok");

    // 100 MB unified text 的解压流就是文件本身：request 的 decompressed
    // 预算必须 ≥ 文件大小，这里用足 512 MiB 硬上限。
    let extract_req = {
        let mut req: serde_json::Value =
            serde_json::from_str(&extract_request(&["1001"], &["family", "realm"])).unwrap();
        req["limits"]["maxDecompressedBytes"] = serde_json::json!(512u64 * 1024 * 1024);
        req.to_string()
    };
    let (extract_out, extract_ms, rss) = run_timed(
        &extract_args(&save_path, dir.path()),
        extract_req.as_bytes(),
    );
    assert!(extract_out.status.success());
    let extract_json: serde_json::Value =
        serde_json::from_slice(&extract_out.stdout[..extract_out.stdout.len() - 1]).unwrap();

    eprintln!("=== benchmark (synthetic unified text) ===");
    eprintln!(
        "input bytes:            {size} ({:.1} MiB)",
        size as f64 / 1048576.0
    );
    eprintln!("generation time:        {gen_ms} ms");
    eprintln!(
        "probe:                  {probe_ms} ms, stdout {} bytes",
        probe_out.stdout.len()
    );
    eprintln!(
        "probe status/scanned:   {} / {:?} bytes",
        probe_json["status"], probe_json["metrics"]["scannedBytes"]
    );
    eprintln!(
        "extract:                {extract_ms} ms, stdout {} bytes",
        extract_out.stdout.len()
    );
    eprintln!("extract status:         {}", extract_json["status"]);
    eprintln!(
        "extract facts/entities: {} / {}",
        extract_json["metrics"]["emittedFacts"], extract_json["metrics"]["emittedEntities"]
    );
    eprintln!(
        "extract peak RSS:       {} KiB (VmHWM, Linux /proc)",
        rss.peak_kb
    );
    eprintln!("extract warnings:       {}", extract_json["warnings"]);

    // 硬性门槛：extract 必须远低于 App 侧 15 秒硬截止；RSS < 512 MB。
    assert!(extract_ms < 15_000, "extract too slow: {extract_ms} ms");
    assert!(
        rss.peak_kb < 512 * 1024,
        "RSS over budget: {} KiB",
        rss.peak_kb
    );
}
