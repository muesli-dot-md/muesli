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
    #[allow(dead_code)] // part of the artifact-set contract; verified via REQUIRED_FILES
    pub encoder: PathBuf,
    /// Decoder/joiner ONNX (int8): `decoder_joint-model.int8.onnx`.
    #[allow(dead_code)] // part of the artifact-set contract; verified via REQUIRED_FILES
    pub decoder: PathBuf,
    /// Feature extractor / preprocessor ONNX: `nemo128.onnx`.
    #[allow(dead_code)]
    // part of the artifact-set contract; loaded by transcribe-rs from `dir`
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
        REQUIRED_FILES.iter().all(|f| self.dir.join(f).is_file())
    }

    /// Directory `transcribe-rs` should be pointed at to load the model.
    pub fn model_dir(&self) -> &Path {
        &self.dir
    }
}

// ---------------------------------------------------------------------------
// CoreML (ANE) bundle — resolution, completeness gate, and both-sets download
// ---------------------------------------------------------------------------

/// Directory name of the FluidAudio CoreML bundle. Same model, so it matches the
/// ONNX [`MODEL_DIR_NAME`]; the two sets live under different roots (app-data for
/// ONNX, FluidAudio's cache for CoreML), not the same directory.
#[cfg_attr(not(feature = "ane"), allow(dead_code))]
pub const COREML_MODEL_DIR_NAME: &str = "parakeet-tdt-0.6b-v3";

/// The compiled CoreML models in the bundle. Each is a `.mlmodelc` *directory*
/// (spike section 14), so the completeness gate checks directory — not file —
/// presence. Single source of truth for both the selection gate
/// (`stt::fluidaudio::coreml_bundle_present`) and the download below.
#[cfg_attr(not(feature = "ane"), allow(dead_code))]
pub const COREML_REQUIRED_DIRS: &[&str] = &[
    "Encoder.mlmodelc",
    "Decoder.mlmodelc",
    "JointDecisionv3.mlmodelc",
    "Preprocessor.mlmodelc",
];

/// The loose support files that ship alongside the compiled models.
#[cfg_attr(not(feature = "ane"), allow(dead_code))]
pub const COREML_REQUIRED_FILES: &[&str] = &[
    "parakeet_v3_vocab.json",
    "parakeet_vocab.json",
    "config.json",
];

/// HuggingFace repo hosting the CoreML bundle (`FluidInference/…-coreml`).
/// FluidAudio auto-downloads from here; we drive our own multi-file download of
/// the same repo so `model://progress` stays honest (spike section 14, mechanism 1).
#[cfg(feature = "ane")]
const COREML_HF_REPO: &str = "FluidInference/parakeet-tdt-0.6b-v3-coreml";

/// Resolved on-disk location of the FluidAudio CoreML bundle — the ANE analogue
/// of [`ParakeetPaths`].
///
/// `fluidaudio-rs` 0.14.1 loads only from FluidAudio's default cache root, so
/// `resolve` takes that root and our download pre-populates `dir` beneath it. The
/// type is un-feature-gated so its path/completeness tests run on Linux CI; only
/// the *download* is gated on `ane`.
#[derive(Debug, Clone)]
#[cfg_attr(not(feature = "ane"), allow(dead_code))]
pub struct CoremlPaths {
    /// The bundle directory: `<models_root>/parakeet-tdt-0.6b-v3/`.
    pub dir: PathBuf,
}

#[cfg_attr(not(feature = "ane"), allow(dead_code))]
impl CoremlPaths {
    /// Resolve the bundle directory under FluidAudio's models `root`. Pure path
    /// computation — no I/O.
    pub fn resolve(root: &Path) -> Self {
        Self {
            dir: root.join(COREML_MODEL_DIR_NAME),
        }
    }

    /// True iff every required compiled-model directory and support file exists.
    /// A partial download (some artifacts missing) reads as absent, so selection
    /// never picks ANE over an incomplete bundle.
    pub fn is_present(&self) -> bool {
        COREML_REQUIRED_DIRS
            .iter()
            .all(|d| self.dir.join(d).is_dir())
            && COREML_REQUIRED_FILES
                .iter()
                .all(|f| self.dir.join(f).is_file())
    }
}

