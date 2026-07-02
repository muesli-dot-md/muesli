//! Storage Backend abstraction + S3-compatible implementation (ADR 0013).
//!
//! The Canonical File lives in a pluggable backend; this module owns the server side of the
//! materialize/ingest loop for **attached** documents (documents.storage_conn_id):
//!
//! - **Materialize**: rooms ping [`StorageHandle::mark_dirty`] after every persisted update
//!   (an unbounded send — the actor never blocks). The manager debounces ~500ms per document,
//!   then writes the materialized text to the backend and records `documents.content_hash`
//!   (sha256 of the bytes).
//! - **Out-of-band ingest**: every `MUESLI_S3_POLL_SECS` (default 20) the manager reads each
//!   attached object; when its hash differs from `content_hash` (the guard against our own
//!   writes) the text is ingested into the live room (`RoomMsg::IngestText` → text diff,
//!   origin `ingest`, author None) and broadcast. Polling latency is expected behavior
//!   (ADR 0013), not a defect.
//!
//! The S3 client is **hand-rolled SigV4 over reqwest** (GET/PUT/LIST): `object_store`'s
//! current line needs a newer rustc than our MSRV (1.86) and `rust-s3` drags a second TLS/
//! http stack; SigV4 for path-style MinIO/S3 is ~150 lines on the reqwest+sha2 we already
//! ship, with the signing core unit-tested against the AWS reference vectors.
//!
//! The second backend is the **GitHub Contents API** ([`GithubBackend`]): a workspace's
//! git repo on GitHub, Gitea, or Forgejo holds the Canonical Files — the Contents API
//! (GET/PUT `/repos/{owner}/{repo}/contents/{path}`) is wire-compatible across all three.
//! Every materialize becomes a commit; out-of-band commits arrive through the same poll
//! loop. Dispatch by `storage_connections.kind` happens in [`backend_from_conn`].
//!
//! The third backend is **Google Drive** (`kind: "gdrive"`, [`crate::gdrive::GdriveBackend`],
//! ADR 0013's user-borne-storage launch requirement): created via a per-workspace OAuth
//! dance rather than a config POST, files live flat in a "Muesli" Drive folder. The same
//! materialize/poll loops and the sha256 content_hash echo-guard apply unchanged.
//!
//! The fourth backend is **SharePoint** (`kind: "sharepoint"`,
//! [`crate::msgraph::SharePointBackend`]): a Microsoft 365 document library reached
//! app-only via Sites.Selected — form + probe connect like S3, no OAuth redirect. The
//! same materialize/poll loops and the sha256 content_hash echo-guard apply unchanged.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::events::WorkspaceEvents;
use crate::links::LinkHandle;
use crate::persistence::{AttachedDoc, Persistence};
use crate::room::RoomMsg;
use crate::Rooms;

/// Debounce window between a room's last persisted update and the materialize write.
const DEBOUNCE: Duration = Duration::from_millis(500);
const DEFAULT_POLL_SECS: u64 = 20;

/// Server-wide retention default (spec: MUESLI_RETENTION=full|bounded, default full).
fn retention_default() -> &'static str {
    match std::env::var("MUESLI_RETENTION").as_deref() {
        Ok("bounded") => "bounded",
        _ => "full",
    }
}

/// One pluggable backend (ADR 0013). Deliberately minimal and honest: read/write/list of
/// whole objects keyed by a connection-relative path; assets come later. Every method
/// returns the backend's content version tag (etag) alongside the bytes.
#[allow(async_fn_in_trait)]
pub trait StorageBackend: Send + Sync {
    /// None = the object does not exist. Some((bytes, etag)) otherwise.
    async fn read(&self, rel_path: &str) -> Result<Option<(Vec<u8>, String)>>;
    /// Write (create or replace) and return the new etag.
    async fn write(&self, rel_path: &str, bytes: &[u8]) -> Result<String>;
    /// (rel_path, etag) pairs under the prefix.
    #[allow(dead_code)]
    // No production caller since the probe replaced connect-time list(); kept for the storage listing surface + future health checks (1a-T10).
    async fn list(&self, prefix: &str) -> Result<Vec<(String, String)>>;
    /// Remove the object; an already-absent object is Ok (idempotent). Used when a
    /// folder move/rename relocates a document's rel_path — the old file goes away.
    async fn delete(&self, rel_path: &str) -> Result<()>;
}

/// The backend rel_path implied by a document's folder placement: the folder-chain
/// names (root → leaf) joined by '/', then `{slug}.md`. Folder names are validated to
/// never contain '/' (folders::valid_folder_name), so the mapping is unambiguous.
pub fn rel_path_for(chain: &[String], slug: &str) -> String {
    if chain.is_empty() {
        format!("{slug}.md")
    } else {
        format!("{}/{slug}.md", chain.join("/"))
    }
}

/// Like [`rel_path_for`] but the file *stem* is a free-form display name (a document's
/// title), sanitized so the backend filename tracks the title and stays consistent with
/// the desktop client's local file (which names files by title, not slug). The folder
/// chain joins exactly as in [`rel_path_for`].
pub fn rel_path_for_named(chain: &[String], name: &str) -> String {
    let stem = sanitize_filename_segment(name);
    if chain.is_empty() {
        format!("{stem}.md")
    } else {
        format!("{}/{stem}.md", chain.join("/"))
    }
}

/// Case-preserving filename sanitizer. MIRRORS `muesli-cli`'s `sync::sanitize_segment`
/// (the desktop client's local-file namer): replace any path separator with '-', strip
/// leading dots, trim surrounding whitespace, and fall back to "untitled" when empty.
/// Deliberately NOT `links::slugify` — slugify lowercases and dashes, which would make
/// the backend filename diverge from the desktop's case-preserving local file.
fn sanitize_filename_segment(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if std::path::is_separator(c) { '-' } else { c })
        .collect();
    let cleaned = cleaned.trim_start_matches('.').trim();
    if cleaned.is_empty() {
        "untitled".into()
    } else {
        cleaned.to_string()
    }
}

/// Maximum object size the read/ingest paths will pull into memory. GitHub's Contents
/// API already refuses blobs > 1 MiB (`encoding: "none"`, rejected in `read`); S3 and
/// Drive get this explicit cap instead so an attacker-placed multi-GB object cannot
/// exhaust server memory on the next poll tick. Documents are markdown — far below it.
pub(crate) const MAX_INGEST_BYTES: u64 = 5 * 1024 * 1024;

/// Shared path-traversal guard for connection-relative paths. A rel_path must be
/// relative (no leading '/'), use '/' separators only (no backslashes), and contain no
/// empty, `.` or `..` segments — otherwise a hierarchical backend (GitHub/Gitea/Forgejo)
/// would resolve it OUTSIDE the connection's configured prefix, letting one workspace
/// read/overwrite another's files. Errors instead of sanitizing: a traversal-shaped
/// path is always a bug or an attack, never something to quietly rewrite.
pub(crate) fn validate_rel_path(rel_path: &str) -> Result<()> {
    if rel_path.is_empty() {
        return Err(anyhow!("rel_path is empty"));
    }
    if rel_path.contains('\\') {
        return Err(anyhow!("rel_path {rel_path:?} contains a backslash"));
    }
    if rel_path.starts_with('/') {
        return Err(anyhow!("rel_path {rel_path:?} is absolute (leading '/')"));
    }
    if rel_path
        .split('/')
        .any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        return Err(anyhow!(
            "rel_path {rel_path:?} contains an empty, '.' or '..' segment"
        ));
    }
    Ok(())
}

/// [`validate_rel_path`] for list prefixes, which may legitimately be `""` (list
/// everything — the connection probe) and may carry a trailing '/'.
#[allow(dead_code)]
// No production caller since the probe replaced connect-time list(); kept for the storage listing surface + future health checks (1a-T10).
pub(crate) fn validate_list_prefix(prefix: &str) -> Result<()> {
    let trimmed = prefix.trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(());
    }
    validate_rel_path(trimmed)
}

/// Read a response body under [`MAX_INGEST_BYTES`]: the declared Content-Length is
/// checked up front and the streamed bytes are counted, so an oversized (or lying)
/// object can never balloon memory. Shared by the S3 and Drive read paths.
pub(crate) async fn read_body_capped(mut res: reqwest::Response, what: &str) -> Result<Vec<u8>> {
    if let Some(len) = res.content_length() {
        if len > MAX_INGEST_BYTES {
            return Err(anyhow!(
                "{what}: object is {len} bytes, over the {MAX_INGEST_BYTES}-byte ingest cap; skipping"
            ));
        }
    }
    let mut out: Vec<u8> = Vec::new();
    // A mid-body transport error's Display embeds the request URL — for SharePoint
    // that is the pre-authenticated downloadUrl (live tempauth token in the query
    // string), so strip it before the error can enter the anyhow chain.
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|e| anyhow!("{what}: body read: {}", e.without_url()))?
    {
        if out.len() as u64 + chunk.len() as u64 > MAX_INGEST_BYTES {
            return Err(anyhow!(
                "{what}: object exceeds the {MAX_INGEST_BYTES}-byte ingest cap; skipping"
            ));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// SigV4 (https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html)
// ---------------------------------------------------------------------------

pub(crate) const EMPTY_SHA256: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub(crate) fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

/// HMAC-SHA256 (RFC 2104) on the sha2 we already ship — no extra dependency.
pub(crate) fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= block[i];
        opad[i] ^= block[i];
    }
    let inner = Sha256::new()
        .chain_update(ipad)
        .chain_update(data)
        .finalize();
    Sha256::new()
        .chain_update(opad)
        .chain_update(inner)
        .finalize()
        .into()
}

/// AWS URI-encode: unreserved characters stay, everything else %XX (uppercase hex).
/// `encode_slash = false` keeps `/` (for path segments).
pub(crate) fn uri_encode(s: &str, encode_slash: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            b'/' if !encode_slash => out.push('/'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// (YYYYMMDD, YYYYMMDDTHHMMSSZ) for x-amz-date. Civil-from-days per Howard Hinnant.
pub(crate) fn amz_date(now: SystemTime) -> (String, String) {
    let secs = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe as i64 + era * 400 + if m <= 2 { 1 } else { 0 };
    let date = format!("{y:04}{m:02}{d:02}");
    let datetime = format!("{date}T{h:02}{mi:02}{s:02}Z");
    (date, datetime)
}

/// The four SigV4 steps, kept pure for unit testing against AWS's reference vectors.
/// `headers` must be lowercase-named and sorted; `canonical_query` already canonical.
pub(crate) fn canonical_request(
    method: &str,
    canonical_uri: &str,
    canonical_query: &str,
    headers: &[(&str, &str)],
    payload_hash: &str,
) -> String {
    let canonical_headers: String = headers.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let signed_headers: Vec<&str> = headers.iter().map(|(k, _)| *k).collect();
    format!(
        "{method}\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{}\n{payload_hash}",
        signed_headers.join(";")
    )
}

pub(crate) fn string_to_sign(datetime: &str, scope: &str, canonical_request: &str) -> String {
    format!(
        "AWS4-HMAC-SHA256\n{datetime}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    )
}

pub(crate) fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> [u8; 32] {
    let k = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let k = hmac_sha256(&k, region.as_bytes());
    let k = hmac_sha256(&k, service.as_bytes());
    hmac_sha256(&k, b"aws4_request")
}

// ---------------------------------------------------------------------------
// S3-compatible backend (MinIO, AWS S3, R2) — path-style requests
// ---------------------------------------------------------------------------

pub struct S3Backend {
    http: reqwest::Client,
    endpoint: String, // e.g. http://localhost:9000 (no trailing slash)
    host: String,     // host[:port] for the signed Host header
    bucket: String,
    region: String,
    prefix: String, // optional key prefix, "" or "a/b/" style
    pub(crate) access_key: String,
    pub(crate) secret_key: String,
}

impl S3Backend {
    /// Build from a storage_connections row's config jsonb. Per-workspace credentials
    /// (config's `access_key_id` + `secret_key_enc`, encrypted at rest with
    /// MUESLI_SECRET_KEY, plan 1a task 4) win when present; otherwise the server
    /// environment (MUESLI_S3_ACCESS_KEY / MUESLI_S3_SECRET_KEY) is the grandfathered
    /// fallback for legacy rows.
    pub fn from_conn(kind: &str, config: &Value) -> Result<Self> {
        if kind != "s3" {
            return Err(anyhow!("S3Backend cannot serve storage kind {kind:?}"));
        }
        let endpoint = config
            .get("endpoint")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("storage config has no endpoint"))?
            .trim_end_matches('/')
            .to_string();
        let bucket = config
            .get("bucket")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("storage config has no bucket"))?
            .to_string();
        let region = config
            .get("region")
            .and_then(Value::as_str)
            .filter(|r| !r.is_empty())
            .unwrap_or("us-east-1")
            .to_string();
        let mut prefix = config
            .get("prefix")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim_matches('/')
            .to_string();
        if !prefix.is_empty() {
            validate_rel_path(prefix.trim_end_matches('/'))?;
            prefix.push('/');
        }
        let (access_key, secret_key) = s3_conn_creds(config)?;
        let host = reqwest::Url::parse(&endpoint)
            .with_context(|| format!("bad storage endpoint {endpoint:?}"))?
            .authority()
            .to_string();
        Ok(Self {
            // SSRF hardening: the endpoint is admin-supplied and requests carry a signed
            // Credential header — never follow a redirect it hands back.
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            endpoint,
            host,
            bucket,
            region,
            prefix,
            access_key,
            secret_key,
        })
    }

    fn key(&self, rel_path: &str) -> String {
        format!("{}{}", self.prefix, rel_path.trim_start_matches('/'))
    }

    /// Sign and send one request. `canonical_query` must already be canonical
    /// (sorted, URI-encoded `k=v` pairs).
    async fn send(
        &self,
        method: reqwest::Method,
        canonical_uri: &str,
        canonical_query: &str,
        body: Option<Vec<u8>>,
    ) -> Result<reqwest::Response> {
        let payload_hash = match &body {
            Some(b) => sha256_hex(b),
            None => EMPTY_SHA256.to_string(),
        };
        let (date, datetime) = amz_date(SystemTime::now());
        let headers = [
            ("host", self.host.as_str()),
            ("x-amz-content-sha256", payload_hash.as_str()),
            ("x-amz-date", datetime.as_str()),
        ];
        let creq = canonical_request(
            method.as_str(),
            canonical_uri,
            canonical_query,
            &headers,
            &payload_hash,
        );
        let scope = format!("{date}/{}/s3/aws4_request", self.region);
        let sts = string_to_sign(&datetime, &scope, &creq);
        let key = signing_key(&self.secret_key, &date, &self.region, "s3");
        let signature = hex(&hmac_sha256(&key, sts.as_bytes()));
        let authorization = format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature={signature}",
            self.access_key
        );

        let mut url = format!("{}{canonical_uri}", self.endpoint);
        if !canonical_query.is_empty() {
            url.push('?');
            url.push_str(canonical_query);
        }
        let mut req = self
            .http
            .request(method, &url)
            .header("x-amz-content-sha256", &payload_hash)
            .header("x-amz-date", &datetime)
            .header("authorization", authorization);
        if let Some(b) = body {
            req = req.body(b);
        }
        Ok(req.send().await?)
    }

    fn object_uri(&self, rel_path: &str) -> String {
        format!(
            "/{}/{}",
            uri_encode(&self.bucket, true),
            uri_encode(&self.key(rel_path), false)
        )
    }
}

