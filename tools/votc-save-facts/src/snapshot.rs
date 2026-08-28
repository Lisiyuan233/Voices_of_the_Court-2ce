//! Exact-content binding for protocol-v2 verification.
//!
//! The caller-provided path is opened once after containment validation and
//! copied through that handle into a bounded, process-private temporary
//! artifact. Envelope inspection, fingerprinting, identity extraction and
//! typed checks all use the artifact, never the original path. The original
//! file identity/size/timestamps and bounded fingerprint are checked again
//! before any evidence is returned.

use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::ErrorCode;
use crate::limits;

const SNAPSHOT_OVERHEAD_BYTES: u64 = 8 * 1024 * 1024;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileStamp {
    len: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    platform: PlatformFileIdentity,
}

#[cfg(unix)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct PlatformFileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct PlatformFileIdentity;

#[cfg(not(any(unix, windows)))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct PlatformFileIdentity;

impl FileStamp {
    fn from_metadata(metadata: &Metadata) -> Self {
        Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            created: metadata.created().ok(),
            platform: platform_file_identity(metadata),
        }
    }
}

#[cfg(unix)]
fn platform_file_identity(metadata: &Metadata) -> PlatformFileIdentity {
    use std::os::unix::fs::MetadataExt;
    PlatformFileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    }
}

#[cfg(windows)]
fn platform_file_identity(_metadata: &Metadata) -> PlatformFileIdentity {
    // Stable Rust does not yet expose the Windows by-handle file index APIs.
    // The exact evidence still comes exclusively from the private artifact;
    // path replacement is detected by canonical path, length, creation/write
    // timestamps and the final bounded source fingerprint checks.
    PlatformFileIdentity
}

#[cfg(not(any(unix, windows)))]
fn platform_file_identity(_metadata: &Metadata) -> PlatformFileIdentity {
    PlatformFileIdentity
}

pub(crate) struct TempArtifact {
    path: PathBuf,
}

impl TempArtifact {
    fn create(tag: &str) -> io::Result<(Self, File)> {
        let temp_root = std::env::temp_dir();
        for _ in 0..32 {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = temp_root.join(format!(
                "votc-save-facts-{tag}-{}-{nanos}-{sequence}.tmp",
                std::process::id()
            ));
            let mut options = OpenOptions::new();
            options.read(true).write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(&path) {
                Ok(file) => return Ok((Self { path }, file)),
                Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(err) => return Err(err),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not allocate private verification artifact",
        ))
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn open(&self) -> io::Result<File> {
        File::open(&self.path)
    }
}

impl Drop for TempArtifact {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub(crate) struct BoundSnapshot {
    requested_input: PathBuf,
    canonical_input: PathBuf,
    source_stamp: FileStamp,
    raw: TempArtifact,
}

impl BoundSnapshot {
    pub(crate) fn capture(
        requested_input: &Path,
        allowed_root: &Path,
        requested_decompressed_cap: u64,
    ) -> Result<Self, ErrorCode> {
        let canonical_input = fs::canonicalize(requested_input).map_err(map_open_error)?;
        if !canonical_input.starts_with(allowed_root)
            || !canonical_input
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("ck3"))
        {
            return Err(ErrorCode::SaveReadDenied);
        }

        let mut source = File::open(&canonical_input).map_err(map_open_error)?;
        let source_metadata = source.metadata().map_err(map_open_error)?;
        if !source_metadata.is_file() {
            return Err(ErrorCode::SaveReadDenied);
        }
        let source_stamp = FileStamp::from_metadata(&source_metadata);
        let raw_cap = requested_decompressed_cap
            .saturating_add(SNAPSHOT_OVERHEAD_BYTES)
            .min(limits::HARD_MAX_DECOMPRESSED_BYTES + SNAPSHOT_OVERHEAD_BYTES);
        if source_stamp.len > raw_cap {
            return Err(ErrorCode::SaveLimitExceeded);
        }

        let (raw, mut destination) =
            TempArtifact::create("raw").map_err(|_| ErrorCode::SaveReadDenied)?;
        copy_bounded(&mut source, &mut destination, raw_cap)?;
        destination.flush().map_err(|_| ErrorCode::SaveReadDenied)?;
        if destination
            .metadata()
            .map_err(|_| ErrorCode::SaveReadDenied)?
            .len()
            != source_stamp.len
        {
            return Err(ErrorCode::SaveNotStable);
        }

        let handle_stamp =
            FileStamp::from_metadata(&source.metadata().map_err(|_| ErrorCode::SaveNotStable)?);
        let path_stamp = FileStamp::from_metadata(
            &fs::metadata(&canonical_input).map_err(|_| ErrorCode::SaveNotStable)?,
        );
        if handle_stamp != source_stamp || path_stamp != source_stamp {
            return Err(ErrorCode::SaveNotStable);
        }

