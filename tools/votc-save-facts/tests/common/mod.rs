//! envelope/identity 集成测试共享辅助：临时目录、进程执行、请求构造、
//! SAV header 与最小 ZIP（deflate entries）合成。
//!
//! 每个集成测试文件独立编译本模块，未用到的辅助属正常。
#![allow(dead_code)]

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_OUTPUT: &str = "2097152";

pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "votc-sf-task3-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn s(path: &Path) -> String {
    path.to_str().unwrap().to_string()
}

pub fn fixtures_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR 在 WSL 交叉编译下是 /mnt/<drive>/... 形式，
    // Windows 测试进程同样需要转换。
    wsl_to_windows_path(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .to_string_lossy(),
    )
}

fn binary_path() -> PathBuf {
    // 与 tests/sidecar.rs 相同的 WSL 交叉编译路径转换。
    let raw = std::env::var("CARGO_BIN_EXE_votc-save-facts")
        .unwrap_or_else(|_| env!("CARGO_BIN_EXE_votc-save-facts").to_string());
    wsl_to_windows_path(&raw)
}

#[cfg(windows)]
fn wsl_to_windows_path(raw: &str) -> PathBuf {
    if let Some(rest) = raw.strip_prefix("/mnt/") {
        let mut chars = rest.chars();
        if let (Some(drive), Some('/')) = (chars.next(), chars.next()) {
            if drive.is_ascii_alphabetic() {
                let tail: String = chars.collect();
                return PathBuf::from(format!("{}:\\{}", drive, tail.replace('/', "\\")));
            }
        }
    }
    PathBuf::from(raw)
}

#[cfg(not(windows))]
fn wsl_to_windows_path(raw: &str) -> PathBuf {
    PathBuf::from(raw)
}

pub fn run_sidecar(args: &[String], stdin_bytes: &[u8]) -> Output {
    let mut child = Command::new(binary_path())
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let _ = stdin.write_all(stdin_bytes);
    drop(stdin);
    child.wait_with_output().unwrap()
}

pub fn probe_args(input: &Path, root: &Path) -> Vec<String> {
    vec![
        "probe".into(),
        "--input".into(),
        s(input),
        "--allowed-root".into(),
        s(root),
        "--max-output-bytes".into(),
        MAX_OUTPUT.into(),
    ]
}

pub fn extract_args(input: &Path, root: &Path) -> Vec<String> {
    let mut args = probe_args(input, root);
    args[0] = "extract".into();
    args
}

/// 合法请求：decompressed 预算 64 MiB（≤ 512 MiB 硬上限）。
pub fn valid_request(op: &str) -> String {
    serde_json::json!({
        "protocolVersion": 2,
        "operation": op,
        "expected": {
            "playerCharacterId": "1001",
            "participantCharacterIds": ["1002"],
            "gameDateNumeric": 316470,
            "campaignId": "placeholder",
            "campaignIdParts": [111, 222, 333, 444],
            "snapshotSequence": 17,
            "snapshotSlot": 0
        },
        "categories": ["identity"],
        "limits": {
            "maxFacts": 100,
            "maxEntities": 50,
            "maxRelatedCharacters": 20,
            "maxOutputBytes": 2097152,
            "maxDecompressedBytes": 67108864,
            "maxNestingDepth": 64,
            "maxScalarBytes": 4096
        }
    })
    .to_string()
}

pub fn probe_json(input: &Path, root: &Path) -> (Output, serde_json::Value) {
    let out = run_sidecar(&probe_args(input, root), valid_request("probe").as_bytes());
    assert!(
        out.status.success(),
        "probe must exit 0 (stderr: {})",
        String::from_utf8_lossy(&out.stderr)
    );
    let v = serde_json::from_slice::<serde_json::Value>(&out.stdout[..out.stdout.len() - 1])
        .expect("stdout must be one complete JSON document");
    (out, v)
}

// ---------------------------------------------------------------------------
// 文件合成
// ---------------------------------------------------------------------------

/// SAV header 行：`SAV` + version hex(01) + kind hex + 8 random + meta_len hex + \n。
pub fn sav_header_line(kind: u8, meta_len: usize) -> Vec<u8> {
    format!("SAV01{kind:02x}aabbccdd{meta_len:08x}\n").into_bytes()
}

