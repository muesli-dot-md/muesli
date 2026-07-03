//! Parakeet TDT 0.6b v3 (int8 ONNX) model resolution and first-run download.
//!
//! Artifacts live under `<app_data>/models/parakeet-tdt-0.6b-v3/`. The directory
//! holds the file set required by `transcribe-rs`'s Parakeet ONNX engine:
//! `encoder-model.int8.onnx`, `decoder_joint-model.int8.onnx`, `nemo128.onnx`,
//! `vocab.txt`, and `config.json`.
//!
//! The artifacts are distributed by the Handy project as a single gzipped tarball
//! at `https://blob.handy.computer/parakeet-v3-int8.tar.gz` which extracts to a
//! directory named `parakeet-tdt-0.6b-v3-int8`. We download + extract it into our
//! canonical model directory.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// Directory (relative to app-data `models/`) holding the Parakeet v3 artifacts.
pub const MODEL_DIR_NAME: &str = "parakeet-tdt-0.6b-v3";

/// Source tarball for the int8 ONNX artifact set (same build Handy ships).
pub const MODEL_TARBALL_URL: &str = "https://blob.handy.computer/parakeet-v3-int8.tar.gz";

/// The ONNX/tokenizer files the `transcribe-rs` Parakeet engine expects to find
/// inside the model directory.
const REQUIRED_FILES: &[&str] = &[
    "encoder-model.int8.onnx",
    "decoder_joint-model.int8.onnx",
    "nemo128.onnx",
    "vocab.txt",
    "config.json",
];

/// Resolved on-disk locations for the Parakeet v3 model artifacts.
///
/// `transcribe-rs` loads the model from the containing *directory* (`dir`), but we
/// also track the individual files so `is_present` can verify the artifact set is
/// complete (not a half-finished download).
#[derive(Debug, Clone)]
pub struct ParakeetPaths {
    /// The model directory: `<app_data>/models/parakeet-tdt-0.6b-v3/`.
    pub dir: PathBuf,
    /// Encoder ONNX (int8): `encoder-model.int8.onnx`.
    pub encoder: PathBuf,
    /// Decoder/joiner ONNX (int8): `decoder_joint-model.int8.onnx`.
    pub decoder: PathBuf,
    /// Feature extractor / preprocessor ONNX: `nemo128.onnx`.
    #[allow(dead_code)] // part of the artifact-set contract; loaded by transcribe-rs from `dir`
    pub features: PathBuf,
    /// Tokenizer vocabulary: `vocab.txt`.
    #[allow(dead_code)]
    pub vocab: PathBuf,
    /// Model config: `config.json`.
    #[allow(dead_code)]
    pub config: PathBuf,
}

impl ParakeetPaths {
    /// Resolve the artifact paths under `<app_data>/models/parakeet-tdt-0.6b-v3/`.
    /// Pure path computation — performs no I/O.
    pub fn resolve(app_data: &Path) -> Self {
        let dir = app_data.join("models").join(MODEL_DIR_NAME);
        Self {
            encoder: dir.join("encoder-model.int8.onnx"),
            decoder: dir.join("decoder_joint-model.int8.onnx"),
            features: dir.join("nemo128.onnx"),
            vocab: dir.join("vocab.txt"),
            config: dir.join("config.json"),
            dir,
        }
    }

    /// True iff every required artifact exists on disk.
    pub fn is_present(&self) -> bool {
        REQUIRED_FILES
            .iter()
            .all(|f| self.dir.join(f).is_file())
    }

    /// Directory `transcribe-rs` should be pointed at to load the model.
    pub fn model_dir(&self) -> &Path {
        &self.dir
    }
}

/// Ensure the Parakeet v3 artifacts are present under `app_data`, downloading and
/// extracting them if absent. `progress` is called with `(downloaded_bytes,
/// total_bytes)` during the download; `total_bytes` is 0 if the server omits a
/// content length.
///
/// Returns the resolved [`ParakeetPaths`]. Idempotent: a no-op (besides building
/// the paths) when the artifacts already exist.
pub fn ensure(app_data: &Path, progress: impl Fn(u64, u64)) -> Result<ParakeetPaths> {
    let paths = ParakeetPaths::resolve(app_data);
    if paths.is_present() {
        return Ok(paths);
    }

    std::fs::create_dir_all(&paths.dir)
        .with_context(|| format!("creating model dir {}", paths.dir.display()))?;

    // Download the tarball to a temp file in the model dir, streaming with progress.
    let tmp = paths.dir.join("parakeet-v3-int8.tar.gz.partial");
    download_with_progress(MODEL_TARBALL_URL, &tmp, &progress)
        .with_context(|| format!("downloading {}", MODEL_TARBALL_URL))?;

    extract_tarball_into(&tmp, &paths.dir)
        .with_context(|| format!("extracting tarball into {}", paths.dir.display()))?;

    let _ = std::fs::remove_file(&tmp);

    if !paths.is_present() {
        anyhow::bail!(
            "model extraction finished but required artifacts are missing under {}",
            paths.dir.display()
        );
    }

    Ok(paths)
}