fn s3_env_creds() -> Result<(String, String)> {
    let access = std::env::var("MUESLI_S3_ACCESS_KEY");
    let secret = std::env::var("MUESLI_S3_SECRET_KEY");
    match (access, secret) {
        (Ok(a), Ok(s)) if !a.is_empty() && !s.is_empty() => Ok((a, s)),
        _ => Err(anyhow!(
            "MUESLI_S3_ACCESS_KEY / MUESLI_S3_SECRET_KEY are not set on the server"
        )),
    }
}

/// Credential resolution for one connection: per-workspace config credentials
/// (access_key_id + secret_key_enc, plan 1a) win; the server-wide env pair remains the
/// grandfathered fallback. The encrypted secret requires MUESLI_SECRET_KEY to decrypt.
fn s3_conn_creds(config: &Value) -> Result<(String, String)> {
    let id = config
        .get("access_key_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let enc = config
        .get("secret_key_enc")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    match (id, enc) {
        (Some(id), Some(enc)) => Ok((id.to_string(), crate::secrets::decrypt_secret(enc)?)),
        _ => s3_env_creds(),
    }
}

/// True when the server has S3 credentials configured (used to fail fast on connect).
pub fn s3_creds_configured() -> bool {
    s3_env_creds().is_ok()
}

fn etag_of(res: &reqwest::Response) -> String {
    res.headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim_matches('"')
        .to_string()
}

impl StorageBackend for S3Backend {
    async fn read(&self, rel_path: &str) -> Result<Option<(Vec<u8>, String)>> {
        validate_rel_path(rel_path)?;
        let res = self
            .send(reqwest::Method::GET, &self.object_uri(rel_path), "", None)
            .await?;
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(anyhow!("s3 GET {rel_path}: {status} {body}"));
        }
        let etag = etag_of(&res);
        let bytes = read_body_capped(res, &format!("s3 GET {rel_path}")).await?;
        Ok(Some((bytes, etag)))
    }

    async fn write(&self, rel_path: &str, bytes: &[u8]) -> Result<String> {
        validate_rel_path(rel_path)?;
        let res = self
            .send(
                reqwest::Method::PUT,
                &self.object_uri(rel_path),
                "",
                Some(bytes.to_vec()),
            )
            .await?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(anyhow!("s3 PUT {rel_path}: {status} {body}"));
        }
        Ok(etag_of(&res))
    }

    async fn list(&self, prefix: &str) -> Result<Vec<(String, String)>> {
        validate_list_prefix(prefix)?;
        let full_prefix = self.key(prefix);
        // Canonical query: keys sorted (list-type < prefix).
        let query = format!("list-type=2&prefix={}", uri_encode(&full_prefix, true));
        let uri = format!("/{}/", uri_encode(&self.bucket, true));
        let res = self.send(reqwest::Method::GET, &uri, &query, None).await?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(anyhow!("s3 LIST {prefix}: {status} {body}"));
        }
        let xml = res.text().await?;
        Ok(parse_list_objects(&xml)
            .into_iter()
            .map(|(key, etag)| {
                (
                    key.strip_prefix(&self.prefix).unwrap_or(&key).to_string(),
                    etag,
                )
            })
            .collect())
    }

    async fn delete(&self, rel_path: &str) -> Result<()> {
        validate_rel_path(rel_path)?;
        let res = self
            .send(
                reqwest::Method::DELETE,
                &self.object_uri(rel_path),
                "",
                None,
            )
            .await?;
        // S3 DeleteObject answers 204 even for absent keys; tolerate 404 from
        // stricter S3-compatibles anyway (delete is idempotent by contract).
        if !res.status().is_success() && res.status() != reqwest::StatusCode::NOT_FOUND {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(anyhow!("s3 DELETE {rel_path}: {status} {body}"));
        }
        Ok(())
    }
}

/// Minimal ListObjectsV2 parsing: (Key, ETag) per <Contents>. Handles the XML entities S3
/// emits in keys; deliberately not a general XML parser (first page only — fine for the
/// document counts this serves).
#[allow(dead_code)]
// No production caller since the probe replaced connect-time list(); kept for the storage listing surface + future health checks (1a-T10).
pub(crate) fn parse_list_objects(xml: &str) -> Vec<(String, String)> {
    fn unescape(s: &str) -> String {
        s.replace("&quot;", "\"")
            .replace("&#34;", "\"")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&apos;", "'")
            .replace("&amp;", "&")
    }
    fn tag(block: &str, name: &str) -> Option<String> {
        let open = format!("<{name}>");
        let close = format!("</{name}>");
        let start = block.find(&open)? + open.len();
        let end = block[start..].find(&close)? + start;
        Some(unescape(&block[start..end]))
    }
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(at) = rest.find("<Contents>") {
        let Some(end) = rest[at..].find("</Contents>") else {
            break;
        };
        let block = &rest[at..at + end];
        if let Some(key) = tag(block, "Key") {
            let etag = tag(block, "ETag")
                .unwrap_or_default()
                .trim_matches('"')
                .to_string();
            out.push((key, etag));
        }
        rest = &rest[at + end + "</Contents>".len()..];
    }
    out
}

/// The minimal customer-side IAM policy for one bucket/prefix. Shown by the wizard
/// BEFORE the customer creates their access key, so keys are born least-privilege.
pub fn s3_iam_policy(bucket: &str, prefix: &str) -> Value {
    let prefix = prefix.trim_matches('/');
    let mut list = serde_json::json!({
        "Effect": "Allow",
        "Action": ["s3:ListBucket"],
        "Resource": format!("arn:aws:s3:::{bucket}"),
    });
    let objects_arn = if prefix.is_empty() {
        format!("arn:aws:s3:::{bucket}/*")
    } else {
        list["Condition"] = serde_json::json!({"StringLike": {"s3:prefix": format!("{prefix}/*")}});
        format!("arn:aws:s3:::{bucket}/{prefix}/*")
    };
    serde_json::json!({
        "Version": "2012-10-17",
        "Statement": [list, {
            "Effect": "Allow",
            "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
            "Resource": objects_arn,
        }],
    })
}