pub fn write_file(dir: &Path, name: &str, content: &[u8]) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, content).unwrap();
    path
}

pub struct ZipEntrySpec<'a> {
    pub name: &'a [u8],
    pub data: &'a [u8],
    /// 覆盖 central directory 声明的 uncompressed size（zip bomb 测试用）。
    pub declared_uncompressed: Option<u32>,
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

/// 最小 ZIP（deflate 压缩；jomini envelope 只支持 deflate entry）。
pub fn build_zip(entries: &[ZipEntrySpec]) -> Vec<u8> {
    use flate2::write::DeflateEncoder;
    use std::io::Write as _;

    let mut out = Vec::new();
    let mut central = Vec::new();
    for e in entries {
        let mut encoder = DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(e.data).unwrap();
        let compressed = encoder.finish().unwrap();

        let offset = out.len() as u32;
        let crc = crc32(e.data);
        let uncomp = e.declared_uncompressed.unwrap_or(e.data.len() as u32);

        out.extend_from_slice(b"PK\x03\x04");
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&8u16.to_le_bytes()); // method = deflate
        out.extend_from_slice(&0u16.to_le_bytes()); // time
        out.extend_from_slice(&0u16.to_le_bytes()); // date
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        out.extend_from_slice(&uncomp.to_le_bytes());
        out.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra len
        out.extend_from_slice(e.name);
        out.extend_from_slice(&compressed);

        central.extend_from_slice(b"PK\x01\x02");
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&8u16.to_le_bytes()); // method = deflate
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        central.extend_from_slice(&uncomp.to_le_bytes());
        central.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra
        central.extend_from_slice(&0u16.to_le_bytes()); // comment
        central.extend_from_slice(&0u16.to_le_bytes()); // disk
        central.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        central.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(e.name);
    }
    let cd_offset = out.len() as u32;
    let cd_size = central.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(b"PK\x05\x06");
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

/// SAV0102 风格 prefixed ZIP：header + inline meta + zip（local header 不在
/// offset 0）。
pub fn build_prefixed_zip_save(kind: u8, inline_meta: &[u8], zip: &[u8]) -> Vec<u8> {
    let mut out = sav_header_line(kind, inline_meta.len());
    out.extend_from_slice(inline_meta);
    out.extend_from_slice(zip);
    out
}

/// 与 static fixture 同结构的 gamestate 文本（可改变量 raw 值）。
pub fn gamestate_text(version: &str, player_id: &str, date: &str, vars: &[(&str, i64)]) -> String {
    let mut text = format!(
        "meta_data={{\n\tversion=\"{version}\"\n\tmeta_player_id={player_id}\n\tmeta_player_name=\"Placeholder Player\"\n}}\ndate={date}\n"
    );
    if !vars.is_empty() {
        text.push_str("variables={\n\tdata={\n");
        for (flag, raw) in vars {
            text.push_str(&format!(
                "\t\t{{\n\t\t\tflag=\"{flag}\"\n\t\t\tdata={{\n\t\t\t\ttype=integer\n\t\t\t\tvalue={raw}\n\t\t\t}}\n\t\t}}\n"
            ));
        }
        text.push_str(&format!("\t}}\n\tsize={}\n}}\n", vars.len()));
    }
    text.push_str("living={\n\t9999={\n\t\talive_data={\n\t\t}\n\t}\n}\n");
    text
}

/// 默认七变量组合（假定 scale=1000：protocol raw=1000 → protocol=1）。
pub fn default_vars(scale: i64) -> Vec<(&'static str, i64)> {
    vec![
        ("votc_campaign_id_a", 111 * scale),
        ("votc_campaign_id_b", 222 * scale),
        ("votc_campaign_id_c", 333 * scale),
        ("votc_campaign_id_d", 444 * scale),
        ("votc_save_snapshot_protocol", scale),
        ("votc_save_snapshot_sequence", 17 * scale),
        ("votc_save_snapshot_slot", 0),
    ]
}

