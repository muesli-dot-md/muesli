//! Per-user appearance preferences (GET/PATCH /api/me/prefs): the small key/value
//! object both apps sync their appearance choices through (migration 0018). Auth
//! posture mirrors the notifications endpoints exactly — personal data, not
//! account-mutation — via `account::caller_ctx`/`caller_ctx_write`: browser
//! sessions and the desktop's own device-login Bearer token are admitted, an
//! ordinary delegated key (POST /api/me/tokens) and any restricted token are
//! refused, and PATCH additionally refuses a read-only-scoped token. See
//! `account::authorize_notifications` for the exact invariant.
//!
//! PATCH is a sparse merge: only top-level keys present in the body are touched;
//! a key set to JSON null is DELETED from the stored object; the response is the
//! full merged object. Last-write-wins, no versioning. Validation is strict —
//! unknown keys, wrong value shapes, and non-object bodies are all 422 — so the
//! stored object only ever holds values every client can apply blindly.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde_json::{Map, Value};
use tracing::warn;

use crate::account::{caller_ctx, caller_ctx_write};
use crate::AppState;

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, msg.into()).into_response()
}

fn err500(e: anyhow::Error) -> Response {
    warn!(%e, "prefs api error");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

/// The accepted enum values, mirrored from the apps' stores (theme.svelte.ts /
/// accent.svelte.ts). A value outside these sets is a 422, never stored.
const THEMES: &[&str] = &["light", "dark", "system"];
const ACCENTS: &[&str] = &["gray", "periwinkle", "blue", "green", "amber"];

/// Integer in `lo..=hi`. serde_json keeps 5.0 as f64 (as_i64 = None), so
/// fractional and float-typed numbers are rejected, not truncated.
fn int_in(v: &Value, lo: i64, hi: i64) -> bool {
    v.as_i64().is_some_and(|n| (lo..=hi).contains(&n))
}

/// Validate a PATCH /api/me/prefs body into (keys to set, keys to delete).
/// Pure — unit-tested below without HTTP or a database. Errors carry the 422
/// message verbatim.
pub(crate) fn validate_prefs_patch(
    body: &Value,
) -> Result<(Map<String, Value>, Vec<String>), String> {
    let Some(obj) = body.as_object() else {
        return Err("body must be a JSON object of preference keys".into());
    };
    let mut set = Map::new();
    let mut delete = Vec::new();
    for (key, value) in obj {
        if value.is_null() {
            // Deleting is valid for any KNOWN key, even one that isn't stored.
            match key.as_str() {
                "theme" | "accent" | "tint_strength" | "tint_hue" | "folder_hue" => {
                    delete.push(key.clone());
                }
                _ => return Err(format!("unknown preference key {key:?}")),
            }
            continue;
        }
        let valid = match key.as_str() {
            "theme" => value.as_str().is_some_and(|s| THEMES.contains(&s)),
            "accent" => value.as_str().is_some_and(|s| ACCENTS.contains(&s)),
            "tint_strength" => int_in(value, 0, 100),
            "tint_hue" | "folder_hue" => int_in(value, 0, 360),
            _ => return Err(format!("unknown preference key {key:?}")),
        };
        if !valid {
            return Err(format!("invalid value for preference key {key:?}"));
        }
        set.insert(key.clone(), value.clone());
    }
    Ok((set, delete))
}

/// GET /api/me/prefs → the caller's stored preference object (possibly `{}`).
pub async fn get_prefs(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Response {
    let (p, user_id) = match caller_ctx(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    match p.get_user_prefs(user_id).await {
        Ok(Some(prefs)) => Json(prefs).into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "no such user"),
        Err(e) => err500(e),
    }
}

/// PATCH /api/me/prefs — sparse merge (see the module doc). Returns the full
/// merged object; 422 on any validation failure, with nothing written.
pub async fn update_prefs(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let (p, user_id) = match caller_ctx_write(&state, &jar, &headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let (set, delete) = match validate_prefs_patch(&body) {
        Ok(parts) => parts,
        Err(msg) => return err(StatusCode::UNPROCESSABLE_ENTITY, msg),
    };
    match p
        .merge_user_prefs(user_id, &Value::Object(set), &delete)
        .await
    {
        Ok(Some(prefs)) => Json(prefs).into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "no such user"),
        Err(e) => err500(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ok(body: Value) -> (Map<String, Value>, Vec<String>) {
        validate_prefs_patch(&body).expect("expected a valid patch body")
    }

    #[test]
    fn accepts_every_known_key_at_its_boundaries() {
        let (set, delete) = ok(json!({
            "theme": "dark",
            "accent": "amber",
            "tint_strength": 0,
            "tint_hue": 360,
            "folder_hue": 0,
        }));
        assert_eq!(set.len(), 5);
        assert!(delete.is_empty());
        assert_eq!(set["theme"], json!("dark"));
        assert_eq!(set["tint_hue"], json!(360));
    }

    #[test]
    fn empty_object_is_a_valid_noop() {
        let (set, delete) = ok(json!({}));
        assert!(set.is_empty());
        assert!(delete.is_empty());
    }

    #[test]
    fn null_deletes_any_known_key_but_not_unknown_ones() {
        let (set, delete) = ok(json!({ "accent": null, "folder_hue": null }));
        assert!(set.is_empty());
        assert_eq!(delete, vec!["accent".to_string(), "folder_hue".to_string()]);
        // null under an unknown key is still an unknown key — 422, not a delete.
        assert!(validate_prefs_patch(&json!({ "translucency": null })).is_err());
    }

    #[test]
    fn set_and_delete_mix_in_one_body() {
        let (set, delete) = ok(json!({ "theme": "light", "tint_hue": null }));
        assert_eq!(set.len(), 1);
        assert_eq!(delete, vec!["tint_hue".to_string()]);
    }

    #[test]
    fn unknown_keys_are_rejected() {
        let err = validate_prefs_patch(&json!({ "font_size": 14 })).unwrap_err();
        assert!(err.contains("font_size"), "{err}");
        // A valid key alongside an unknown one still rejects the whole body.
        assert!(validate_prefs_patch(&json!({ "theme": "dark", "nope": 1 })).is_err());
    }

    #[test]
    fn enum_values_are_strict() {
        assert!(validate_prefs_patch(&json!({ "theme": "midnight" })).is_err());
        assert!(validate_prefs_patch(&json!({ "theme": 1 })).is_err());
        assert!(validate_prefs_patch(&json!({ "accent": "purple" })).is_err());
        // Casing matters — the stores persist lowercase ids only.
        assert!(validate_prefs_patch(&json!({ "accent": "Gray" })).is_err());
    }

    #[test]
    fn integer_ranges_are_strict() {
        assert!(validate_prefs_patch(&json!({ "tint_strength": 101 })).is_err());
        assert!(validate_prefs_patch(&json!({ "tint_strength": -1 })).is_err());
        assert!(validate_prefs_patch(&json!({ "tint_hue": 361 })).is_err());
        assert!(validate_prefs_patch(&json!({ "folder_hue": -5 })).is_err());
        // Floats are rejected outright, never truncated (50.5 AND 50.0 — serde_json
        // keeps both as f64, so neither sneaks through as_i64).
        assert!(validate_prefs_patch(&json!({ "tint_strength": 50.5 })).is_err());
        assert!(validate_prefs_patch(&json!({ "tint_strength": 50.0 })).is_err());
        assert!(validate_prefs_patch(&json!({ "tint_hue": "295" })).is_err());
        assert!(validate_prefs_patch(&json!({ "tint_hue": true })).is_err());
    }

    #[test]
    fn non_object_bodies_are_rejected() {
        for body in [
            json!(null),
            json!(5),
            json!("theme"),
            json!(true),
            json!(["theme", "dark"]),
        ] {
            assert!(validate_prefs_patch(&body).is_err(), "accepted {body}");
        }
    }

    // -----------------------------------------------------------------------
    // DB-gated handler tests — same TEST_DATABASE_URL skip-if-absent convention
    // as notifications_api.rs / persistence.rs (CI runs with no database).
    // -----------------------------------------------------------------------

    use std::sync::Arc;

    use axum::extract::State;
    use uuid::Uuid;

    async fn test_db() -> Option<crate::persistence::Persistence> {
        let url = std::env::var("TEST_DATABASE_URL").ok()?;
        Some(
            crate::persistence::Persistence::connect(&url)
                .await
                .expect("connect TEST_DATABASE_URL"),
        )
    }

    /// State + Bearer headers for a fresh owner with a token of the given kind
    /// and scopes, mirroring notifications_api.rs's handler-layer test setup.
    async fn state_with_token(
        persistence: Arc<crate::persistence::Persistence>,
        kind: crate::auth::TokenKind,
        scopes: &[&str],
    ) -> (AppState, axum::http::HeaderMap, Uuid) {
        let owner = persistence.create_agent_user("prefs-owner").await.unwrap();
        let agent = persistence.create_agent_user("prefs-agent").await.unwrap();
        let secret = format!("test-{}", Uuid::new_v4());
        persistence
            .insert_api_token(
                &crate::auth::hash_token(&secret),
                agent,
                Some(owner),
                scopes,
                None,
                kind.as_db(),
            )
            .await
            .unwrap();
        let state = AppState {
            persistence: Some(persistence.clone()),
            auth: Some(Arc::new(crate::auth::test_ctx(persistence))),
            ..Default::default()
        };
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {secret}").parse().unwrap(),
        );
        (state, headers, owner)
    }

    async fn body_json(resp: Response) -> Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// End-to-end merge semantics through the real handlers over a device token
    /// (the desktop's transport): fresh user starts at `{}`; a PATCH sets keys;
    /// a second PATCH overwrites one key and leaves the rest; null deletes; the
    /// response always carries the FULL merged object and GET agrees with it.
    #[tokio::test]
    async fn patch_merges_sparsely_and_null_deletes() {
        let Some(persistence) = test_db().await else {
            eprintln!(
                "skipping: set TEST_DATABASE_URL to run patch_merges_sparsely_and_null_deletes"
            );
            return;
        };
        let (state, headers, _owner) = state_with_token(
            Arc::new(persistence),
            crate::auth::TokenKind::Device,
            &["read", "write"],
        )
        .await;
        let jar = CookieJar::new();

        // Fresh user: the stored object is exactly {} (migration 0018 default).
        let resp = get_prefs(State(state.clone()), jar.clone(), headers.clone()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await, json!({}));

        // Set two keys; the response is the full merged object.
        let resp = update_prefs(
            State(state.clone()),
            jar.clone(),
            headers.clone(),
            Json(json!({ "theme": "dark", "tint_strength": 42 })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            body_json(resp).await,
            json!({ "theme": "dark", "tint_strength": 42 })
        );

        // Overwrite one key, add another — the untouched key survives.
        let resp = update_prefs(
            State(state.clone()),
            jar.clone(),
            headers.clone(),
            Json(json!({ "theme": "light", "accent": "green" })),
        )
        .await;
        assert_eq!(
            body_json(resp).await,
            json!({ "theme": "light", "tint_strength": 42, "accent": "green" })
        );

        // null deletes a key; deleting a never-set key is a harmless no-op.
        let resp = update_prefs(
            State(state.clone()),
            jar.clone(),
            headers.clone(),
            Json(json!({ "tint_strength": null, "folder_hue": null })),
        )
        .await;
        assert_eq!(
            body_json(resp).await,
            json!({ "theme": "light", "accent": "green" })
        );

        // GET reflects everything the PATCH responses claimed.
        let resp = get_prefs(State(state), jar, headers).await;
        assert_eq!(
            body_json(resp).await,
            json!({ "theme": "light", "accent": "green" })
        );
    }

    /// A rejected body writes NOTHING — validation happens before the merge.
    #[tokio::test]
    async fn invalid_patch_is_422_and_writes_nothing() {
        let Some(persistence) = test_db().await else {
            eprintln!(
                "skipping: set TEST_DATABASE_URL to run invalid_patch_is_422_and_writes_nothing"
            );
            return;
        };
        let (state, headers, _owner) = state_with_token(
            Arc::new(persistence),
            crate::auth::TokenKind::Device,
            &["read", "write"],
        )
        .await;
        let jar = CookieJar::new();

        for body in [
            json!({ "theme": "dark", "unknown_key": 1 }),
            json!({ "tint_strength": 101 }),
            json!(["not", "an", "object"]),
        ] {
            let resp = update_prefs(
                State(state.clone()),
                jar.clone(),
                headers.clone(),
                Json(body),
            )
            .await;
            assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);
        }
        let resp = get_prefs(State(state), jar, headers).await;
        assert_eq!(body_json(resp).await, json!({}));
    }

    /// Token-kind authz at the handler layer: a delegated key is 403 for BOTH
    /// GET and PATCH (the same wall the notifications inbox holds), and a
    /// read-only-scoped device token may GET but not PATCH.
    #[tokio::test]
    async fn token_kind_and_scope_walls_hold() {
        let Some(persistence) = test_db().await else {
            eprintln!("skipping: set TEST_DATABASE_URL to run token_kind_and_scope_walls_hold");
            return;
        };
        let persistence = Arc::new(persistence);

        let (state, headers, _) = state_with_token(
            persistence.clone(),
            crate::auth::TokenKind::Delegated,
            &["read", "write"],
        )
        .await;
        let jar = CookieJar::new();
        let resp = get_prefs(State(state.clone()), jar.clone(), headers.clone()).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        let resp = update_prefs(State(state), jar.clone(), headers, Json(json!({}))).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        let (state, headers, _) =
            state_with_token(persistence, crate::auth::TokenKind::Device, &["read"]).await;
        let resp = get_prefs(State(state.clone()), jar.clone(), headers.clone()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let resp = update_prefs(State(state), jar, headers, Json(json!({ "theme": "dark" }))).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }
}