        Ok(Self {
            requested_input: requested_input.to_path_buf(),
            canonical_input,
            source_stamp,
            raw,
        })
    }

    pub(crate) fn raw_path(&self) -> &Path {
        self.raw.path()
    }

    pub(crate) fn materialize_gamestate(
        &self,
        mut reader: impl Read,
        max_decompressed_bytes: u64,
    ) -> Result<TempArtifact, ErrorCode> {
        let (artifact, mut destination) =
            TempArtifact::create("gamestate").map_err(|_| ErrorCode::SaveReadDenied)?;
        copy_bounded(&mut reader, &mut destination, max_decompressed_bytes)?;
        destination.flush().map_err(|_| ErrorCode::SaveReadDenied)?;
        Ok(artifact)
    }

    pub(crate) fn revalidate_source(
        &self,
        header_line: &[u8],
        snapshot_fingerprint: &str,
    ) -> Result<(), ErrorCode> {
        let canonical_now =
            fs::canonicalize(&self.requested_input).map_err(|_| ErrorCode::SaveNotStable)?;
        if canonical_now != self.canonical_input {
            return Err(ErrorCode::SaveNotStable);
        }
        let stamp = FileStamp::from_metadata(
            &fs::metadata(&self.canonical_input).map_err(|_| ErrorCode::SaveNotStable)?,
        );
        if stamp != self.source_stamp {
            return Err(ErrorCode::SaveNotStable);
        }
        let current_fingerprint =
            crate::fingerprint::source_fingerprint(&self.canonical_input, header_line)
                .map_err(|_| ErrorCode::SaveNotStable)?;
        if current_fingerprint != snapshot_fingerprint {
            return Err(ErrorCode::SaveNotStable);
        }
        let artifact_fingerprint =
            crate::fingerprint::source_fingerprint(self.raw.path(), header_line)
                .map_err(|_| ErrorCode::SaveNotStable)?;
        if artifact_fingerprint != snapshot_fingerprint {
            return Err(ErrorCode::SaveNotStable);
        }
        Ok(())
    }
}

fn copy_bounded(
    source: &mut impl Read,
    destination: &mut File,
    cap: u64,
) -> Result<u64, ErrorCode> {
    let mut copied = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let remaining = cap.saturating_sub(copied);
        if remaining == 0 {
            let mut extra = [0u8; 1];
            return match source.read(&mut extra) {
                Ok(0) => Ok(copied),
                Ok(_) => Err(ErrorCode::SaveLimitExceeded),
                Err(_) => Err(ErrorCode::SaveReadDenied),
            };
        }
        let want = remaining.min(buffer.len() as u64) as usize;
        let read = source
            .read(&mut buffer[..want])
            .map_err(|_| ErrorCode::SaveReadDenied)?;
        if read == 0 {
            return Ok(copied);
        }
        destination
            .write_all(&buffer[..read])
            .map_err(|_| ErrorCode::SaveReadDenied)?;
        copied += read as u64;
    }
}

fn map_open_error(error: io::Error) -> ErrorCode {
    match error.kind() {
        io::ErrorKind::NotFound => ErrorCode::SaveNotFound,
        io::ErrorKind::PermissionDenied => ErrorCode::SaveReadDenied,
        _ => ErrorCode::SaveReadDenied,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn final_revalidation_rejects_same_path_replacement() {
        let root = std::env::temp_dir().join(format!(
            "votc-bound-snapshot-test-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("save.ck3");
        let header = b"SAV0100aabbccdd00000000\n";
        let mut original = header.to_vec();
        original.extend_from_slice(b"meta_data={ value=111 }\n");
        fs::write(&source, &original).unwrap();

        let canonical_root = fs::canonicalize(&root).unwrap();
        let snapshot = BoundSnapshot::capture(&source, &canonical_root, 1 << 20).unwrap();
        let fingerprint =
            crate::fingerprint::source_fingerprint(snapshot.raw_path(), header).unwrap();

        let mut replacement = header.to_vec();
        replacement.extend_from_slice(b"meta_data={ value=222 }\n");
        assert_eq!(replacement.len(), original.len());
        fs::write(&source, replacement).unwrap();

        assert_eq!(
            snapshot.revalidate_source(header, &fingerprint),
            Err(ErrorCode::SaveNotStable)
        );
        drop(snapshot);
        let _ = fs::remove_file(source);
        let _ = fs::remove_dir(root);
    }
}
