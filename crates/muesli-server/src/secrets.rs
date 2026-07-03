//! Refresh-token encryption at rest (MUESLI_SECRET_KEY)
//!
//! The per-user Drive refresh token cannot live in the server environment like the
//! S3/GitHub secrets, so it is stored in `storage_connections.config` — encrypted with
//! the operator's `MUESLI_SECRET_KEY` (32 bytes, hex or standard base64) when that is
//! set. Config shape: `{"refresh_token_enc": "<base64(nonce||ct||tag)>"}`; legacy rows
//! with a plaintext `refresh_token` keep working on read.
//!
//! SECURITY: the cipher is encrypt-then-MAC built on the HMAC-SHA256 primitive this
//! crate already ships (storage::hmac_sha256, verified against the RFC 4231 / AWS SigV4
//! reference vectors): a CTR keystream of HMAC(k_enc, nonce || counter) blocks, with an
//! HMAC(k_mac, nonce || ciphertext) tag — a standard, sound construction. It exists only
//! because no AEAD crate is in the dependency tree and this module must not add one;
//! TODO: swap for a vetted AEAD (aes-gcm / chacha20poly1305) once Cargo.toml can grow
//! the dependency. The stored format is versioned by field name so a migration can
//! re-encrypt.
//!
//! Moved from gdrive.rs (plan 1a task 3) because S3/GitHub credentials now share it.

use anyhow::{anyhow, Context, Result};
use tracing::warn;

const SECRET_KEY_ENV: &str = "MUESLI_SECRET_KEY";

/// Cross-module test lock for MUESLI_SECRET_KEY: the env var is process-global, and the
/// per-module env locks (storage::tests::S3_ENV_LOCK, msgraph::tests::MS_ENV_LOCK) are
/// private to their modules, so they cannot serialize tests ACROSS modules. Any test
/// that sets/unsets MUESLI_SECRET_KEY must hold this lock for as long as the var is
/// mutated AND used (acquire it after the module's own env lock — consistent order:
/// module lock → secret-key lock — so the two locks can never deadlock).
#[cfg(test)]
pub(crate) static SECRET_KEY_ENV_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Parse a 32-byte key from 64 hex chars or standard base64. None = unusable.
pub(crate) fn parse_secret_key(raw: &str) -> Option<[u8; 32]> {
    use base64::Engine as _;
    let raw = raw.trim();
    let bytes: Vec<u8> = if raw.len() == 64 && raw.bytes().all(|b| b.is_ascii_hexdigit()) {
        (0..32)
            .map(|i| u8::from_str_radix(&raw[2 * i..2 * i + 2], 16).expect("hexdigit-checked"))
            .collect()
    } else {
        base64::engine::general_purpose::STANDARD.decode(raw).ok()?
    };
    bytes.try_into().ok()
}

/// The operator's application secret key, if configured and well-formed.
fn secret_key() -> Option<[u8; 32]> {
    let raw = std::env::var(SECRET_KEY_ENV).ok().filter(|s| !s.trim().is_empty())?;
    let key = parse_secret_key(&raw);
    if key.is_none() {
        warn!("{SECRET_KEY_ENV} is set but is not 32 bytes of hex or base64; ignoring it");
    }
    key
}

/// True when MUESLI_SECRET_KEY is set and well-formed. Per-workspace credentials are
/// REFUSED when this is false (BYO storage spec §3) — unlike the legacy gdrive path,
/// there is no plaintext fallback for new secrets.
pub(crate) fn secret_key_configured() -> bool {
    secret_key().is_some()
}

/// Domain-separated subkeys, derived per use so the master key never touches data.
fn subkeys(key: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    (
        crate::storage::hmac_sha256(key, b"muesli:secret:enc:v1"),
        crate::storage::hmac_sha256(key, b"muesli:secret:mac:v1"),
    )
}

/// XOR `data` with the HMAC-CTR keystream for `nonce` (32-byte blocks).
fn keystream_xor(k_enc: &[u8; 32], nonce: &[u8; 16], data: &mut [u8]) {
    for (i, block) in data.chunks_mut(32).enumerate() {
        let mut msg = [0u8; 20];
        msg[..16].copy_from_slice(nonce);
        msg[16..].copy_from_slice(&(i as u32).to_be_bytes());
        let ks = crate::storage::hmac_sha256(k_enc, &msg);
        for (b, k) in block.iter_mut().zip(ks.iter()) {
            *b ^= k;
        }
    }
}