// ---------------------------------------------------------------------------
// Task 4：extract 测试辅助
// ---------------------------------------------------------------------------

/// meta_data + date + variables + 自定义附加块组成的 gamestate 文本。
pub fn gamestate_blocks(vars: &[(&str, i64)], extra_blocks: &str) -> String {
    let mut text = String::from(
        "meta_data={\n\tversion=\"1.13.0\"\n\tmeta_player_id=1001\n\tmeta_player_name=\"Placeholder Player\"\n}\ndate=867.1.15\n",
    );
    if !vars.is_empty() {
        text.push_str("variables={\n\tdata={\n");
        for (flag, raw) in vars {
            text.push_str(&format!(
                "\t\t{{\n\t\t\tflag=\"{flag}\"\n\t\t\tdata={{\n\t\t\t\ttype=integer\n\t\t\t\tvalue={raw}\n\t\t\t}}\n\t\t}}\n"
            ));
        }
        text.push_str(&format!("\t}}\n\tsize={}\n}}\n", vars.len()));
    }
    text.push_str(extra_blocks);
    text
}

/// living 块内的一个角色条目。`fields` 每行自带缩进与换行。
pub fn char_entry(id: &str, fields: &str) -> String {
    format!("\t{id}={{\n{fields}\t}}\n")
}

pub fn living_block(entries: &str) -> String {
    format!("living={{\n{entries}}}\n")
}

pub fn title_entry(id: &str, fields: &str) -> String {
    format!("\t{id}={{\n{fields}\t}}\n")
}

pub fn landed_titles_block(entries: &str) -> String {
    format!("landed_titles={{\n{entries}}}\n")
}

pub fn extract_request_with_limits(
    participants: &[&str],
    categories: &[&str],
    max_facts: u64,
    max_entities: u64,
    max_related: u64,
) -> String {
    serde_json::json!({
        "protocolVersion": 2,
        "operation": "extract",
        "expected": {
            "playerCharacterId": "1001",
            "participantCharacterIds": participants,
            "gameDateNumeric": 316470,
            "campaignId": "placeholder",
            "campaignIdParts": [111, 222, 333, 444],
            "snapshotSequence": 17,
            "snapshotSlot": 0
        },
        "categories": categories,
        "limits": {
            "maxFacts": max_facts,
            "maxEntities": max_entities,
            "maxRelatedCharacters": max_related,
            "maxOutputBytes": 2097152,
            "maxDecompressedBytes": 67108864,
            "maxNestingDepth": 64,
            "maxScalarBytes": 4096
        }
    })
    .to_string()
}

pub fn extract_request(participants: &[&str], categories: &[&str]) -> String {
    extract_request_with_limits(participants, categories, 500, 250, 100)
}

pub fn extract_json(input: &Path, root: &Path, request: &str) -> serde_json::Value {
    let out = run_sidecar(&extract_args(input, root), request.as_bytes());
    assert!(
        out.status.success(),
        "extract must exit 0 (stderr: {})",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice::<serde_json::Value>(&out.stdout[..out.stdout.len() - 1])
        .expect("stdout must be one complete JSON document")
}

pub fn extract_on_body(dir: &TempDir, name: &str, body: &str, request: &str) -> serde_json::Value {
    let meta_len = body.find("}\n").map(|i| i + 2).unwrap_or(body.len());
    let mut content = sav_header_line(0, meta_len);
    content.extend_from_slice(body.as_bytes());
    let path = write_file(dir.path(), name, &content);
    extract_json(&path, dir.path(), request)
}

pub fn warning_codes_of(v: &serde_json::Value) -> Vec<String> {
    v["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["code"].as_str().unwrap().to_string())
        .collect()
}

/// facts 数组中匹配 predicate 的子集（保持输出顺序）。
pub fn facts_with<'a>(v: &'a serde_json::Value, predicate: &str) -> Vec<&'a serde_json::Value> {
    v["facts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["predicate"] == predicate)
        .collect()
}

pub fn entity_ids(v: &serde_json::Value, entity_type: &str) -> Vec<String> {
    v["entities"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["type"] == entity_type)
        .map(|e| e["id"].as_str().unwrap().to_string())
        .collect()
}
