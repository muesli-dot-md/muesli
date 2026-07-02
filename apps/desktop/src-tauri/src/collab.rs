//! Authenticated REST transport for the desktop collaboration UI.
//!
//! The bearer token lives in the OS Keychain (`muesli_cli::store`) and the
//! webview never sees it. The JS `apiRequest` shim invokes this command, which
//! loads the token for `server`, attaches it as `Authorization: Bearer …`
//! (omitted in open mode), issues the request, and returns the HTTP status plus
//! the parsed JSON body. Modeled on `muesli_cli::api::me`'s bearer auth.
use muesli_cli::{api, store};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ApiResponse {
    pub status: u16,
    pub body: serde_json::Value,
}

#[tauri::command]
pub async fn api_request(
    server: String,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<ApiResponse, String> {
    let token = store::load_token(&server);
    let res = api::api_request(&server, token.as_deref(), &method, &path, body)
        .await
        .map_err(|e| e.to_string())?;
    Ok(ApiResponse {
        status: res.status,
        body: res.body,
    })
}