impl S3Backend {
    /// Connection probe: prove write+read+delete under the prefix, not just list.
    /// The rel_path stays inside .muesli/ so a colliding real document is impossible.
    pub async fn probe(&self) -> Result<()> {
        let rel = format!(".muesli/probe-{}", Uuid::new_v4());
        let payload = b"muesli storage probe";
        self.write(&rel, payload)
            .await
            .context("probe write failed")?;
        let read = self
            .read(&rel)
            .await
            .context("probe read failed")?
            .ok_or_else(|| anyhow!("probe object vanished between write and read"))?;
        if read.0 != payload {
            return Err(anyhow!("probe read returned different bytes than written"));
        }
        self.delete(&rel).await.context("probe delete failed")?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// GitHub-compatible backend (GitHub, Gitea, Forgejo) — the Contents API
// ---------------------------------------------------------------------------

/// One git repo as a Storage Backend. Reads and writes go through the Contents API
/// (`GET`/`PUT /repos/{owner}/{repo}/contents/{path}`), which is wire-compatible across
/// GitHub (`api_base = https://api.github.com`) and Gitea/Forgejo
/// (`api_base = https://host/api/v1`). Every materialize is a commit on `branch`; the
/// blob sha doubles as the etag.
pub struct GithubBackend {
    http: reqwest::Client,
    api_base: String, // no trailing slash
    owner: String,
    repo: String,
    branch: String,
    prefix: String, // optional repo-path prefix, "" or "a/b/" style
    token: String,
}

/// Join the connection's prefix ("" or "a/b/") with a connection-relative path.
pub(crate) fn join_repo_path(prefix: &str, rel_path: &str) -> String {
    format!("{prefix}{}", rel_path.trim_start_matches('/'))
}

/// The Contents API URL for one repo path. Path segments are percent-encoded but `/`
/// stays a separator (`uri_encode(_, false)`), matching how GitHub and Gitea route.
pub(crate) fn contents_url(api_base: &str, owner: &str, repo: &str, repo_path: &str) -> String {
    format!(
        "{}/repos/{}/{}/contents/{}",
        api_base.trim_end_matches('/'),
        uri_encode(owner, true),
        uri_encode(repo, true),
        uri_encode(repo_path, false),
    )
}

/// Commit messages distinguish first materialization from updates (task spec).
pub(crate) fn commit_message(file_exists: bool, repo_path: &str) -> String {
    if file_exists {
        format!("muesli: update {repo_path}")
    } else {
        format!("muesli: create {repo_path}")
    }
}

/// Decode a Contents API `content` field. GitHub wraps the base64 in newlines every 60
/// chars; Gitea ships it on one line — strip all whitespace before decoding.
pub(crate) fn decode_contents_base64(content: &str) -> Result<Vec<u8>> {
    use base64::Engine as _;
    let compact: String = content.chars().filter(|c| !c.is_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(compact.as_bytes())
        .context("contents API returned invalid base64")
}

fn github_env_token() -> Result<String> {
    match std::env::var("MUESLI_GITHUB_TOKEN") {
        Ok(t) if !t.is_empty() => Ok(t),
        _ => Err(anyhow!("MUESLI_GITHUB_TOKEN is not set on the server")),
    }
}

/// True when the server has a git-forge token configured (used to fail fast on connect).
pub fn github_token_configured() -> bool {
    github_env_token().is_ok()
}

/// Per-workspace token (token_enc, plan 1a) with the env fallback for grandfathered rows.
fn github_conn_token(config: &Value) -> Result<String> {
    match config
        .get("token_enc")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        Some(enc) => crate::secrets::decrypt_secret(enc),
        None => github_env_token(),
    }
}

impl GithubBackend {
    /// Build from a storage_connections row's config jsonb: {api_base, owner, repo,
    /// branch, prefix?}. The per-workspace token (config's `token_enc`, encrypted at
    /// rest with MUESLI_SECRET_KEY, plan 1a task 4) wins when present; otherwise the
    /// server environment (MUESLI_GITHUB_TOKEN) is the grandfathered fallback — same
    /// posture as S3.
    pub fn from_conn(kind: &str, config: &Value) -> Result<Self> {
        if kind != "github" {
            return Err(anyhow!("GithubBackend cannot serve storage kind {kind:?}"));
        }
        let field = |name: &str| -> Result<String> {
            config
                .get(name)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .ok_or_else(|| anyhow!("storage config has no {name}"))
        };
        let api_base = field("api_base")?.trim_end_matches('/').to_string();
        let mut prefix = config
            .get("prefix")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim_matches('/')
            .to_string();
        if !prefix.is_empty() {
            validate_rel_path(&prefix)?;
            prefix.push('/');
        }
        Ok(Self {
            // GitHub rejects requests without a User-Agent; reqwest sends none by default.
            // SSRF hardening: api_base is admin-supplied and every request carries the
            // server-wide token — never follow a redirect the host hands back.
            http: reqwest::Client::builder()
                .user_agent("muesli-server")
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            api_base,
            owner: field("owner")?,
            repo: field("repo")?,
            branch: field("branch")?,
            prefix,
            token: github_conn_token(config)?,
        })
    }

    fn repo_path(&self, rel_path: &str) -> String {
        join_repo_path(&self.prefix, rel_path)
    }

    fn request(&self, method: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
        // `Authorization: token <t>` is accepted by GitHub, Gitea, and Forgejo alike.
        self.http
            .request(method, url)
            .header("authorization", format!("token {}", self.token))
            .header("accept", "application/vnd.github+json")
    }

    /// GET the Contents API object for one repo path on our branch. None on 404.
    async fn contents_get(&self, repo_path: &str) -> Result<Option<Value>> {
        let url = format!(
            "{}?ref={}",
            contents_url(&self.api_base, &self.owner, &self.repo, repo_path),
            uri_encode(&self.branch, true),
        );
        let res = self.request(reqwest::Method::GET, &url).send().await?;
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !res.status().is_success() {
            let code = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(anyhow!("contents GET {repo_path}: {code} {body}"));
        }
        Ok(Some(res.json().await?))
    }

    /// The current blob sha of a file, or None when it doesn't exist yet.
    async fn current_sha(&self, repo_path: &str) -> Result<Option<String>> {
        Ok(self
            .contents_get(repo_path)
            .await?
            .and_then(|v| v.get("sha").and_then(Value::as_str).map(str::to_string)))
    }

    /// One create-or-update attempt. Ok(Ok(etag)) on success; Ok(Err(detail)) when the
    /// forge rejected it in a retryable way — a sha conflict (409 on GitHub, 422 on
    /// Gitea/Forgejo) or a create that raced an existing file (422 both; 404/405 for
    /// POST on GitHub, which has no POST route) — Err on anything else.
    async fn send_contents(
        &self,
        method: reqwest::Method,
        repo_path: &str,
        bytes: &[u8],
        sha: Option<&str>,
    ) -> Result<std::result::Result<String, String>> {
        use base64::Engine as _;
        let mut body = serde_json::json!({
            "message": commit_message(sha.is_some(), repo_path),
            "content": base64::engine::general_purpose::STANDARD.encode(bytes),
            "branch": self.branch,
        });
        if let Some(s) = sha {
            body["sha"] = Value::String(s.to_string());
        }
        let url = contents_url(&self.api_base, &self.owner, &self.repo, repo_path);
        let res = self
            .request(method.clone(), &url)
            .json(&body)
            .send()
            .await?;
        let code = res.status();
        if code.is_success() {
            let v: Value = res.json().await?;
            let etag = v
                .pointer("/content/sha")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            return Ok(Ok(etag));
        }
        let detail = format!("{code} {}", res.text().await.unwrap_or_default());
        match code.as_u16() {
            409 | 422 | 404 | 405 => Ok(Err(detail)),
            _ => Err(anyhow!("contents {method} {repo_path}: {detail}")),
        }
    }

    /// Connection probe: the branch must exist and the token must see the repo. Used by
    /// the attach endpoint so a typo'd owner/repo/branch fails the request (502), not
    /// the materialize/poll loops later.
    pub async fn probe(&self) -> Result<()> {
        let url = format!(
            "{}/repos/{}/{}/branches/{}",
            self.api_base,
            uri_encode(&self.owner, true),
            uri_encode(&self.repo, true),
            uri_encode(&self.branch, true),
        );
        let res = self.request(reqwest::Method::GET, &url).send().await?;
        if !res.status().is_success() {
            let code = res.status();
            return Err(anyhow!(
                "cannot read branch {}/{}@{}: {code}",
                self.owner,
                self.repo,
                self.branch
            ));
        }
        Ok(())
    }
}

impl StorageBackend for GithubBackend {
    async fn read(&self, rel_path: &str) -> Result<Option<(Vec<u8>, String)>> {
        validate_rel_path(rel_path)?;
        let repo_path = self.repo_path(rel_path);
        let Some(v) = self.contents_get(&repo_path).await? else {
            return Ok(None);
        };
        let sha = v
            .get("sha")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let encoding = v
            .get("encoding")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if encoding != "base64" {
            // GitHub answers `encoding: "none"` with an empty body for blobs > 1 MiB;
            // documents are far below that, so we fail loudly instead of mis-ingesting.
            return Err(anyhow!(
                "contents GET {repo_path}: unsupported encoding {encoding:?} (file too large?)"
            ));
        }
        let content = v.get("content").and_then(Value::as_str).unwrap_or_default();
        Ok(Some((decode_contents_base64(content)?, sha)))
    }

    async fn write(&self, rel_path: &str, bytes: &[u8]) -> Result<String> {
        validate_rel_path(rel_path)?;
        let repo_path = self.repo_path(rel_path);
        let mut last_detail = String::new();
        // Two passes: the normal write, and ONE retry after a sha conflict (a commit
        // landed between our sha fetch and the write). Retrying with the fresh sha and
        // the same bytes is correct by CRDT semantics: the room is the live authority
        // and these bytes are its full current state — and nothing is destroyed, the
        // competing commit stays in git history. If that commit's content never reached
        // the room, the poll-ingest loop (not this write) is the path that merges
        // external text into the CRDT; the next materialize then commits the merged
        // state. We must not clobber blindly, hence compare-and-swap on the sha.
        for attempt in 0..2 {
            // The Contents API demands the current blob sha for updates (CAS).
            let sha = self.current_sha(&repo_path).await?;
            let outcome = match &sha {
                Some(s) => {
                    self.send_contents(reqwest::Method::PUT, &repo_path, bytes, Some(s))
                        .await?
                }
                None => {
                    // Create. GitHub creates via PUT-without-sha; Gitea/Forgejo demand
                    // POST for creation (their PUT answers 422 "[SHA]: Required"). Try
                    // the GitHub shape first, fall back to POST.
                    match self
                        .send_contents(reqwest::Method::PUT, &repo_path, bytes, None)
                        .await?
                    {
                        Ok(etag) => Ok(etag),
                        Err(_) => {
                            self.send_contents(reqwest::Method::POST, &repo_path, bytes, None)
                                .await?
                        }
                    }
                }
            };
            match outcome {
                Ok(etag) => return Ok(etag),
                Err(detail) => {
                    if attempt == 0 {
                        debug!(
                            repo_path,
                            sha = sha.as_deref().unwrap_or("<none>"),
                            detail,
                            "contents write hit a sha conflict; retrying once with a fresh sha"
                        );
                    }
                    last_detail = detail;
                }
            }
        }
        Err(anyhow!(
            "contents write {repo_path}: conflict persisted after one retry ({last_detail})"
        ))
    }

    async fn list(&self, prefix: &str) -> Result<Vec<(String, String)>> {
        validate_list_prefix(prefix)?;
        // GET on a directory path returns a JSON array of entries; 404 = no such dir.
        let dir = join_repo_path(&self.prefix, prefix);
        let url = format!(
            "{}?ref={}",
            contents_url(
                &self.api_base,
                &self.owner,
                &self.repo,
                dir.trim_matches('/')
            ),
            uri_encode(&self.branch, true),
        );
        let res = self.request(reqwest::Method::GET, &url).send().await?;
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(Vec::new());
        }
        if !res.status().is_success() {
            let code = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(anyhow!("contents LIST {prefix}: {code} {body}"));
        }
        let v: Value = res.json().await?;
        let entries = match v {
            Value::Array(a) => a,
            other => vec![other], // the path was a single file
        };
        Ok(entries
            .iter()
            .filter(|e| e.get("type").and_then(Value::as_str) == Some("file"))
            .filter_map(|e| {
                let path = e.get("path").and_then(Value::as_str)?;
                let sha = e.get("sha").and_then(Value::as_str).unwrap_or_default();
                let rel = path.strip_prefix(self.prefix.as_str()).unwrap_or(path);
                Some((rel.to_string(), sha.to_string()))
            })
            .collect())
    }

    async fn delete(&self, rel_path: &str) -> Result<()> {
        validate_rel_path(rel_path)?;
        let repo_path = self.repo_path(rel_path);
        // The Contents API deletes with the current blob sha (CAS, like writes).
        // Already gone = done (idempotent).
        let Some(sha) = self.current_sha(&repo_path).await? else {
            return Ok(());
        };
        let url = contents_url(&self.api_base, &self.owner, &self.repo, &repo_path);
        let body = serde_json::json!({
            "message": format!("muesli: delete {repo_path}"),
            "sha": sha,
            "branch": self.branch,
        });
        let res = self
            .request(reqwest::Method::DELETE, &url)
            .json(&body)
            .send()
            .await?;
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(()); // raced an external delete — the goal state holds
        }
        if !res.status().is_success() {
            let code = res.status();
            let detail = res.text().await.unwrap_or_default();
            return Err(anyhow!("contents DELETE {repo_path}: {code} {detail}"));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Dispatch by storage_connections.kind
// ---------------------------------------------------------------------------

/// The kind-dispatched backend. An enum (not `dyn`) because the trait uses
/// `async fn` — static dispatch with one match, the single place to extend
/// when the next backend (Dropbox/OneDrive, ADR 0013) lands.
pub enum AnyBackend {
    S3(S3Backend),
    Github(GithubBackend),
    Gdrive(crate::gdrive::GdriveBackend),
    Sharepoint(crate::msgraph::SharePointBackend),
    /// Test-only in-memory backend, selected by the `"memory"` kind. Lets the DB-gated
    /// relocate tests drive the full byte path without a live S3/GitHub backend.
    #[cfg(test)]
    Memory(tests::MemoryBackend),
}

/// Construct the right backend for a storage_connections row.
pub fn backend_from_conn(kind: &str, config: &Value) -> Result<AnyBackend> {
    match kind {
        "s3" => Ok(AnyBackend::S3(S3Backend::from_conn(kind, config)?)),
        "github" => Ok(AnyBackend::Github(GithubBackend::from_conn(kind, config)?)),
        "gdrive" => Ok(AnyBackend::Gdrive(crate::gdrive::GdriveBackend::from_conn(kind, config)?)),
        "sharepoint" => {
            Ok(AnyBackend::Sharepoint(crate::msgraph::SharePointBackend::from_conn(kind, config)?))
        }
        #[cfg(test)]
        "memory" => Ok(AnyBackend::Memory(tests::MemoryBackend::from_conn(config))),
        other => Err(anyhow!(
            "unsupported storage kind {other:?} (implemented: \"s3\", \"github\", \"gdrive\", \"sharepoint\")"
        )),
    }
}

impl StorageBackend for AnyBackend {
    async fn read(&self, rel_path: &str) -> Result<Option<(Vec<u8>, String)>> {
        match self {
            AnyBackend::S3(b) => b.read(rel_path).await,
            AnyBackend::Github(b) => b.read(rel_path).await,
            AnyBackend::Gdrive(b) => b.read(rel_path).await,
            AnyBackend::Sharepoint(b) => b.read(rel_path).await,
            #[cfg(test)]
            AnyBackend::Memory(b) => b.read(rel_path).await,
        }
    }

    async fn write(&self, rel_path: &str, bytes: &[u8]) -> Result<String> {
        match self {
            AnyBackend::S3(b) => b.write(rel_path, bytes).await,
            AnyBackend::Github(b) => b.write(rel_path, bytes).await,
            AnyBackend::Gdrive(b) => b.write(rel_path, bytes).await,
            AnyBackend::Sharepoint(b) => b.write(rel_path, bytes).await,
            #[cfg(test)]
            AnyBackend::Memory(b) => b.write(rel_path, bytes).await,
        }
    }

    async fn list(&self, prefix: &str) -> Result<Vec<(String, String)>> {
        match self {
            AnyBackend::S3(b) => b.list(prefix).await,
            AnyBackend::Github(b) => b.list(prefix).await,
            AnyBackend::Gdrive(b) => b.list(prefix).await,
            AnyBackend::Sharepoint(b) => b.list(prefix).await,
            #[cfg(test)]
            AnyBackend::Memory(b) => b.list(prefix).await,
        }
    }

    async fn delete(&self, rel_path: &str) -> Result<()> {
        match self {
            AnyBackend::S3(b) => b.delete(rel_path).await,
            AnyBackend::Github(b) => b.delete(rel_path).await,
            AnyBackend::Gdrive(b) => b.delete(rel_path).await,
            AnyBackend::Sharepoint(b) => b.delete(rel_path).await,
            #[cfg(test)]
            AnyBackend::Memory(b) => b.delete(rel_path).await,
        }
    }
}

// ---------------------------------------------------------------------------
// Materialize + poll manager
// ---------------------------------------------------------------------------

/// What rooms hold: a fire-and-forget dirty signal (never blocks the actor).
#[derive(Clone)]
pub struct StorageHandle {
    tx: mpsc::UnboundedSender<Uuid>,
}

impl StorageHandle {
    pub fn mark_dirty(&self, document_id: Uuid) {
        let _ = self.tx.send(document_id);
    }
}

/// Per-connection storage health, in memory (a live signal, not an audit trail: it
/// resets on server restart and is never persisted — plan 1a task 10).
#[derive(Clone, serde::Serialize)]
pub struct ConnHealth {
    pub healthy: bool,
    pub last_ok_unix: Option<u64>,
    pub last_error: Option<String>,
    pub last_error_unix: Option<u64>,
}

/// In-memory registry of the last materialize/poll outcome per storage connection. Not
/// an audit trail (see [`ConnHealth`]): a fresh server has no history, which the status
/// endpoint reads as "healthy: null" (unknown) rather than false.
#[derive(Default)]
pub struct HealthRegistry {
    inner: StdMutex<HashMap<Uuid, ConnHealth>>,
}

impl HealthRegistry {
    fn now_unix() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }

    pub fn record_ok(&self, conn_id: Uuid) {
        let mut m = self.inner.lock().unwrap();
        let h = m.entry(conn_id).or_insert(ConnHealth {
            healthy: true,
            last_ok_unix: None,
            last_error: None,
            last_error_unix: None,
        });
        h.healthy = true;
        h.last_ok_unix = Some(Self::now_unix());
    }

    pub fn record_err(&self, conn_id: Uuid, e: &anyhow::Error) {
        let mut m = self.inner.lock().unwrap();
        let h = m.entry(conn_id).or_insert(ConnHealth {
            healthy: false,
            last_ok_unix: None,
            last_error: None,
            last_error_unix: None,
        });
        h.healthy = false;
        h.last_error = Some(sanitize_health_error(&e.to_string()));
        h.last_error_unix = Some(Self::now_unix());
    }

    pub fn get(&self, conn_id: Uuid) -> Option<ConnHealth> {
        self.inner.lock().unwrap().get(&conn_id).cloned()
    }
}

/// A storage error can embed the raw response body from the backend — for S3 that is
/// sometimes an XML error document that echoes the access key id used for the request
/// (`<AWSAccessKeyId>AKIA...</AWSAccessKeyId>`). That string is held in-memory and served
/// back over `GET /storage/status`, so redact anything AWS-key-shaped before storing it,
/// and cap the length so one pathological error can't grow the registry unbounded.
/// No regex crate is in this workspace, so this is a plain scan for the well-known AWS
/// access-key-id shape: `AKIA`/`ASIA` followed by 16 uppercase-alphanumeric characters.
const HEALTH_ERROR_MAX_CHARS: usize = 500;

fn sanitize_health_error(raw: &str) -> String {
    truncate_chars(
        &redact_aws_access_keys(&strip_url_queries(raw)),
        HEALTH_ERROR_MAX_CHARS,
    )
}

/// A transport-level error message can embed a full request URL — for SharePoint that
/// query string can carry a live `@microsoft.graph.downloadUrl` tempauth token or a
/// pre-authenticated `uploadUrl`. msgraph.rs already strips the URL entirely at the two
/// call sites that see those directly (`reqwest::Error::without_url`), but this is the
/// general-purpose backstop: any `https://…?…` substring anywhere in a health error has
/// its query string collapsed, scheme/host/path kept for debuggability. `http://` is
/// matched too — test/dev deployments and endpoint overrides can be plain http.
fn strip_url_queries(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(pos) = rest
        .find("http://")
        .into_iter()
        .chain(rest.find("https://"))
        .min()
    {
        out.push_str(&rest[..pos]);
        let url_part = &rest[pos..];
        // A URL ends at whitespace or common wrapping punctuation; anything else is
        // treated as part of the URL (matches how these get interpolated into messages).
        let end = url_part
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | ')'))
            .unwrap_or(url_part.len());
        let (url, tail) = url_part.split_at(end);
        match url.find('?') {
            Some(qpos) => {
                out.push_str(&url[..qpos]);
                out.push_str("?…");
            }
            None => out.push_str(url),
        }
        rest = tail;
    }
    out.push_str(rest);
    out
}