/// FluidAudio's default models root (`~/Library/Application Support/FluidAudio/
/// Models/`), the only path `fluidaudio-rs` 0.14.1 loads from. `None` if the home
/// directory cannot be resolved.
#[cfg_attr(not(feature = "ane"), allow(dead_code))]
pub fn fluidaudio_models_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| {
        h.join("Library")
            .join("Application Support")
            .join("FluidAudio")
            .join("Models")
    })
}

/// Ensure BOTH model sets are present for an `ane` build, reporting one monotonic
/// `model://progress` sweep. The ONNX tarball is fetched **first** so the ONNX
/// fallback engine is always on disk before CoreML is attempted (design section 7
/// download decision); a CoreML failure then degrades to exactly today's ONNX
/// behavior.
///
/// Progress is a single combined sweep: both totals are discovered up front (ONNX
/// via a HEAD, CoreML via the HuggingFace file manifest) so `done` climbs from 0
/// to `onnx_total + coreml_total` across the two phases without resetting.
#[cfg(feature = "ane")]
pub fn ensure_both(app_data: &Path, coreml_root: &Path, progress: impl Fn(u64, u64)) -> Result<()> {
    let onnx = ParakeetPaths::resolve(app_data);
    let coreml = CoremlPaths::resolve(coreml_root);

    // Discover both totals before downloading anything so the two phases stream
    // as one monotonic sweep. An already-present set contributes 0 to download.
    let onnx_total = if onnx.is_present() {
        0
    } else {
        remote_content_length(MODEL_TARBALL_URL).unwrap_or(0)
    };
    let coreml_files = if coreml.is_present() {
        Vec::new()
    } else {
        fetch_coreml_manifest().context("fetching CoreML model manifest")?
    };
    let coreml_total: u64 = coreml_files.iter().map(|f| f.size).sum();
    let combined = onnx_total + coreml_total;

    // The totals above are best-effort (a HEAD may omit Content-Length and
    // report 0), so clamp what we emit: `done` never regresses across the two
    // phases and the reported total is never smaller than `done`.
    let high_water = std::cell::Cell::new(0u64);
    let progress = |done: u64, total: u64| {
        let done = high_water.get().max(done);
        high_water.set(done);
        progress(done, total.max(done));
    };

    // Phase 1 — ONNX first, guaranteeing the fallback engine can always load.
    if !onnx.is_present() {
        ensure(app_data, |done, _| progress(done, combined))
            .context("downloading ONNX model set")?;
    }

    // Phase 2 — CoreML bundle, offset so `done` keeps climbing past `onnx_total`.
    if !coreml.is_present() {
        download_coreml(&coreml.dir, &coreml_files, |done| {
            progress(onnx_total + done, combined)
        })
        .context("downloading CoreML model bundle")?;
        if !coreml.is_present() {
            anyhow::bail!(
                "CoreML download finished but artifacts are missing under {}",
                coreml.dir.display()
            );
        }
    }

    Ok(())
}

/// One file in the CoreML bundle's HuggingFace tree.
#[cfg(feature = "ane")]
struct CoremlFile {
    /// Repo-relative path, e.g. `Encoder.mlmodelc/coremldata.bin`.
    path: String,
    /// Size in bytes, for the aggregate progress total.
    size: u64,
}

/// Whether a repo-relative path belongs to the artifact set we actually load.
/// The repo also ships many unrelated variants (Int4 encoders, older JointDecision
/// versions, `.mlpackage` sources, a MelEncoder, ~3 GB in total), so we download
/// ONLY the files under a required `.mlmodelc` directory plus the loose support
/// files — the ~470 MB subset FluidAudio's own loader uses.
#[cfg(feature = "ane")]
fn is_required_coreml_path(path: &str) -> bool {
    // Defense in depth: the manifest is joined onto our model dir, so refuse
    // any entry that is not made purely of normal components (no `..`, no
    // roots), even though the HF tree API should never produce one.
    let all_normal = Path::new(path)
        .components()
        .all(|c| matches!(c, std::path::Component::Normal(_)));
    if !all_normal {
        return false;
    }
    let top = path.split('/').next().unwrap_or(path);
    COREML_REQUIRED_DIRS.contains(&top) || COREML_REQUIRED_FILES.contains(&path)
}

