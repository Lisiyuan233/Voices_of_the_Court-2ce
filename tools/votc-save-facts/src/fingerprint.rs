//! 有限 sourceFingerprint 与 snapshotId（实施计划 Task 3 步骤 5）。
//!
//! fingerprint = SHA-256( domain || file size || envelope header ||
//! 有界 head/middle/tail segments )，不 hash 整个文件，不含路径。
//! domain 与段长**已冻结**（Task 5 步骤 1）：修改即跨版本指纹碰撞，
//! 必须递增 domain 版本并同步 fixtures/README。

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};

use sha2::{Digest, Sha256};

/// 算法版本 domain separator（已冻结）。算法调整时递增，避免跨版本碰撞。
const FP_DOMAIN: &[u8] = b"votc-save-facts:fp:v1\0";
const SNAPSHOT_DOMAIN: &[u8] = b"votc-save-facts:snapshot:v1\0";

/// head / middle / tail 每段采样字节数（已冻结）。
const SEGMENT_BYTES: u64 = 4096;

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn hash_segment(hasher: &mut Sha256, file: &mut File, offset: u64, len: u64) -> io::Result<()> {
    file.seek(SeekFrom::Start(offset))?;
    let mut remaining = len;
    let mut buf = [0u8; 4096];
    while remaining > 0 {
        let want = remaining.min(buf.len() as u64) as usize;
        let n = file.read(&mut buf[..want])?;
        if n == 0 {
            break; // 文件在读取间被截断：按实际读到的内容 hash
        }
        hasher.update(&buf[..n]);
        remaining -= n as u64;
    }
    Ok(())
}

/// 计算 sourceFingerprint。`header_line` 是 envelope header 原始字节
///（envelope 无法识别时为空 slice）。失败只在文件级 IO 错误时发生。
pub fn source_fingerprint(path: &std::path::Path, header_line: &[u8]) -> io::Result<String> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();

    let mut hasher = Sha256::new();
    hasher.update(FP_DOMAIN);
    hasher.update(size.to_le_bytes());
    hasher.update((header_line.len() as u64).to_le_bytes());
    hasher.update(header_line);

    if size <= SEGMENT_BYTES * 3 {
        // 小文件：三段会重叠，直接 hash 全文（有界）。
        hash_segment(&mut hasher, &mut file, 0, size)?;
    } else {
        hash_segment(&mut hasher, &mut file, 0, SEGMENT_BYTES)?;
        hash_segment(
            &mut hasher,
            &mut file,
            (size - SEGMENT_BYTES) / 2,
            SEGMENT_BYTES,
        )?;
        hash_segment(&mut hasher, &mut file, size - SEGMENT_BYTES, SEGMENT_BYTES)?;
    }
    Ok(hex_lower(&hasher.finalize()))
}

/// 由 identity 四要素推导 snapshotId（暂定算法，Task 5 冻结）。
/// 任一要素缺失时返回 None（调用方放空字符串，表示 unidentified）。
pub fn snapshot_id(
    player_character_id: Option<&str>,
    campaign_id_parts: Option<[u64; 4]>,
    snapshot_sequence: Option<u64>,
    snapshot_slot: Option<u64>,
) -> Option<String> {
    let (player, parts, sequence, slot) = match (
        player_character_id,
        campaign_id_parts,
        snapshot_sequence,
        snapshot_slot,
    ) {
        (Some(p), Some(c), Some(s), Some(l)) => (p, c, s, l),
        _ => return None,
    };
    let mut hasher = Sha256::new();
    hasher.update(SNAPSHOT_DOMAIN);
    let material = format!(
        "{player}|{}|{}|{}|{}|{sequence}|{slot}",
        parts[0], parts[1], parts[2], parts[3]
    );
    hasher.update(material.as_bytes());
    Some(hex_lower(&hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp(tag: &str, content: &[u8]) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("votc-fp-{tag}-{}-{nanos}.ck3", std::process::id()));
        let mut f = File::create(&path).unwrap();
        f.write_all(content).unwrap();
        path
    }

    #[test]
    fn fingerprint_is_stable_and_content_sensitive() {
        let a = write_temp("a", b"SAV0100aaaabbbb00000000\nmeta_data={}\n");
        let b = write_temp("b", b"SAV0100aaaabbbb00000000\nmeta_data={ }\n");
        let fa1 = source_fingerprint(&a, b"SAV0100aaaabbbb00000000\n").unwrap();
        let fa2 = source_fingerprint(&a, b"SAV0100aaaabbbb00000000\n").unwrap();
        let fb = source_fingerprint(&b, b"SAV0100aaaabbbb00000000\n").unwrap();
        assert_eq!(fa1, fa2, "same file must fingerprint identically");
        assert_ne!(fa1, fb, "content change must change fingerprint");
        assert_eq!(fa1.len(), 64);
        assert!(fa1.chars().all(|c| c.is_ascii_hexdigit()));
        let _ = std::fs::remove_file(&a);
        let _ = std::fs::remove_file(&b);
    }

    #[test]
    fn fingerprint_depends_on_header_line() {
        let a = write_temp("h", b"body");
        let f1 = source_fingerprint(&a, b"head1").unwrap();
        let f2 = source_fingerprint(&a, b"head2").unwrap();
        assert_ne!(f1, f2);
        let _ = std::fs::remove_file(&a);
    }

    #[test]
    fn snapshot_id_requires_all_four_parts() {
        let id = snapshot_id(Some("1001"), Some([1, 2, 3, 4]), Some(17), Some(0)).unwrap();
        assert_eq!(id.len(), 64);
        assert_eq!(
            id,
            snapshot_id(Some("1001"), Some([1, 2, 3, 4]), Some(17), Some(0)).unwrap()
        );
        assert_ne!(
            id,
            snapshot_id(Some("1001"), Some([1, 2, 3, 4]), Some(18), Some(0)).unwrap()
        );
        assert!(snapshot_id(None, Some([1, 2, 3, 4]), Some(17), Some(0)).is_none());
        assert!(snapshot_id(Some("1001"), None, Some(17), Some(0)).is_none());
        assert!(snapshot_id(Some("1001"), Some([1, 2, 3, 4]), None, Some(0)).is_none());
        assert!(snapshot_id(Some("1001"), Some([1, 2, 3, 4]), Some(17), None).is_none());
    }
}