fn download_with_progress(url: &str, dest: &Path, progress: &impl Fn(u64, u64)) -> Result<()> {
    let resp = ureq::get(url)
        .call()
        .with_context(|| format!("GET {url}"))?;

    let total: u64 = resp
        .header("Content-Length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(dest)
        .with_context(|| format!("creating {}", dest.display()))?;

    let mut buf = [0u8; 64 * 1024];
    let mut downloaded: u64 = 0;
    loop {
        let n = std::io::Read::read(&mut reader, &mut buf)?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buf[..n])?;
        downloaded += n as u64;
        progress(downloaded, total);
    }
    std::io::Write::flush(&mut file)?;
    Ok(())
}

/// Extract a `.tar.gz` into `dest`. The Handy tarball wraps the files in a
/// `parakeet-tdt-0.6b-v3-int8/` directory; we strip that leading component so the
/// artifacts land directly in our `dest` dir. AppleDouble (`._*`) sidecar entries
/// are skipped.
fn extract_tarball_into(tarball: &Path, dest: &Path) -> Result<()> {
    let file = std::fs::File::open(tarball)
        .with_context(|| format!("opening {}", tarball.display()))?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz);

    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();

        // Strip the leading directory component (e.g. `parakeet-tdt-0.6b-v3-int8/`).
        let stripped: PathBuf = path.components().skip(1).collect();
        if stripped.as_os_str().is_empty() {
            continue;
        }

        // Skip macOS AppleDouble sidecar files (`._foo`).
        if stripped
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("._"))
            .unwrap_or(false)
        {
            continue;
        }

        let out_path = dest.join(&stripped);
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            entry.unpack(&out_path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_places_artifacts_under_model_dir() {
        let app_data = Path::new("/some/app-data");
        let p = ParakeetPaths::resolve(app_data);
        assert_eq!(
            p.dir,
            Path::new("/some/app-data/models/parakeet-tdt-0.6b-v3")
        );
        assert!(p.encoder.ends_with("encoder-model.int8.onnx"));
        assert!(p.decoder.ends_with("decoder_joint-model.int8.onnx"));
    }

    #[test]
    fn is_present_false_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let p = ParakeetPaths::resolve(dir.path());
        assert!(!p.is_present());
    }

    #[test]
    fn is_present_true_when_all_files_exist() {
        let dir = tempfile::tempdir().unwrap();
        let p = ParakeetPaths::resolve(dir.path());
        std::fs::create_dir_all(&p.dir).unwrap();
        for f in REQUIRED_FILES {
            std::fs::write(p.dir.join(f), b"x").unwrap();
        }
        assert!(p.is_present());
    }

    /// Real network download of the ~450 MB int8 artifact set into this crate's
    /// `tests/` app-data dir, so the gated Parakeet engine test can load it.
    /// Ignored by default.
    #[test]
    #[ignore = "downloads ~450 MB from blob.handy.computer"]
    fn ensure_downloads_real_model() {
        let app_data = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
        let paths = ensure(&app_data, |d, t| {
            if t > 0 && d % (16 * 1024 * 1024) < 64 * 1024 {
                eprintln!("downloaded {} / {} bytes", d, t);
            }
        })
        .unwrap();
        assert!(paths.is_present());
    }

    #[test]
    fn is_present_false_when_one_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let p = ParakeetPaths::resolve(dir.path());
        std::fs::create_dir_all(&p.dir).unwrap();
        // Write all but the last required file.
        for f in &REQUIRED_FILES[..REQUIRED_FILES.len() - 1] {
            std::fs::write(p.dir.join(f), b"x").unwrap();
        }
        assert!(!p.is_present());
    }
}