/// Fetch the file list for the CoreML bundle from the HuggingFace tree API,
/// filtered to the required-artifact subset. Directories are skipped; only leaf
/// files carry sizes and are fetched.
#[cfg(feature = "ane")]
fn fetch_coreml_manifest() -> Result<Vec<CoremlFile>> {
    #[derive(serde::Deserialize)]
    struct HfTreeEntry {
        #[serde(rename = "type")]
        kind: String,
        path: String,
        #[serde(default)]
        size: u64,
    }

    let url =
        format!("https://huggingface.co/api/models/{COREML_HF_REPO}/tree/main?recursive=true");
    // Parse via serde_json rather than ureq's `into_json` so we need no extra ureq
    // feature (serde_json is already a dependency).
    let body = ureq::get(&url)
        .call()
        .with_context(|| format!("GET {url}"))?
        .into_string()
        .context("reading HuggingFace tree response")?;
    let entries: Vec<HfTreeEntry> =
        serde_json::from_str(&body).context("parsing HuggingFace tree JSON")?;

    let files: Vec<CoremlFile> = entries
        .into_iter()
        .filter(|e| e.kind == "file" && is_required_coreml_path(&e.path))
        .map(|e| CoremlFile {
            path: e.path,
            size: e.size,
        })
        .collect();

    if files.is_empty() {
        anyhow::bail!("HuggingFace manifest for {COREML_HF_REPO} listed no required CoreML files");
    }
    Ok(files)
}

/// Download every file of the CoreML bundle into `dir`, recreating the repo's
/// nested layout (so each `.mlmodelc` lands as a real directory). `progress` is
/// called with the running byte count across all files.
#[cfg(feature = "ane")]
fn download_coreml(dir: &Path, files: &[CoremlFile], progress: impl Fn(u64)) -> Result<()> {
    std::fs::create_dir_all(dir)
        .with_context(|| format!("creating CoreML dir {}", dir.display()))?;

    let mut done: u64 = 0;
    for f in files {
        let url = format!(
            "https://huggingface.co/{COREML_HF_REPO}/resolve/main/{}",
            f.path
        );
        let dest = dir.join(&f.path);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }

        let resp = ureq::get(&url)
            .call()
            .with_context(|| format!("GET {url}"))?;
        let mut reader = resp.into_reader();
        // Stream to a sidecar and rename only once the file is complete, so an
        // interrupted download can never leave a truncated file that
        // `is_present` would mistake for a healthy bundle.
        let tmp = dest.with_file_name(format!(
            "{}.partial",
            dest.file_name().and_then(|n| n.to_str()).unwrap_or("file")
        ));
        let mut file =
            std::fs::File::create(&tmp).with_context(|| format!("creating {}", tmp.display()))?;
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = std::io::Read::read(&mut reader, &mut buf)?;
            if n == 0 {
                break;
            }
            std::io::Write::write_all(&mut file, &buf[..n])?;
            done += n as u64;
            progress(done);
        }
        std::io::Write::flush(&mut file)?;
        drop(file);
        std::fs::rename(&tmp, &dest)
            .with_context(|| format!("moving {} into place", dest.display()))?;
    }
    Ok(())
}

/// Best-effort remote size via a HEAD request, for the combined progress total.
/// Returns 0 (via the caller's `unwrap_or`) if the server omits `Content-Length`.
#[cfg(feature = "ane")]
fn remote_content_length(url: &str) -> Result<u64> {
    let resp = ureq::request("HEAD", url)
        .call()
        .with_context(|| format!("HEAD {url}"))?;
    Ok(resp
        .header("Content-Length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0))
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
    let mut file =
        std::fs::File::create(dest).with_context(|| format!("creating {}", dest.display()))?;

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
    let file =
        std::fs::File::open(tarball).with_context(|| format!("opening {}", tarball.display()))?;
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
    fn coreml_is_present_false_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let p = CoremlPaths::resolve(dir.path());
        assert!(!p.is_present());
    }

    #[test]
    fn coreml_is_present_true_when_all_files_exist() {
        let dir = tempfile::tempdir().unwrap();
        let p = CoremlPaths::resolve(dir.path());
        std::fs::create_dir_all(&p.dir).unwrap();
        // The four compiled models are `.mlmodelc` *directories* (spike section
        // 14), so create them as dirs; the support artifacts are plain files.
        for d in COREML_REQUIRED_DIRS {
            std::fs::create_dir_all(p.dir.join(d)).unwrap();
        }
        for f in COREML_REQUIRED_FILES {
            std::fs::write(p.dir.join(f), b"x").unwrap();
        }
        assert!(p.is_present());
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