fn redact_aws_access_keys(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while !rest.is_empty() {
        let is_prefix = rest.starts_with("AKIA") || rest.starts_with("ASIA");
        // The prefix and the key body are both pure ASCII, so byte and char offsets agree —
        // `rest[4..20]` is exactly the 16 candidate characters after the 4-letter prefix.
        let candidate = is_prefix && rest.len() >= 20 && rest.is_char_boundary(20);
        let key_shaped = candidate
            && rest[4..20]
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
        if key_shaped {
            out.push_str("…redacted…");
            rest = &rest[20..];
            continue;
        }
        let mut chars = rest.chars();
        let ch = chars.next().expect("rest is non-empty");
        out.push(ch);
        rest = chars.as_str();
    }
    out
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    s.chars().take(max_chars).collect()
}

pub struct StorageManager {
    persistence: Arc<Persistence>,
    rooms: Rooms,
    handle: StorageHandle,
    /// Threaded into rooms this manager spawns, so poll-ingested documents index their
    /// links exactly like connection-spawned ones (ADR 0015).
    links: Option<LinkHandle>,
    /// Plan 4: the per-workspace structure stream, threaded into rooms this manager spawns
    /// so poll-ingested documents publish DocUpdated wake-pings exactly like ws/REST ones.
    workspace_events: WorkspaceEvents,
    /// Documents with room edits that have not been materialized yet (generation-counted
    /// dirty pings). The poll loop SKIPS these: ingesting a full external snapshot while a
    /// materialize is pending would diff away the un-materialized room edits — a lost
    /// update. Deferring one poll tick lets the debounced write land first; the sha-CAS in
    /// the backend then handles any real conflict, and the next tick ingests honestly.
    pending_materialize: StdMutex<HashMap<Uuid, u64>>,
    /// Last materialize/poll outcome per storage connection (plan 1a task 10). In-memory
    /// by design — see [`HealthRegistry`].
    pub health: HealthRegistry,
}

impl StorageManager {
    /// Spawn the debounce loop and the out-of-band poll loop. The manager spawns rooms on
    /// demand exactly like the ws/REST paths, so it is independent of room lifecycle: an
    /// idle/evicted room simply re-hydrates when the poller next needs it.
    pub fn spawn(
        persistence: Arc<Persistence>,
        rooms: Rooms,
        links: Option<LinkHandle>,
        workspace_events: WorkspaceEvents,
    ) -> Arc<StorageManager> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mgr = Arc::new(StorageManager {
            persistence,
            rooms,
            handle: StorageHandle { tx },
            links,
            workspace_events,
            pending_materialize: StdMutex::new(HashMap::new()),
            health: HealthRegistry::default(),
        });
        tokio::spawn(debounce_loop(mgr.clone(), rx));
        tokio::spawn(poll_loop(mgr.clone()));
        mgr
    }

    pub fn handle(&self) -> StorageHandle {
        self.handle.clone()
    }

    /// The last materialize/poll outcome for a storage connection, or None when the
    /// registry has no entry yet (fresh server, or never attempted — reads as
    /// healthy-unknown, not unhealthy).
    pub fn conn_health(&self, conn_id: Uuid) -> Option<ConnHealth> {
        self.health.get(conn_id)
    }

    fn ensure_room(&self, slug: &str) -> mpsc::UnboundedSender<RoomMsg> {
        crate::ensure_room_in(
            &self.rooms,
            &Some(self.persistence.clone()),
            Some(self.handle()),
            self.links.clone(),
            self.workspace_events.clone(),
            slug,
        )
    }

    /// Write a document's current text to its backend (no-op when unattached or when the
    /// backend already holds these bytes). Returns the content hash that is now durable.
    pub async fn materialize(&self, document_id: Uuid) -> Result<Option<String>> {
        // Snapshot the dirty generation BEFORE reading the room text: if a fresh edit
        // pings while we write, the generation moves and we leave the flag set for the
        // follow-up debouncer instead of clearing protection out from under it.
        let generation = self
            .pending_materialize
            .lock()
            .unwrap()
            .get(&document_id)
            .copied();
        let clear_if_unchanged = || {
            let mut pending = self.pending_materialize.lock().unwrap();
            if pending.get(&document_id).copied() == generation {
                pending.remove(&document_id);
            }
        };
        let Some(att) = self.persistence.document_attachment(document_id).await? else {
            clear_if_unchanged();
            return Ok(None);
        };
        let room = self.ensure_room(&att.slug);
        let text = room_call(&room, |reply| RoomMsg::GetText { reply }).await?;
        let bytes = text.into_bytes();
        let hash = sha256_hex(&bytes);
        if att.content_hash.as_deref() == Some(hash.as_str()) {
            clear_if_unchanged();
            return Ok(Some(hash)); // already materialized (e.g. right after an ingest)
        }
        let backend = backend_from_conn(&att.kind, &att.config)?;
        let etag = match backend.write(&att.rel_path, &bytes).await {
            Ok(etag) => {
                self.health.record_ok(att.storage_conn_id);
                etag
            }
            Err(e) => {
                self.health.record_err(att.storage_conn_id, &e);
                return Err(e);
            }
        };
        self.persistence
            .set_content_hash(document_id, &hash)
            .await?;
        // Bounded retention (spec §5): the bytes for `hash` are now durable in the
        // customer's backend — history covered by the latest snapshot may be pruned.
        // This is the ONLY call site; the invariant "never prune unmaterialized
        // content" lives here, not in prune_history.
        let retention = match self
            .persistence
            .workspace_retention_for_document(document_id)
            .await
        {
            Ok(Some(retention)) => Some(retention),
            Ok(None) => Some(retention_default().to_string()),
            Err(e) => {
                warn!(%document_id, %e, "retention lookup failed; skipping pruning this pass (fail-safe)");
                None
            }
        };

        if let Some(retention) = retention {
            if retention == "bounded" {
                match self.persistence.prune_history(document_id).await {
                    Ok((0, 0)) => {}
                    Ok((u, s)) => {
                        debug!(%document_id, updates = u, snapshots = s, "pruned history (bounded retention)")
                    }
                    Err(e) => warn!(%document_id, %e, "history pruning failed (non-fatal)"),
                }
            }
        }
        clear_if_unchanged();
        debug!(doc = %att.slug, rel_path = %att.rel_path, %etag, "materialized to storage backend");
        Ok(Some(hash))
    }

    /// Re-home an attached document after a folder move/rename OR a title change:
    /// recompute the rel_path from its folder chain and current title, copy the canonical
    /// file to the new path, and delete the old one. No-op for unattached (or trashed)
    /// documents and unchanged paths.
    ///
    /// The file *stem* tracks the document's display title (sanitized like the desktop
    /// client's local file, see [`rel_path_for_named`]) so a title change renames the
    /// backend file; it falls back to the slug when the title is empty.
    ///
    /// Order matters: the DB row moves FIRST (a unique-index collision aborts before any
    /// backend write), then bytes move. If a backend op fails after the row moved, the
    /// next materialize writes the new path anyway (set_rel_path cleared content_hash);
    /// at worst the old file lingers — surfaced, never silently lost (ADR 0021).
    ///
    /// Titles are not unique (slugs are): if the title-based path collides with another
    /// attached document on the same connection (the `documents_storage_path` unique
    /// index), we FALL BACK to the slug-based path — never erroring, never losing bytes.
    pub async fn relocate(&self, document_id: Uuid) -> Result<()> {
        let Some(att) = self.persistence.document_attachment(document_id).await? else {
            return Ok(());
        };
        let doc = self
            .persistence
            .find_document(&att.slug)
            .await?
            .ok_or_else(|| anyhow!("document vanished during relocate"))?;
        let chain = self.persistence.folder_chain_names(doc.folder_id).await?;
        // The stem is the display title when present and non-empty, else the slug.
        let stem = doc
            .title
            .as_deref()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or(&att.slug);
        let new_rel = rel_path_for_named(&chain, stem);
        if new_rel == att.rel_path {
            return Ok(());
        }
        // DB-first move with collision fallback. Returns the path the row actually landed
        // on (None ⇒ left as-is: both title- and slug-based paths were taken).
        let Some(final_rel) = self
            .set_rel_path_with_fallback(document_id, &att.slug, &chain, &new_rel)
            .await?
        else {
            return Ok(());
        };
        // The collision fallback may have reverted the row to its CURRENT path (e.g. the
        // title collided and the slug-based fallback IS where the file already lives). The
        // earlier `new_rel == att.rel_path` guard only covered the title path, not this
        // post-fallback one — so guard again here, BEFORE any byte I/O. Without this a
        // same-key write-then-delete would destroy the canonical file (the delete removes
        // exactly what the write just put back). The fallback's set_rel_path having cleared
        // content_hash / bumped updated_at is harmless: the next materialize rewrites the
        // same path if needed.
        if final_rel == att.rel_path {
            return Ok(());
        }
        let backend = backend_from_conn(&att.kind, &att.config)?;
        match backend.read(&att.rel_path).await? {
            Some((bytes, _etag)) => {
                backend.write(&final_rel, &bytes).await?;
                backend.delete(&att.rel_path).await?;
                self.persistence
                    .set_content_hash(document_id, &sha256_hex(&bytes))
                    .await?;
            }
            None => {
                // Never materialized (or externally removed): write fresh at the new path.
                self.materialize(document_id).await?;
            }
        }
        info!(doc = %att.slug, from = %att.rel_path, to = %final_rel, "relocated document in storage backend");
        Ok(())
    }

    /// Attach one document with the title→slug rel_path fallback (shared by
    /// bind_workspace and attach_new_document). Ok(None) = both paths collided, skipped.
    async fn attach_doc_with_fallback(
        &self,
        doc: &crate::persistence::UnattachedDoc,
        conn_id: Uuid,
    ) -> Result<Option<String>> {
        let chain = self.persistence.folder_chain_names(doc.folder_id).await?;
        let stem = doc
            .title
            .as_deref()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or(&doc.slug);
        let rel = rel_path_for_named(&chain, stem);
        match self
            .persistence
            .attach_document_storage(doc.id, conn_id, &rel)
            .await
        {
            Ok(()) => Ok(Some(rel)),
            Err(e) if e.to_string().contains("documents_storage_path") => {
                let slug_rel = rel_path_for(&chain, &doc.slug);
                match self
                    .persistence
                    .attach_document_storage(doc.id, conn_id, &slug_rel)
                    .await
                {
                    Ok(()) => Ok(Some(slug_rel)),
                    Err(e2) if e2.to_string().contains("documents_storage_path") => {
                        warn!(doc = %doc.slug, "auto-attach: both storage paths collided; skipping");
                        Ok(None)
                    }
                    Err(e2) => Err(e2),
                }
            }
            Err(e) => Err(e),
        }
    }

    /// Auto-attach for newly created documents (plan 1a task 8): when the document's
    /// workspace is bound, attach + materialize. Ok(false) = workspace unbound, no-op.
    pub async fn attach_new_document(&self, document_id: Uuid) -> Result<bool> {
        let Some(doc) = self.persistence.unattached_document(document_id).await? else {
            return Ok(false); // already attached, trashed, or gone
        };
        let Some(ws_id) = doc.workspace_id else {
            return Ok(false);
        };
        let Some(meta) = self.persistence.workspace_meta(ws_id).await? else {
            return Ok(false);
        };
        let Some(conn_id) = meta.storage_conn_id else {
            return Ok(false);
        };
        let unattached = crate::persistence::UnattachedDoc {
            id: doc.id,
            slug: doc.slug,
            folder_id: doc.folder_id,
            title: doc.title,
        };
        if self
            .attach_doc_with_fallback(&unattached, conn_id)
            .await?
            .is_none()
        {
            return Ok(false);
        }
        if let Err(e) = self.materialize(document_id).await {
            warn!(%document_id, %e, "auto-attach materialize failed (debounce/poll retries)");
        }
        Ok(true)
    }

    /// Bind a probed connection to a workspace (plan 1a): activate, then attach and
    /// materialize every live unattached document. Used by the REST connect handler and
    /// the gdrive OAuth callback — the single place the pending→active transition happens.
    /// Attachment failures on individual documents are logged and skipped (the doc stays
    /// unattached and a later re-connect retries); the bind itself still succeeds.
    pub async fn bind_workspace(&self, workspace_id: Uuid, conn_id: Uuid) -> Result<usize> {
        self.persistence
            .activate_workspace_with_storage(workspace_id, conn_id)
            .await?;
        let docs = self
            .persistence
            .unattached_documents_in_workspace(workspace_id)
            .await?;
        let mut attached = 0usize;
        for doc in docs {
            let rel = match self.attach_doc_with_fallback(&doc, conn_id).await {
                Ok(Some(rel)) => rel,
                Ok(None) => continue, // both paths collided; already warned
                Err(e) => {
                    warn!(doc = %doc.slug, %e, "bind: attach failed; skipping document");
                    continue;
                }
            };
            if let Err(e) = self.materialize(doc.id).await {
                warn!(doc = %doc.slug, rel_path = %rel, %e,
                      "bind: initial materialize failed (poll/debounce will retry)");
            }
            attached += 1;
        }
        info!(%workspace_id, %conn_id, attached, "workspace storage bound");
        Ok(attached)
    }

    /// Move the DB row to `new_rel`, falling back to the slug-based path on a unique-index
    /// collision (a non-unique title clashing with another attached doc). Returns the
    /// chosen path, or `None` when even the slug-based path is taken (row left untouched).
    /// Pure DB work — no backend I/O — so it's exercised by the DB-gated relocate tests.
    async fn set_rel_path_with_fallback(
        &self,
        document_id: Uuid,
        slug: &str,
        chain: &[String],
        new_rel: &str,
    ) -> Result<Option<String>> {
        match self.persistence.set_rel_path(document_id, new_rel).await {
            Ok(()) => Ok(Some(new_rel.to_string())),
            Err(e) if e.to_string().contains("documents_storage_path") => {
                let slug_rel = rel_path_for(chain, slug);
                if slug_rel == new_rel {
                    warn!(doc = %slug, rel_path = %new_rel, "storage path collision; leaving rel_path as-is");
                    return Ok(None);
                }
                match self.persistence.set_rel_path(document_id, &slug_rel).await {
                    Ok(()) => {
                        warn!(doc = %slug, title_path = %new_rel, slug_path = %slug_rel,
                              "title-based storage path collided; fell back to slug-based path");
                        Ok(Some(slug_rel))
                    }
                    Err(e2) if e2.to_string().contains("documents_storage_path") => {
                        warn!(doc = %slug, slug_path = %slug_rel,
                              "both title- and slug-based storage paths collided; leaving rel_path as-is");
                        Ok(None)
                    }
                    Err(e2) => Err(e2),
                }
            }
            Err(e) => Err(e),
        }
    }

    /// One poll pass over a single attached document: fetch, hash-guard, ingest.
    async fn poll_one(&self, att: &AttachedDoc) -> Result<()> {
        if self
            .pending_materialize
            .lock()
            .unwrap()
            .contains_key(&att.document_id)
        {
            // A room edit is awaiting its debounced write. Ingesting a full external
            // snapshot now would diff that edit away (lost update); defer to the next
            // tick — the materialize's sha-CAS handles any real conflict first.
            debug!(doc = %att.slug, "skipping poll ingest: materialize pending");
            return Ok(());
        }
        let backend = backend_from_conn(&att.kind, &att.config)?;
        let read = match backend.read(&att.rel_path).await {
            Ok(read) => {
                self.health.record_ok(att.storage_conn_id);
                read
            }
            Err(e) => {
                self.health.record_err(att.storage_conn_id, &e);
                return Err(e);
            }
        };
        let Some((bytes, _etag)) = read else {
            return Ok(()); // object gone/not yet written; nothing to ingest
        };
        let hash = sha256_hex(&bytes);
        if att.content_hash.as_deref() == Some(hash.as_str()) {
            return Ok(()); // our own materialization — the echo-loop guard (ADR 0013)
        }
        let text = String::from_utf8(bytes)
            .map_err(|_| anyhow!("object {} is not valid UTF-8 markdown", att.rel_path))?;
        let room = self.ensure_room(&att.slug);
        let seq = room_call(&room, |reply| RoomMsg::IngestText { text, reply })
            .await?
            .map_err(|e| anyhow!("ingest failed: {e}"))?;
        self.persistence
            .set_content_hash(att.document_id, &hash)
            .await?;
        info!(doc = %att.slug, rel_path = %att.rel_path, seq, "ingested out-of-band change from storage backend");
        // A nested rel_path discovered by ingest implies a folder placement: get-or-
        // create the chain (in the storage connection's workspace) and place the
        // document, so attachments that predate folders join the tree on first change.
        if att.rel_path.contains('/') {
            let mut dirs: Vec<&str> = att.rel_path.split('/').collect();
            dirs.pop(); // the file name
                        // Externally-influenced names (e.g. a Drive file whose '∕' maps back to '/')
                        // must never mint '.'/'..'/empty folders — that pollutes the folder tree and
                        // produces traversal-shaped backend keys on the next relocate. The ingest
                        // above already succeeded; only the folder placement is skipped.
            if dirs.iter().all(|d| crate::folders::valid_folder_name(d)) {
                let leaf = self
                    .persistence
                    .ensure_folder_chain(Some(att.workspace_id), &dirs)
                    .await?;
                if leaf != att.folder_id {
                    self.persistence
                        .set_document_folder(att.document_id, leaf)
                        .await?;
                    debug!(doc = %att.slug, rel_path = %att.rel_path, "placed document into its rel_path folder chain");
                }
            } else {
                warn!(doc = %att.slug, rel_path = %att.rel_path,
                      "skipping folder placement: rel_path contains invalid folder segment(s)");
            }
        }
        Ok(())
    }
}

