//! Server auth for Muesli. Reuses muesli_cli's device-code flow and OS
//! Keychain token store, so logging in here is the same login the `muesli` CLI
//! uses (keyring service "muesli", account = http_base(server)).
use muesli_cli::{api, store};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Identity {
    pub server: String,
    /// Stable user id (server UUID) from GET /api/me — the presence dedup/color key
    /// shared with the webapp so the same person collapses to one indicator.
    pub id: Option<String>,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
    /// "open" or "oidc" — from GET /api/me.
    pub mode: String,
    /// users.onboarded_at from GET /api/me — the desktop's server-flag silence
    /// rule (already onboarded on another device → skip local onboarding).
    pub onboarded_at: Option<String>,
}

/// Human-readable identity for the delegated agent token. The server stores this
/// as the agent user's `display_name`, and edits/comments/suggestions/history are
/// attributed to that agent — so this string is what other people see as the
/// author. `/api/me` already reports the real OIDC owner for the device's own
/// identity; this is the attributed-author label, so we want a person's name, not
/// a `Muesli@host` machine tag. Prefer the OS account name, falling back to a
/// `<host>` form (never the old `Muesli@` prefix).
fn label() -> String {
    if let Some(user) = os_username() {
        return user;
    }
    hostname()
}

/// The OS login account name (`USER`/`LOGNAME`/`USERNAME`), if set and non-empty.
fn os_username() -> Option<String> {
    std::env::var("USER")
        .ok()
        .or_else(|| std::env::var("LOGNAME").ok())
        .or_else(|| std::env::var("USERNAME").ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn hostname() -> String {
    std::env::var("HOST")
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "mac".to_string())
}

async fn identity_from_me(server: &str, token: Option<&str>) -> Result<Identity, String> {
    let me = api::me(server, token).await.map_err(|e| e.to_string())?;
    let user = me.user;
    Ok(Identity {
        server: store::http_base(server),
        id: user.as_ref().and_then(|u| u.id.clone()),
        display_name: user.as_ref().and_then(|u| u.display_name.clone()),
        email: user.as_ref().and_then(|u| u.email.clone()),
        avatar_url: user.as_ref().and_then(|u| u.avatar_url.clone()),
        mode: me.mode,
        onboarded_at: user.as_ref().and_then(|u| u.onboarded_at.clone()),
    })
}

#[tauri::command]
pub async fn server_login(server: String) -> Result<Identity, String> {
    let cfg = api::auth_config(&server).await.map_err(|e| e.to_string())?;
    if cfg.mode == "open" {
        // Open-mode server: no sign-in. Identity is anonymous; no token to store.
        return identity_from_me(&server, None).await;
    }
    let issuer = cfg
        .issuer
        .ok_or_else(|| "server is in oidc mode but returned no issuer".to_string())?;
    let client_id = cfg
        .cli_client_id
        .ok_or_else(|| "server returned no cli_client_id".to_string())?;
    // Opens the system browser to the issuer's device page and polls for the
    // id_token. Blocks until the user approves (or the device code expires).
    let id_token = api::device_flow(&issuer, &client_id)
        .await
        .map_err(|e| e.to_string())?;
    let resp = api::cli_login(&server, &id_token, &label())
        .await
        .map_err(|e| e.to_string())?;
    store::save_token(&server, &resp.token).map_err(|e| e.to_string())?;
    identity_from_me(&server, Some(&resp.token)).await
}

#[tauri::command]
pub async fn server_logout(server: String) -> Result<(), String> {
    store::delete_token(&server).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn current_identity(server: String) -> Result<Option<Identity>, String> {
    match store::load_token(&server) {
        Some(token) => Ok(Some(identity_from_me(&server, Some(&token)).await?)),
        None => {
            // No token: still report mode so the UI can show "open" servers as
            // usable without login.
            let cfg = api::auth_config(&server).await.map_err(|e| e.to_string())?;
            if cfg.mode == "open" {
                Ok(Some(identity_from_me(&server, None).await?))
            } else {
                Ok(None)
            }
        }
    }
}

/// Cheap local check (no network): is a token stored for this server? Lets the
/// frontend decide whether to fetch server identity/workspaces, independent of
/// the editor's per-note `syncEnabled` flag.
#[tauri::command]
pub fn has_token(server: String) -> bool {
    store::load_token(&server).is_some()
}

/// Keychain consent gate (macOS, spec 2026-07-02): open (`granted = true`) or
/// close the process-global keyring gate in `muesli_cli::store`. The frontend
/// calls this with `true` when the user accepts the consent explainer — and
/// once per session at launch when consent was granted on a previous run.
/// Carries a bare bool; nothing token-shaped exists here to log.
#[tauri::command]
pub fn keychain_consent(granted: bool) {
    store::set_keychain_enabled(granted);
}