/// Encrypt a secret string → base64(nonce(16) || ciphertext || tag(32)).
pub(crate) fn encrypt_secret_with_key(key: &[u8; 32], plaintext: &str) -> String {
    use base64::Engine as _;
    use rand::RngCore as _;
    let (k_enc, k_mac) = subkeys(key);
    let mut nonce = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut nonce);
    let mut ct = plaintext.as_bytes().to_vec();
    keystream_xor(&k_enc, &nonce, &mut ct);
    let mut mac_input = Vec::with_capacity(16 + ct.len());
    mac_input.extend_from_slice(&nonce);
    mac_input.extend_from_slice(&ct);
    let tag = crate::storage::hmac_sha256(&k_mac, &mac_input);
    let mut out = Vec::with_capacity(16 + ct.len() + 32);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    out.extend_from_slice(&tag);
    base64::engine::general_purpose::STANDARD.encode(out)
}

/// Decrypt [`encrypt_secret_with_key`] output; errors on tampering or a wrong key.
pub(crate) fn decrypt_secret_with_key(key: &[u8; 32], encoded: &str) -> Result<String> {
    use base64::Engine as _;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .context("encrypted secret is not valid base64")?;
    if raw.len() < 16 + 32 {
        return Err(anyhow!("encrypted secret is too short"));
    }
    let (nonce, rest) = raw.split_at(16);
    let (ct, tag) = rest.split_at(rest.len() - 32);
    let (k_enc, k_mac) = subkeys(key);
    let mut mac_input = Vec::with_capacity(16 + ct.len());
    mac_input.extend_from_slice(nonce);
    mac_input.extend_from_slice(ct);
    let expected = crate::storage::hmac_sha256(&k_mac, &mac_input);
    // Constant-time tag comparison (fold the XOR of every byte).
    let diff = expected.iter().zip(tag.iter()).fold(0u8, |acc, (a, b)| acc | (a ^ b));
    if diff != 0 {
        return Err(anyhow!("encrypted secret failed authentication (wrong {SECRET_KEY_ENV}?)"));
    }
    let mut pt = ct.to_vec();
    let nonce: [u8; 16] = nonce.try_into().expect("split_at(16)");
    keystream_xor(&k_enc, &nonce, &mut pt);
    String::from_utf8(pt).context("decrypted secret is not UTF-8")
}

/// Encrypt a secret for storage. None when MUESLI_SECRET_KEY is unset/unusable —
/// callers fall back to plaintext (legacy posture) with a loud warning.
pub(crate) fn encrypt_secret(plaintext: &str) -> Option<String> {
    Some(encrypt_secret_with_key(&secret_key()?, plaintext))
}

/// Decrypt a stored secret; requires MUESLI_SECRET_KEY.
pub(crate) fn decrypt_secret(encoded: &str) -> Result<String> {
    let key = secret_key().ok_or_else(|| {
        anyhow!("{SECRET_KEY_ENV} is not set but the stored refresh token is encrypted")
    })?;
    decrypt_secret_with_key(&key, encoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_key_parsing_accepts_hex_and_base64() {
        use base64::Engine as _;
        let key = [7u8; 32];
        let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(parse_secret_key(&hex), Some(key));
        let b64 = base64::engine::general_purpose::STANDARD.encode(key);
        assert_eq!(parse_secret_key(&b64), Some(key));
        assert_eq!(parse_secret_key("too-short"), None);
        // wrong length even if valid base64
        let b64_short = base64::engine::general_purpose::STANDARD.encode([1u8; 16]);
        assert_eq!(parse_secret_key(&b64_short), None);
    }

    #[test]
    fn secret_encryption_round_trips_and_authenticates() {
        use base64::Engine as _;
        let key = [42u8; 32];
        let secret = "1//long-google-refresh-token-☕";
        let enc = encrypt_secret_with_key(&key, secret);
        assert!(!enc.contains("refresh"), "ciphertext must not contain the plaintext");
        assert_eq!(decrypt_secret_with_key(&key, &enc).unwrap(), secret);
        // nonces differ per call → distinct ciphertexts for the same plaintext
        assert_ne!(enc, encrypt_secret_with_key(&key, secret));
        // a wrong key fails authentication rather than yielding garbage
        assert!(decrypt_secret_with_key(&[43u8; 32], &enc).is_err());
        // a flipped ciphertext bit fails authentication
        let mut raw = base64::engine::general_purpose::STANDARD.decode(&enc).unwrap();
        raw[20] ^= 0x01;
        let tampered = base64::engine::general_purpose::STANDARD.encode(&raw);
        assert!(decrypt_secret_with_key(&key, &tampered).is_err());
        // truncated / non-base64 inputs are clean errors
        assert!(decrypt_secret_with_key(&key, "AAAA").is_err());
        assert!(decrypt_secret_with_key(&key, "!!not-base64!!").is_err());
    }
}