async fn room_call<T>(
    room: &mpsc::UnboundedSender<RoomMsg>,
    make: impl FnOnce(oneshot::Sender<T>) -> RoomMsg,
) -> Result<T> {
    let (tx, rx) = oneshot::channel();
    room.send(make(tx)).map_err(|_| anyhow!("room is gone"))?;
    rx.await.map_err(|_| anyhow!("room dropped the request"))
}

/// Coalesce dirty pings per document: a fresh ping while a debounce task is pending
/// restarts its window; the write happens DEBOUNCE after the burst goes quiet.
async fn debounce_loop(mgr: Arc<StorageManager>, mut rx: mpsc::UnboundedReceiver<Uuid>) {
    let mut pending: HashMap<Uuid, mpsc::UnboundedSender<()>> = HashMap::new();
    while let Some(doc_id) = rx.recv().await {
        // Every ping bumps the dirty generation; the poll loop must not ingest over
        // un-materialized room edits (see StorageManager::pending_materialize).
        *mgr.pending_materialize
            .lock()
            .unwrap()
            .entry(doc_id)
            .or_insert(0) += 1;
        if let Some(tx) = pending.get(&doc_id) {
            if tx.send(()).is_ok() {
                continue; // an active debouncer absorbed the ping
            }
        }
        let (tx, mut reset) = mpsc::unbounded_channel();
        pending.insert(doc_id, tx);
        let mgr = mgr.clone();
        tokio::spawn(async move {
            // Every edit restarts the window; quiet (or shutdown) falls through to write.
            while let Ok(Some(())) = tokio::time::timeout(DEBOUNCE, reset.recv()).await {}
            if let Err(e) = mgr.materialize(doc_id).await {
                warn!(%doc_id, %e, "materialize to storage backend failed (will retry on the next edit)");
            }
        });
    }
}

/// Out-of-band ingest by polling (ADR 0013: neither S3 nor the Contents API pushes in
/// this deployment shape). The loop, the sha256 echo-guard (content_hash), and the
/// IngestText path are backend-agnostic — both backends ride the same machinery.
async fn poll_loop(mgr: Arc<StorageManager>) {
    // MUESLI_STORAGE_POLL_SECS is the backend-agnostic name; MUESLI_S3_POLL_SECS
    // predates the second backend and keeps working.
    let secs = std::env::var("MUESLI_STORAGE_POLL_SECS")
        .or_else(|_| std::env::var("MUESLI_S3_POLL_SECS"))
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|s| *s > 0)
        .unwrap_or(DEFAULT_POLL_SECS);
    info!(
        every_secs = secs,
        "storage poll loop running (out-of-band ingest, ADR 0013)"
    );
    loop {
        tokio::time::sleep(Duration::from_secs(secs)).await;
        let docs = match mgr.persistence.attached_documents().await {
            Ok(d) => d,
            Err(e) => {
                warn!(%e, "storage poll: listing attached documents failed");
                continue;
            }
        };
        for att in docs {
            if let Err(e) = mgr.poll_one(&att).await {
                warn!(doc = %att.slug, rel_path = %att.rel_path, %e, "storage poll failed for document");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // The AWS SigV4 reference vector (get-vanilla-query / the IAM ListUsers example from
    // https://docs.aws.amazon.com/IAM/latest/UserGuide/signing-elements.html).
    const SECRET: &str = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

    /// MUESLI_S3_ACCESS_KEY / MUESLI_S3_SECRET_KEY are process-global. `cargo test` runs
    /// tests in parallel by default, so the two tests below that mutate them
    /// (`s3_credentials_resolution_config_then_env`, `minio_probe_and_round_trip`) share
    /// this lock to serialize their env writes instead of racing each other.
    // tokio (not std) Mutex: minio_probe_and_round_trip must hold it across its
    // awaits, which an async-aware lock supports without clippy::await_holding_lock.
    static S3_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[test]
    fn sigv4_matches_the_aws_reference_vector() {
        let creq = canonical_request(
            "GET",
            "/",
            "Action=ListUsers&Version=2010-05-08",
            &[
                (
                    "content-type",
                    "application/x-www-form-urlencoded; charset=utf-8",
                ),
                ("host", "iam.amazonaws.com"),
                ("x-amz-date", "20150830T123600Z"),
            ],
            EMPTY_SHA256,
        );
        assert_eq!(
            sha256_hex(creq.as_bytes()),
            "f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59"
        );
        let sts = string_to_sign(
            "20150830T123600Z",
            "20150830/us-east-1/iam/aws4_request",
            &creq,
        );
        let key = signing_key(SECRET, "20150830", "us-east-1", "iam");
        assert_eq!(
            hex(&hmac_sha256(&key, sts.as_bytes())),
            "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"
        );
    }

    #[test]
    fn hmac_sha256_rfc4231_vector() {
        // RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?"
        assert_eq!(
            hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // and a key longer than the block size (RFC 4231 test case 6 prefix check)
        let long_key = [0xaau8; 131];
        assert_eq!(
            hex(&hmac_sha256(
                &long_key,
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn uri_encoding_follows_aws_rules() {
        assert_eq!(uri_encode("docs/My Notes.md", false), "docs/My%20Notes.md");
        assert_eq!(uri_encode("docs/My Notes.md", true), "docs%2FMy%20Notes.md");
        assert_eq!(uri_encode("a-b_c.d~e", true), "a-b_c.d~e");
        assert_eq!(uri_encode("☕", true), "%E2%98%95");
    }

    #[test]
    fn amz_date_formats_utc() {
        // 2015-08-30T12:36:00Z = 1440938160 (the reference vector's timestamp)
        let t = UNIX_EPOCH + Duration::from_secs(1_440_938_160);
        assert_eq!(amz_date(t), ("20150830".into(), "20150830T123600Z".into()));
        let epoch = amz_date(UNIX_EPOCH);
        assert_eq!(epoch, ("19700101".into(), "19700101T000000Z".into()));
        // a leap-year date: 2024-02-29T00:00:00Z
        let leap = amz_date(UNIX_EPOCH + Duration::from_secs(1_709_164_800));
        assert_eq!(leap, ("20240229".into(), "20240229T000000Z".into()));
    }

    /// plan 1a task 10: the health registry reflects the last materialize/poll outcome.
    #[test]
    fn conn_health_records_ok_and_error() {
        let reg = HealthRegistry::default();
        let conn = Uuid::now_v7();
        assert!(reg.get(conn).is_none());
        reg.record_ok(conn);
        let h = reg.get(conn).unwrap();
        assert!(h.healthy);
        assert!(h.last_ok_unix.is_some());
        assert_eq!(h.last_error, None);
        reg.record_err(conn, &anyhow!("s3 PUT x: 403 AccessDenied"));
        let h = reg.get(conn).unwrap();
        assert!(!h.healthy);
        assert_eq!(h.last_error.as_deref(), Some("s3 PUT x: 403 AccessDenied"));
        assert!(h.last_ok_unix.is_some(), "previous success is retained");
        reg.record_ok(conn);
        assert!(
            reg.get(conn).unwrap().healthy,
            "recovery clears the error flag"
        );
    }

    /// Fix 6 (BYO storage final review): a health error can carry the backend's raw
    /// response — for S3 that's sometimes an XML document echoing the access key id used
    /// for the failed request. That must never survive into the in-memory registry (it's
    /// served back over the storage/status endpoint), and one pathological error can't be
    /// allowed to grow the registry unbounded.
    #[test]
    fn record_err_redacts_aws_keys_and_truncates() {
        let reg = HealthRegistry::default();
        let conn = Uuid::now_v7();

        // A real-shaped S3 "invalid access key" XML error (AKIAIOSFODNN7EXAMPLE is AWS's
        // own well-known example key — 4-letter prefix + 16 uppercase-alphanumeric chars).
        let xml = "<Error><Code>InvalidAccessKeyId</Code><Message>The AWS Access Key Id you \
                    provided does not exist in our records.</Message>\
                    <AWSAccessKeyId>AKIAIOSFODNN7EXAMPLE</AWSAccessKeyId></Error>";
        reg.record_err(conn, &anyhow!(xml.to_string()));
        let stored = reg.get(conn).unwrap().last_error.unwrap();
        assert!(
            !stored.contains("AKIAIOSFODNN7EXAMPLE"),
            "access key leaked: {stored}"
        );
        assert!(
            stored.contains("…redacted…"),
            "redaction marker missing: {stored}"
        );
        assert!(
            stored.contains("InvalidAccessKeyId"),
            "non-secret context should survive: {stored}"
        );

        // A temporary-credential ASIA-prefixed key is redacted the same way.
        reg.record_err(
            conn,
            &anyhow!("denied for ASIAABCDEFGHIJKLMNOP".to_string()),
        );
        let stored = reg.get(conn).unwrap().last_error.unwrap();
        assert!(!stored.contains("ASIAABCDEFGHIJKLMNOP"));
        assert!(stored.contains("…redacted…"));

        // Truncation: a long error string is capped at 500 chars.
        reg.record_err(conn, &anyhow!("x".repeat(2000)));
        let stored = reg.get(conn).unwrap().last_error.unwrap();
        assert_eq!(stored.chars().count(), 500);
    }

    /// Fix wave (SharePoint phase 2 final review): a health error can embed a full
    /// pre-authenticated Graph URL — `@microsoft.graph.downloadUrl` carries a live
    /// tempauth token, `uploadUrl` a write-capable signature — in its query string.
    /// `sanitize_health_error` must strip the query while keeping scheme/host/path so
    /// the status endpoint stays useful for debugging without leaking the credential.
    #[test]
    fn sanitize_health_error_strips_url_queries() {
        let raw = "sharepoint download rel: error sending request for url \
                    (https://contoso.sharepoint.com/_layouts/15/download.aspx?UniqueId=abc&tempauth=EwB4A8l6BAAU123secret): \
                    transport error";
        let out = sanitize_health_error(raw);
        assert!(!out.contains("tempauth"), "{out}");
        assert!(!out.contains("EwB4A8l6BAAU123secret"), "{out}");
        assert!(
            out.contains("https://contoso.sharepoint.com/_layouts/15/download.aspx?…"),
            "scheme/host/path should survive: {out}"
        );

        // no URL at all: passthrough
        assert_eq!(
            sanitize_health_error("plain error, no url"),
            "plain error, no url"
        );
        // a URL with no query string is left untouched
        let no_query = "graph GET https://graph.microsoft.com/v1.0/sites/x failed";
        assert_eq!(sanitize_health_error(no_query), no_query);
        // plain-http URLs (test/dev deployments, endpoint overrides) are stripped too
        let out = sanitize_health_error("GET http://127.0.0.1:9000/dl?tempauth=SECRET failed");
        assert!(!out.contains("SECRET"), "{out}");
        assert!(out.contains("http://127.0.0.1:9000/dl?…"), "{out}");
    }

    /// Per-workspace credentials: config-borne creds win; env is the legacy fallback.
    /// Env-var tests are process-global — this single test covers both branches
    /// sequentially to avoid parallel-test races on the env.
    #[test]
    fn s3_credentials_resolution_config_then_env() {
        let _guard = S3_ENV_LOCK.blocking_lock();
        // MUESLI_SECRET_KEY is mutated below; serialize with every other module's
        // secret-key tests (module lock first, then this one — consistent order).
        let _sk_guard = crate::secrets::SECRET_KEY_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let key = crate::secrets::parse_secret_key(
            "0101010101010101010101010101010101010101010101010101010101010101",
        )
        .unwrap();
        let enc = crate::secrets::encrypt_secret_with_key(&key, "cfg-secret");
        std::env::set_var(
            "MUESLI_SECRET_KEY",
            "0101010101010101010101010101010101010101010101010101010101010101",
        );

        // 1) config credentials present → they win, env not consulted.
        std::env::remove_var("MUESLI_S3_ACCESS_KEY");
        std::env::remove_var("MUESLI_S3_SECRET_KEY");
        let config = serde_json::json!({
            "endpoint": "https://s3.example.com", "bucket": "b",
            "access_key_id": "AKIACONFIG", "secret_key_enc": enc,
        });
        let backend = S3Backend::from_conn("s3", &config).expect("config creds suffice");
        assert_eq!(backend.access_key, "AKIACONFIG");
        assert_eq!(backend.secret_key, "cfg-secret");

        // 2) no config credentials → env fallback (grandfathered rows).
        std::env::set_var("MUESLI_S3_ACCESS_KEY", "AKIAENV");
        std::env::set_var("MUESLI_S3_SECRET_KEY", "env-secret");
        let legacy = serde_json::json!({"endpoint": "https://s3.example.com", "bucket": "b"});
        let backend = S3Backend::from_conn("s3", &legacy).expect("env fallback works");
        assert_eq!(backend.access_key, "AKIAENV");
        assert_eq!(backend.secret_key, "env-secret");

        // 3) neither → error.
        std::env::remove_var("MUESLI_S3_ACCESS_KEY");
        std::env::remove_var("MUESLI_S3_SECRET_KEY");
        assert!(S3Backend::from_conn("s3", &legacy).is_err());
        std::env::remove_var("MUESLI_SECRET_KEY");
    }

    /// Unsets an env var when dropped — including on panic/assertion-failure unwind, unlike
    /// a plain `remove_var` call after the fact. Keeps `minio_probe_and_round_trip` from
    /// leaking grandfathered S3 creds into whichever test runs next in the same process if
    /// a probe assertion fails partway through.
    struct EnvVarGuard(&'static str);
    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            std::env::remove_var(self.0);
        }
    }

    /// Full S3 cycle against a live MinIO (plan 1a task 12). Gated on MUESLI_TEST_S3_*:
    ///   docker run --rm -p 9000:9000 -e MINIO_ROOT_USER=muesli -e MINIO_ROOT_PASSWORD=muesli-secret minio/minio server /data
    ///   mc alias set local http://127.0.0.1:9000 muesli muesli-secret && mc mb local/muesli-test
    ///   MUESLI_TEST_S3_ENDPOINT=http://127.0.0.1:9000 MUESLI_TEST_S3_BUCKET=muesli-test \
    ///   MUESLI_TEST_S3_ACCESS_KEY=muesli MUESLI_TEST_S3_SECRET_KEY=muesli-secret \
    ///   cargo test -p muesli-server minio_probe_and_round_trip
    #[tokio::test]
    async fn minio_probe_and_round_trip() {
        let Ok(endpoint) = std::env::var("MUESLI_TEST_S3_ENDPOINT") else {
            eprintln!("skipping: set MUESLI_TEST_S3_* to run minio_probe_and_round_trip");
            return;
        };
        // Shares S3_ENV_LOCK with s3_credentials_resolution_config_then_env: both mutate
        // the process-global MUESLI_S3_ACCESS_KEY / MUESLI_S3_SECRET_KEY env vars, and
        // cargo test's default parallel runner would otherwise let them race. Drop order
        // (declaration-reverse) unsets the env vars before releasing the lock.
        let _guard = S3_ENV_LOCK.lock().await;
        let bucket = std::env::var("MUESLI_TEST_S3_BUCKET").expect("MUESLI_TEST_S3_BUCKET");
        std::env::set_var(
            "MUESLI_S3_ACCESS_KEY",
            std::env::var("MUESLI_TEST_S3_ACCESS_KEY").expect("MUESLI_TEST_S3_ACCESS_KEY"),
        );
        let _access_guard = EnvVarGuard("MUESLI_S3_ACCESS_KEY");
        std::env::set_var(
            "MUESLI_S3_SECRET_KEY",
            std::env::var("MUESLI_TEST_S3_SECRET_KEY").expect("MUESLI_TEST_S3_SECRET_KEY"),
        );
        let _secret_guard = EnvVarGuard("MUESLI_S3_SECRET_KEY");
        let config = serde_json::json!({
            "endpoint": endpoint, "bucket": bucket, "prefix": format!("e2e-{}", Uuid::now_v7()),
        });
        let backend = S3Backend::from_conn("s3", &config).unwrap();
        backend
            .probe()
            .await
            .expect("probe cycle (write/read/delete)");
        // And a normal document round-trip beside it.
        let etag = backend.write("notes/Test Doc.md", b"# hi\n").await.unwrap();
        assert!(!etag.is_empty());
        let (bytes, _) = backend.read("notes/Test Doc.md").await.unwrap().unwrap();
        assert_eq!(bytes, b"# hi\n");
        let listed = backend.list("").await.unwrap();
        assert!(listed.iter().any(|(k, _)| k == "notes/Test Doc.md"));
        backend.delete("notes/Test Doc.md").await.unwrap();
        assert!(backend.read("notes/Test Doc.md").await.unwrap().is_none());
    }

    #[test]
    fn github_contents_url_building() {
        assert_eq!(
            contents_url(
                "https://api.github.com",
                "octo",
                "notes",
                "docs/My Notes.md"
            ),
            "https://api.github.com/repos/octo/notes/contents/docs/My%20Notes.md"
        );
        // Gitea/Forgejo api_base includes /api/v1; trailing slash is tolerated.
        assert_eq!(
            contents_url(
                "http://localhost:3300/api/v1/",
                "muesli",
                "muesli-e2e",
                "a.md"
            ),
            "http://localhost:3300/api/v1/repos/muesli/muesli-e2e/contents/a.md"
        );
        // `/` separates path segments; everything else non-unreserved is escaped.
        assert_eq!(
            contents_url("https://h/api/v1", "o", "r", "x/y z/☕.md"),
            "https://h/api/v1/repos/o/r/contents/x/y%20z/%E2%98%95.md"
        );
    }

    #[test]
    fn github_prefix_joining() {
        assert_eq!(join_repo_path("", "doc.md"), "doc.md");
        assert_eq!(join_repo_path("notes/", "doc.md"), "notes/doc.md");
        assert_eq!(join_repo_path("a/b/", "/doc.md"), "a/b/doc.md");
        assert_eq!(join_repo_path("a/b/", "c/doc.md"), "a/b/c/doc.md");
    }

    #[test]
    fn github_contents_base64_round_trip() {
        use base64::Engine as _;
        let text = "# Notes\n\nhello ☕ world\n";
        let encoded = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
        assert_eq!(decode_contents_base64(&encoded).unwrap(), text.as_bytes());
        // GitHub wraps the payload in newlines every 60 chars; Gitea doesn't.
        let wrapped: String = encoded
            .as_bytes()
            .chunks(60)
            .map(|c| format!("{}\n", std::str::from_utf8(c).unwrap()))
            .collect();
        assert_eq!(decode_contents_base64(&wrapped).unwrap(), text.as_bytes());
        assert!(decode_contents_base64("!!! not base64 !!!").is_err());
    }

    #[test]
    fn github_commit_message_choice() {
        assert_eq!(
            commit_message(false, "notes/a.md"),
            "muesli: create notes/a.md"
        );
        assert_eq!(
            commit_message(true, "notes/a.md"),
            "muesli: update notes/a.md"
        );
    }

    #[test]
    fn rel_path_from_folder_chain() {
        assert_eq!(rel_path_for(&[], "notes"), "notes.md");
        assert_eq!(
            rel_path_for(&["Projects".into()], "notes"),
            "Projects/notes.md"
        );
        assert_eq!(
            rel_path_for(&["Projects".into(), "Sub Folder".into()], "my-doc"),
            "Projects/Sub Folder/my-doc.md"
        );
    }

    #[test]
    fn rel_path_for_named_tracks_the_title_case_preserving() {
        // A human title keeps its case and spaces — NOT slugified.
        assert_eq!(rel_path_for_named(&[], "Test File"), "Test File.md");
        // The folder chain joins exactly like rel_path_for.
        assert_eq!(
            rel_path_for_named(&["Folder".into(), "Sub".into()], "Test File"),
            "Folder/Sub/Test File.md"
        );
        // A separator in the title is folded to '-' (folders never contain '/').
        assert_eq!(rel_path_for_named(&[], "a/b"), "a-b.md");
        // Empty / whitespace-only titles fall back to "untitled".
        assert_eq!(rel_path_for_named(&[], ""), "untitled.md");
        assert_eq!(rel_path_for_named(&[], "   "), "untitled.md");
        // Leading dots are stripped (no accidental dotfiles).
        assert_eq!(rel_path_for_named(&[], ".hidden"), "hidden.md");
        // For a plain slug with no special chars, the named path equals the legacy path.
        assert_eq!(
            rel_path_for_named(&[], "my-doc"),
            rel_path_for(&[], "my-doc")
        );
        assert_eq!(
            rel_path_for_named(&["Projects".into()], "my-doc"),
            rel_path_for(&["Projects".into()], "my-doc")
        );
    }

    #[test]
    fn rel_path_validation_rejects_traversal_shapes() {
        // clean relative paths pass
        assert!(validate_rel_path("doc.md").is_ok());
        assert!(validate_rel_path("Projects/Sub Folder/my-doc.md").is_ok());
        // traversal / absolute / separator abuse is an error, never sanitized
        assert!(validate_rel_path("").is_err());
        assert!(validate_rel_path("/abs.md").is_err());
        assert!(validate_rel_path("../escape.md").is_err());
        assert!(validate_rel_path("a/../b.md").is_err());
        assert!(validate_rel_path("a/./b.md").is_err());
        assert!(validate_rel_path("a//b.md").is_err());
        assert!(validate_rel_path("a\\b.md").is_err());
        assert!(validate_rel_path("teamA/../teamB/secrets.md").is_err());
        // list prefixes: "" and trailing '/' are fine, traversal is not
        assert!(validate_list_prefix("").is_ok());
        assert!(validate_list_prefix("notes/").is_ok());
        assert!(validate_list_prefix("../notes/").is_err());
        // A leading-dot directory is not the same as a "." segment: the probe path lives here.
        assert!(validate_rel_path(".muesli/probe-x").is_ok());
    }

    /// The copy-paste IAM policy the wizard shows (plan 1a task 5): scoped to exactly the
    /// bucket + prefix, ListBucket condition included only when a prefix is set.
    #[test]
    fn iam_policy_is_bucket_and_prefix_scoped() {
        let p = s3_iam_policy("my-bucket", "team-notes");
        let statements = p["Statement"].as_array().unwrap();
        assert_eq!(statements.len(), 2);
        assert_eq!(
            statements[0]["Action"],
            serde_json::json!(["s3:ListBucket"])
        );
        assert_eq!(
            statements[0]["Resource"],
            serde_json::json!("arn:aws:s3:::my-bucket")
        );
        assert_eq!(
            statements[0]["Condition"]["StringLike"]["s3:prefix"],
            serde_json::json!("team-notes/*")
        );
        assert_eq!(
            statements[1]["Action"],
            serde_json::json!(["s3:GetObject", "s3:PutObject", "s3:DeleteObject"])
        );
        assert_eq!(
            statements[1]["Resource"],
            serde_json::json!("arn:aws:s3:::my-bucket/team-notes/*")
        );

        // No prefix: the ListBucket condition disappears and objects cover the whole bucket.
        let p = s3_iam_policy("my-bucket", "");
        let statements = p["Statement"].as_array().unwrap();
        assert!(statements[0].get("Condition").is_none());
        assert_eq!(
            statements[1]["Resource"],
            serde_json::json!("arn:aws:s3:::my-bucket/*")
        );
    }

    #[tokio::test]
    async fn backends_refuse_traversal_rel_paths_before_any_request() {
        // Point at a dead endpoint: validation must reject BEFORE any I/O happens.
        let backend = GithubBackend {
            http: reqwest::Client::new(),
            api_base: "http://127.0.0.1:1".into(),
            owner: "o".into(),
            repo: "r".into(),
            branch: "main".into(),
            prefix: "teamA/".into(),
            token: "test-token".into(),
        };
        assert!(backend.read("../teamB/secrets.md").await.is_err());
        assert!(backend.write("../teamB/secrets.md", b"x").await.is_err());
        assert!(backend.delete("../teamB/secrets.md").await.is_err());
        assert!(backend.list("../teamB").await.is_err());
    }

    #[test]
    fn sanitize_filename_segment_mirrors_muesli_cli() {
        assert_eq!(sanitize_filename_segment("Test File"), "Test File");
        assert_eq!(sanitize_filename_segment("a/b"), "a-b");
        assert_eq!(sanitize_filename_segment("  trimmed  "), "trimmed");
        assert_eq!(sanitize_filename_segment(".dotfile"), "dotfile");
        assert_eq!(sanitize_filename_segment("..."), "untitled");
        assert_eq!(sanitize_filename_segment(""), "untitled");
    }

    /// Contents API delete: GET resolves the sha, DELETE carries it (CAS); a missing
    /// file (GET 404) is an idempotent no-op without any DELETE.
    #[tokio::test]
    async fn github_delete_uses_sha_and_is_idempotent() {
        use base64::Engine as _;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Mutex;

        let deletes = Arc::new(AtomicUsize::new(0));
        let delete_bodies: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"bye");
        let del = deletes.clone();
        let bodies = delete_bodies.clone();
        let app = axum::Router::new().route(
            "/repos/o/r/contents/{*path}",
            axum::routing::get(
                move |axum::extract::Path(path): axum::extract::Path<String>| {
                    let b64 = b64.clone();
                    async move {
                        if path == "old/doc.md" {
                            (
                                axum::http::StatusCode::OK,
                                axum::Json(serde_json::json!({
                                    "type": "file", "encoding": "base64",
                                    "sha": "deadsha", "content": b64,
                                })),
                            )
                        } else {
                            (
                                axum::http::StatusCode::NOT_FOUND,
                                axum::Json(serde_json::json!({})),
                            )
                        }
                    }
                },
            )
            .delete(move |body: axum::Json<Value>| {
                let del = del.clone();
                let bodies = bodies.clone();
                async move {
                    del.fetch_add(1, Ordering::SeqCst);
                    bodies.lock().unwrap().push(body.0);
                    axum::Json(serde_json::json!({"content": null}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let backend = GithubBackend {
            http: reqwest::Client::new(),
            api_base: format!("http://{addr}"),
            owner: "o".into(),
            repo: "r".into(),
            branch: "main".into(),
            prefix: "".into(),
            token: "test-token".into(),
        };
        backend.delete("old/doc.md").await.unwrap();
        assert_eq!(deletes.load(Ordering::SeqCst), 1);
        let body = delete_bodies.lock().unwrap()[0].clone();
        assert_eq!(body["sha"], "deadsha");
        assert_eq!(body["branch"], "main");
        assert_eq!(body["message"], "muesli: delete old/doc.md");
        // absent file: no DELETE request at all
        backend.delete("never/was.md").await.unwrap();
        assert_eq!(deletes.load(Ordering::SeqCst), 1);
    }

    /// The sha-conflict path, deterministically: a mock Contents API rejects the first
    /// PUT with 409 (as if a commit raced our sha fetch), serves a fresh sha, and accepts
    /// the retry. write() must converge in exactly two PUTs.
    #[tokio::test]
    async fn github_write_retries_once_on_sha_conflict() {
        use base64::Engine as _;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Mutex;

        let puts: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));
        let put_shas: Arc<Mutex<Vec<Option<String>>>> = Arc::new(Mutex::new(Vec::new()));
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"old");

        let get_puts = puts.clone();
        let put_puts = puts.clone();
        let put_shas_w = put_shas.clone();
        let app = axum::Router::new().route(
            "/repos/o/r/contents/{*path}",
            axum::routing::get(move || {
                let puts = get_puts.clone();
                let b64 = b64.clone();
                async move {
                    // Before the conflict the file is at "stale"; after it, "fresh".
                    let sha = if puts.load(Ordering::SeqCst) == 0 {
                        "stale"
                    } else {
                        "fresh"
                    };
                    axum::Json(serde_json::json!({
                        "type": "file", "encoding": "base64", "sha": sha, "content": b64,
                    }))
                }
            })
            .put(move |body: axum::Json<Value>| {
                let puts = put_puts.clone();
                let shas = put_shas_w.clone();
                async move {
                    let sha = body.get("sha").and_then(Value::as_str).map(str::to_string);
                    shas.lock().unwrap().push(sha.clone());
                    if puts.fetch_add(1, Ordering::SeqCst) == 0 {
                        // First PUT: pretend a commit raced in → sha mismatch.
                        (
                            axum::http::StatusCode::CONFLICT,
                            axum::Json(serde_json::json!({"message": "sha mismatch"})),
                        )
                    } else {
                        (
                            axum::http::StatusCode::OK,
                            axum::Json(serde_json::json!({"content": {"sha": "newsha"}})),
                        )
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let backend = GithubBackend {
            http: reqwest::Client::new(),
            api_base: format!("http://{addr}"),
            owner: "o".into(),
            repo: "r".into(),
            branch: "main".into(),
            prefix: "".into(),
            token: "test-token".into(),
        };
        let etag = backend.write("doc.md", b"materialized text").await.unwrap();
        assert_eq!(etag, "newsha");
        assert_eq!(puts.load(Ordering::SeqCst), 2, "exactly one retry");
        assert_eq!(
            *put_shas.lock().unwrap(),
            vec![Some("stale".to_string()), Some("fresh".to_string())],
            "the retry must carry the re-read sha"
        );
    }

    /// Gitea/Forgejo create semantics: the file doesn't exist (GET 404), PUT-without-sha
    /// is rejected 422 ("[SHA]: Required"), and the POST fallback creates it. GitHub's
    /// PUT-creates path is the first arm of the same code.
    #[tokio::test]
    async fn github_write_creates_via_post_fallback_on_gitea() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let puts = Arc::new(AtomicUsize::new(0));
        let posts = Arc::new(AtomicUsize::new(0));
        let puts_h = puts.clone();
        let posts_h = posts.clone();
        let app = axum::Router::new().route(
            "/repos/o/r/contents/{*path}",
            axum::routing::get(|| async {
                (
                    axum::http::StatusCode::NOT_FOUND,
                    axum::Json(serde_json::json!({})),
                )
            })
            .put(move || {
                let puts = puts_h.clone();
                async move {
                    puts.fetch_add(1, Ordering::SeqCst);
                    (
                        axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                        axum::Json(serde_json::json!({"message": "[SHA]: Required"})),
                    )
                }
            })
            .post(move |body: axum::Json<Value>| {
                let posts = posts_h.clone();
                async move {
                    posts.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(
                        body.get("message").and_then(Value::as_str),
                        Some("muesli: create notes/doc.md"),
                        "creates must use the create commit message"
                    );
                    (
                        axum::http::StatusCode::CREATED,
                        axum::Json(serde_json::json!({"content": {"sha": "createdsha"}})),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let backend = GithubBackend {
            http: reqwest::Client::new(),
            api_base: format!("http://{addr}"),
            owner: "o".into(),
            repo: "r".into(),
            branch: "main".into(),
            prefix: "notes/".into(),
            token: "test-token".into(),
        };
        let etag = backend.write("doc.md", b"first text").await.unwrap();
        assert_eq!(etag, "createdsha");
        assert_eq!(puts.load(Ordering::SeqCst), 1);
        assert_eq!(posts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn list_objects_xml_parses_keys_and_etags() {
        let xml = r#"<?xml version="1.0"?>
<ListBucketResult><Name>muesli-dev</Name>
<Contents><Key>notes/a.md</Key><LastModified>x</LastModified><ETag>&#34;abc123&#34;</ETag></Contents>
<Contents><Key>notes/b &amp; c.md</Key><ETag>"def456"</ETag></Contents>
</ListBucketResult>"#;
        assert_eq!(
            parse_list_objects(xml),
            vec![
                ("notes/a.md".to_string(), "abc123".to_string()),
                ("notes/b & c.md".to_string(), "def456".to_string()),
            ]
        );
    }

    // -----------------------------------------------------------------------
    // DB-gated relocate / title-rename tests (set TEST_DATABASE_URL). These exercise both
    // the DB-row side of the rename (rel_path move + collision fallback + unattached no-op)
    // AND, via the in-memory `MemoryBackend` below (the `"memory"` storage kind), the full
    // byte path (read old → write new → delete old) end-to-end through `relocate` — so the
    // same-key write+delete data-loss guard is genuinely tested.
    // -----------------------------------------------------------------------

    /// A process-global in-memory object store keyed by a per-connection store id (carried
    /// in the connection config), so the SAME store is reachable across the two
    /// `backend_from_conn` calls inside one `relocate`, and from the test for assertions.
    fn memory_store() -> &'static StdMutex<HashMap<String, MemoryObjects>> {
        static STORE: std::sync::OnceLock<StdMutex<HashMap<String, MemoryObjects>>> =
            std::sync::OnceLock::new();
        STORE.get_or_init(|| StdMutex::new(HashMap::new()))
    }

    /// One in-memory "bucket": rel_path → object bytes.
    type MemoryObjects = HashMap<String, Vec<u8>>;

    /// Minimal in-memory `StorageBackend` (test-only). Backed by [`memory_store`], scoped
    /// to one `store` id so parallel tests don't collide.
    pub struct MemoryBackend {
        store: String,
    }

    impl MemoryBackend {
        pub(crate) fn from_conn(config: &Value) -> Self {
            MemoryBackend {
                store: config
                    .get("store")
                    .and_then(|v| v.as_str())
                    .unwrap_or("default")
                    .to_string(),
            }
        }
    }

    impl StorageBackend for MemoryBackend {
        async fn read(&self, rel_path: &str) -> Result<Option<(Vec<u8>, String)>> {
            let g = memory_store().lock().unwrap();
            Ok(g.get(&self.store).and_then(|m| m.get(rel_path)).map(|b| {
                let etag = sha256_hex(b);
                (b.clone(), etag)
            }))
        }
        async fn write(&self, rel_path: &str, bytes: &[u8]) -> Result<String> {
            let mut g = memory_store().lock().unwrap();
            g.entry(self.store.clone())
                .or_default()
                .insert(rel_path.to_string(), bytes.to_vec());
            Ok(sha256_hex(bytes))
        }
        async fn list(&self, prefix: &str) -> Result<Vec<(String, String)>> {
            let g = memory_store().lock().unwrap();
            Ok(g.get(&self.store)
                .map(|m| {
                    m.iter()
                        .filter(|(k, _)| k.starts_with(prefix))
                        .map(|(k, v)| (k.clone(), sha256_hex(v)))
                        .collect()
                })
                .unwrap_or_default())
        }
        async fn delete(&self, rel_path: &str) -> Result<()> {
            let mut g = memory_store().lock().unwrap();
            if let Some(m) = g.get_mut(&self.store) {
                m.remove(rel_path);
            }
            Ok(())
        }
    }

    /// A unique in-memory connection config + direct backend handle for assertions.
    #[cfg(test)]
    fn memory_conn() -> (Value, MemoryBackend) {
        let store = format!("store-{}", Uuid::now_v7());
        (
            serde_json::json!({ "store": store }),
            MemoryBackend { store },
        )
    }

    /// Build a throwaway StorageManager over a live test pool. The rooms/links/events it
    /// carries are unused by the DB-only paths under test (set_rel_path_with_fallback,
    /// and relocate's early no-op for unattached docs).
    #[cfg(test)]
    async fn test_manager() -> Option<Arc<StorageManager>> {
        let url = std::env::var("TEST_DATABASE_URL").ok()?;
        let p = Arc::new(
            Persistence::connect(&url)
                .await
                .expect("connect TEST_DATABASE_URL"),
        );
        Some(StorageManager::spawn(
            p,
            Default::default(),
            None,
            Default::default(),
        ))
    }

    /// A raw `Persistence` handle over a live test pool (no `StorageManager` wrapper) —
    /// for tests that build their own manager, mirroring persistence.rs's private helper
    /// of the same name.
    #[cfg(test)]
    async fn test_db() -> Option<Persistence> {
        let url = std::env::var("TEST_DATABASE_URL").ok()?;
        Some(
            Persistence::connect(&url)
                .await
                .expect("connect TEST_DATABASE_URL"),
        )
    }

    /// Test helper: a workspace that is actually usable by `ensure_document_owned` (Fix 3 —
    /// `primary_workspace_of` excludes `pending_storage`). Binds a bare "memory" connection
    /// so the workspace becomes 'active', matching how a real workspace exits the wizard.
    /// Mirrors persistence.rs's private helper of the same name.
    #[cfg(test)]
    async fn active_workspace(p: &Persistence, name: &str, owner: Uuid) -> Uuid {
        let ws = p.create_workspace(name, owner).await.unwrap();
        let conn = p
            .create_storage_connection(ws, "memory", &serde_json::json!({}))
            .await
            .unwrap();
        p.activate_workspace_with_storage(ws, conn).await.unwrap();
        ws
    }

    /// A fake S3 connection config — never reached by the DB-only assertions below.
    #[cfg(test)]
    fn fake_s3_config() -> Value {
        serde_json::json!({
            "endpoint": "http://127.0.0.1:1",
            "bucket": "muesli-test",
            "region": "us-east-1",
            "access_key_id": "x",
            "secret_access_key": "y",
            "prefix": ""
        })
    }

    /// Seed an attached document and return (manager, document_id, slug, conn_id).
    #[cfg(test)]
    async fn seed_attached(mgr: &Arc<StorageManager>, slug: &str, rel_path: &str) -> (Uuid, Uuid) {
        let p = &mgr.persistence;
        let owner = p.create_agent_user("owner").await.unwrap();
        // ensure_document_owned no longer auto-creates a workspace (BYO storage) — the
        // owner needs one up front.
        active_workspace(p, "Owner WS", owner).await;
        let doc = p.ensure_document_owned(slug, owner, owner).await.unwrap();
        let conn = p
            .create_storage_connection(doc.workspace_id.unwrap(), "s3", &fake_s3_config())
            .await
            .unwrap();
        p.attach_document_storage(doc.id, conn, rel_path)
            .await
            .unwrap();
        (doc.id, conn)
    }

    #[tokio::test]
    async fn title_change_moves_rel_path_to_the_title_based_path() {
        let Some(mgr) = test_manager().await else {
            eprintln!("skipping: set TEST_DATABASE_URL to run title_change_moves_rel_path_to_the_title_based_path");
            return;
        };
        let slug = format!("doc-{}", Uuid::now_v7());
        let (doc_id, _conn) = seed_attached(&mgr, &slug, &format!("{slug}.md")).await;

        // A title change → rel_path becomes "<sanitized title>.md".
        mgr.persistence
            .set_document_title(doc_id, Some("My Great Title"))
            .await
            .unwrap();
        let doc = mgr.persistence.find_document(&slug).await.unwrap().unwrap();
        let chain = mgr
            .persistence
            .folder_chain_names(doc.folder_id)
            .await
            .unwrap();
        let new_rel = rel_path_for_named(&chain, "My Great Title");
        let landed = mgr
            .set_rel_path_with_fallback(doc_id, &slug, &chain, &new_rel)
            .await
            .unwrap();
        assert_eq!(landed.as_deref(), Some("My Great Title.md"));

        // The DB row reflects the title-based path; set_rel_path cleared the content_hash.
        let att = mgr
            .persistence
            .document_attachment(doc_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(att.rel_path, "My Great Title.md");
        assert!(
            att.content_hash.is_none(),
            "content_hash reset so the next materialize writes the new path"
        );
    }

    #[tokio::test]
    async fn empty_title_falls_back_to_slug_based_path() {
        let Some(mgr) = test_manager().await else {
            eprintln!(
                "skipping: set TEST_DATABASE_URL to run empty_title_falls_back_to_slug_based_path"
            );
            return;
        };
        let slug = format!("doc-{}", Uuid::now_v7());
        // Start the doc somewhere else so a move is actually computed.
        let (doc_id, _conn) = seed_attached(&mgr, &slug, "Old Title.md").await;

        // Clear the title (None / empty): the stem falls back to the slug.
        mgr.persistence
            .set_document_title(doc_id, None)
            .await
            .unwrap();
        let doc = mgr.persistence.find_document(&slug).await.unwrap().unwrap();
        let stem = doc
            .title
            .as_deref()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or(&slug);
        let chain = mgr
            .persistence
            .folder_chain_names(doc.folder_id)
            .await
            .unwrap();
        let new_rel = rel_path_for_named(&chain, stem);
        assert_eq!(new_rel, format!("{slug}.md"));

        let landed = mgr
            .set_rel_path_with_fallback(doc_id, &slug, &chain, &new_rel)
            .await
            .unwrap();
        assert_eq!(landed, Some(format!("{slug}.md")));
        let att = mgr
            .persistence
            .document_attachment(doc_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(att.rel_path, format!("{slug}.md"));
    }

    #[tokio::test]
    async fn title_collision_falls_back_to_slug_and_does_not_error() {
        let Some(mgr) = test_manager().await else {
            eprintln!("skipping: set TEST_DATABASE_URL to run title_collision_falls_back_to_slug_and_does_not_error");
            return;
        };
        // Two docs on the SAME connection. Doc A already sits at "Shared.md".
        let p = &mgr.persistence;
        let owner = p.create_agent_user("owner").await.unwrap();
        // ensure_document_owned no longer auto-creates a workspace (BYO storage) — the
        // owner needs one up front.
        active_workspace(p, "Owner WS", owner).await;
        let slug_a = format!("a-{}", Uuid::now_v7());
        let slug_b = format!("b-{}", Uuid::now_v7());
        let da = p
            .ensure_document_owned(&slug_a, owner, owner)
            .await
            .unwrap();
        let conn = p
            .create_storage_connection(da.workspace_id.unwrap(), "s3", &fake_s3_config())
            .await
            .unwrap();
        p.attach_document_storage(da.id, conn, "Shared.md")
            .await
            .unwrap();
        let db = p
            .ensure_document_owned(&slug_b, owner, owner)
            .await
            .unwrap();
        p.attach_document_storage(db.id, conn, &format!("{slug_b}.md"))
            .await
            .unwrap();

        // Rename B to A's title → the title-based path "Shared.md" collides → fall back to
        // B's slug-based path. No error.
        p.set_document_title(db.id, Some("Shared")).await.unwrap();
        let chain: Vec<String> = Vec::new();
        let new_rel = rel_path_for_named(&chain, "Shared"); // "Shared.md" — taken by A
        let landed = mgr
            .set_rel_path_with_fallback(db.id, &slug_b, &chain, &new_rel)
            .await
            .expect("collision fallback must not error");
        assert_eq!(
            landed,
            Some(format!("{slug_b}.md")),
            "B fell back to its slug path"
        );
        let att = p.document_attachment(db.id).await.unwrap().unwrap();
        assert_eq!(att.rel_path, format!("{slug_b}.md"));
        // A is untouched.
        let att_a = p.document_attachment(da.id).await.unwrap().unwrap();
        assert_eq!(att_a.rel_path, "Shared.md");
    }

    #[tokio::test]
    async fn unattached_title_change_is_a_clean_no_op() {
        let Some(mgr) = test_manager().await else {
            eprintln!(
                "skipping: set TEST_DATABASE_URL to run unattached_title_change_is_a_clean_no_op"
            );
            return;
        };
        let p = &mgr.persistence;
        let owner = p.create_agent_user("owner").await.unwrap();
        // ensure_document_owned no longer auto-creates a workspace (BYO storage) — the
        // owner needs one up front.
        active_workspace(p, "Owner WS", owner).await;
        let slug = format!("free-{}", Uuid::now_v7());
        let doc = p.ensure_document_owned(&slug, owner, owner).await.unwrap();
        // No storage connection attached.
        p.set_document_title(doc.id, Some("Anything"))
            .await
            .unwrap();

        // relocate is a clean no-op: document_attachment returns None for an unattached doc.
        assert!(p.document_attachment(doc.id).await.unwrap().is_none());
        mgr.relocate(doc.id)
            .await
            .expect("relocate on an unattached doc is Ok(())");
        // Still unattached, no rel_path row to touch.
        assert!(p.document_attachment(doc.id).await.unwrap().is_none());
    }

    /// End-to-end happy path THROUGH `relocate` with a real (in-memory) backend: a title
    /// change moves the bytes from the old key to the new title-based key, and the old key
    /// is gone afterward.
    #[tokio::test]
    async fn relocate_moves_bytes_old_to_new_on_title_change() {
        let Some(mgr) = test_manager().await else {
            eprintln!("skipping: set TEST_DATABASE_URL to run relocate_moves_bytes_old_to_new_on_title_change");
            return;
        };
        let p = &mgr.persistence;
        let (config, backend) = memory_conn();
        let owner = p.create_agent_user("owner").await.unwrap();
        // ensure_document_owned no longer auto-creates a workspace (BYO storage) — the
        // owner needs one up front.
        active_workspace(p, "Owner WS", owner).await;
        let slug = format!("doc-{}", Uuid::now_v7());
        let doc = p.ensure_document_owned(&slug, owner, owner).await.unwrap();
        let conn = p
            .create_storage_connection(doc.workspace_id.unwrap(), "memory", &config)
            .await
            .unwrap();
        p.attach_document_storage(doc.id, conn, &format!("{slug}.md"))
            .await
            .unwrap();
        // Materialize the canonical file at the slug path.
        backend
            .write(&format!("{slug}.md"), b"# hello\n")
            .await
            .unwrap();

        // Rename → relocate moves the bytes to "Renamed Doc.md".
        p.set_document_title(doc.id, Some("Renamed Doc"))
            .await
            .unwrap();
        mgr.relocate(doc.id).await.expect("relocate succeeds");

        assert!(
            backend.read(&format!("{slug}.md")).await.unwrap().is_none(),
            "old slug-based key was deleted"
        );
        let moved = backend.read("Renamed Doc.md").await.unwrap();
        assert_eq!(
            moved.map(|(b, _)| b),
            Some(b"# hello\n".to_vec()),
            "bytes live at the new key"
        );
        let att = p.document_attachment(doc.id).await.unwrap().unwrap();
        assert_eq!(att.rel_path, "Renamed Doc.md");
    }

    /// REGRESSION (the data-loss bug): when a title collides and the slug-based fallback
    /// path EQUALS the doc's current rel_path, `relocate` must NOT run a same-key
    /// write-then-delete (which would destroy the file). Drive the collision THROUGH
    /// `relocate` and assert the colliding doc's bytes STILL EXIST at its slug path.
    #[tokio::test]
    async fn relocate_collision_to_current_path_preserves_bytes() {
        let Some(mgr) = test_manager().await else {
            eprintln!("skipping: set TEST_DATABASE_URL to run relocate_collision_to_current_path_preserves_bytes");
            return;
        };
        let p = &mgr.persistence;
        let (config, backend) = memory_conn();
        let owner = p.create_agent_user("owner").await.unwrap();
        // ensure_document_owned no longer auto-creates a workspace (BYO storage) — the
        // owner needs one up front.
        active_workspace(p, "Owner WS", owner).await;
        let slug_a = format!("a-{}", Uuid::now_v7());
        let slug_b = format!("b-{}", Uuid::now_v7());
        let da = p
            .ensure_document_owned(&slug_a, owner, owner)
            .await
            .unwrap();
        let conn = p
            .create_storage_connection(da.workspace_id.unwrap(), "memory", &config)
            .await
            .unwrap();
        // A occupies "Shared.md"; B is materialized at its slug path.
        p.attach_document_storage(da.id, conn, "Shared.md")
            .await
            .unwrap();
        backend.write("Shared.md", b"# A\n").await.unwrap();
        let db = p
            .ensure_document_owned(&slug_b, owner, owner)
            .await
            .unwrap();
        p.attach_document_storage(db.id, conn, &format!("{slug_b}.md"))
            .await
            .unwrap();
        backend
            .write(&format!("{slug_b}.md"), b"# B\n")
            .await
            .unwrap();

        // Rename B's title to "Shared" → title path "Shared.md" collides with A → fallback
        // to B's slug path "{slug_b}.md" which EQUALS B's current rel_path. The guard must
        // short-circuit BEFORE the byte move so B's file is not write-then-deleted.
        p.set_document_title(db.id, Some("Shared")).await.unwrap();
        mgr.relocate(db.id)
            .await
            .expect("collision relocate must not error");

        // B's canonical file is intact at its slug path (NOT destroyed).
        let b_bytes = backend.read(&format!("{slug_b}.md")).await.unwrap();
        assert_eq!(
            b_bytes.map(|(b, _)| b),
            Some(b"# B\n".to_vec()),
            "B's bytes survived the collision"
        );
        // A is untouched.
        let a_bytes = backend.read("Shared.md").await.unwrap();
        assert_eq!(
            a_bytes.map(|(b, _)| b),
            Some(b"# A\n".to_vec()),
            "A's bytes untouched"
        );
        // B's row stayed on its slug path.
        let att_b = p.document_attachment(db.id).await.unwrap().unwrap();
        assert_eq!(att_b.rel_path, format!("{slug_b}.md"));
    }

    /// plan 1a task 7: binding a workspace attaches + materializes every unattached doc,
    /// and activates the workspace.
    #[tokio::test]
    async fn bind_workspace_attaches_and_activates() {
        let Some(p) = test_db().await else {
            eprintln!(
                "skipping: set TEST_DATABASE_URL to run bind_workspace_attaches_and_activates"
            );
            return;
        };
        let p = Arc::new(p);
        let owner = p.create_agent_user("binder").await.unwrap();
        let ws = p.create_workspace("Bind Me", owner).await.unwrap();
        // Two docs with no attachment (create_document_in_workspace / the folders path).
        let slug_a = format!("bind-a-{}", Uuid::now_v7());
        let slug_b = format!("bind-b-{}", Uuid::now_v7());
        p.create_document_in_workspace(&slug_a, ws, None, Some("Doc A"), owner)
            .await
            .unwrap();
        p.create_document_in_workspace(&slug_b, ws, None, None, owner)
            .await
            .unwrap();

        let conn = p
            .create_storage_connection(ws, "memory", &serde_json::json!({}))
            .await
            .unwrap();
        let mgr = StorageManager::spawn(
            p.clone(),
            Default::default(),
            None,
            crate::events::WorkspaceEvents::default(),
        );
        let attached = mgr.bind_workspace(ws, conn).await.unwrap();
        assert_eq!(attached, 2);
        assert_eq!(
            p.workspace_meta(ws).await.unwrap().unwrap().status,
            "active"
        );
        assert_eq!(
            p.unattached_documents_in_workspace(ws).await.unwrap().len(),
            0
        );
        // Titles drive the filename; missing title falls back to the slug.
        let atts = p.attached_documents().await.unwrap();
        assert!(atts
            .iter()
            .any(|a| a.slug == slug_a && a.rel_path == "Doc A.md"));
        assert!(atts
            .iter()
            .any(|a| a.slug == slug_b && a.rel_path == format!("{slug_b}.md")));
    }

    /// plan 1a task 8: a document created in a bound workspace is attached automatically;
    /// in an unbound workspace it is left alone.
    #[tokio::test]
    async fn new_documents_auto_attach_in_bound_workspaces() {
        let Some(p) = test_db().await else {
            eprintln!("skipping: set TEST_DATABASE_URL to run new_documents_auto_attach_in_bound_workspaces");
            return;
        };
        let p = Arc::new(p);
        let owner = p.create_agent_user("auto").await.unwrap();
        let ws = p.create_workspace("Auto Attach", owner).await.unwrap();
        let conn = p
            .create_storage_connection(ws, "memory", &serde_json::json!({}))
            .await
            .unwrap();
        let mgr = StorageManager::spawn(
            p.clone(),
            Default::default(),
            None,
            crate::events::WorkspaceEvents::default(),
        );
        mgr.bind_workspace(ws, conn).await.unwrap();

        let slug = format!("auto-{}", Uuid::now_v7());
        let doc = p
            .create_document_in_workspace(&slug, ws, None, Some("Auto Doc"), owner)
            .await
            .unwrap();
        assert!(
            mgr.attach_new_document(doc.id).await.unwrap(),
            "bound workspace → attached"
        );
        assert!(p
            .attached_documents()
            .await
            .unwrap()
            .iter()
            .any(|a| a.slug == slug && a.rel_path == "Auto Doc.md"));

        // Unbound workspace → no-op.
        let ws2 = p.create_workspace("Unbound", owner).await.unwrap();
        let slug2 = format!("noop-{}", Uuid::now_v7());
        let doc2 = p
            .create_document_in_workspace(&slug2, ws2, None, None, owner)
            .await
            .unwrap();
        assert!(!mgr.attach_new_document(doc2.id).await.unwrap());
    }

    /// BYO storage phase 2: kind "sharepoint" dispatches to the msgraph backend. Uses
    /// the test-only global-ctx installer (first-install-wins; IO tests use per-instance
    /// ctxs in msgraph.rs instead, so the placeholder URLs here never get dialed).
    #[test]
    fn backend_from_conn_dispatches_sharepoint() {
        crate::msgraph::install_test_ctx(Arc::new(crate::msgraph::MsCtx::new(
            "http://unused".into(),
            "http://unused/v1.0".into(),
            Some(crate::msgraph::MsCredential {
                client_id: "cid".into(),
                auth: crate::msgraph::MsAuth::Secret("cs".into()),
            }),
        )));
        let config = serde_json::json!({
            "tenant_id": "contoso.onmicrosoft.com",
            "site_url": "https://contoso.sharepoint.com/sites/eng",
            "site_id": "contoso.sharepoint.com,g1,g2",
            "drive_id": "drv-1",
            "drive_name": "Documents",
            "prefix": "notes",
        });
        let backend = backend_from_conn("sharepoint", &config).expect("dispatches");
        assert!(matches!(backend, AnyBackend::Sharepoint(_)));
        // required fields are enforced by from_conn
        assert!(backend_from_conn("sharepoint", &serde_json::json!({})).is_err());
        // the unsupported-kind message names the new backend
        if let Err(e) = backend_from_conn("ftp", &serde_json::json!({})) {
            let msg = e.to_string();
            assert!(msg.contains("sharepoint"), "{msg}");
        } else {
            panic!("expected error for unsupported kind");
        }
    }
}
