# Muesli — Security Review

**Date:** 2026-07-01
**Scope:** `crates/muesli-server` (Rust/axum backend), `crates/muesli-cli` & `crates/muesli-core` (Rust), `apps/web` (SvelteKit), `apps/desktop` (Tauri), `packages/editor-core` (markdown rendering).
**Method:** Six parallel Fable 5 subagents, each auditing a coherent slice of the codebase adversarially. Findings below were verified against the source before inclusion; theoretical issues the code already mitigates were excluded.

## Overall posture

The codebase is **well-hardened on the marquee risks**: all SQL uses bound parameters (no injection), markdown/mermaid/KaTeX rendering runs through a correctly-configured DOMPurify sink, secrets come from env (no hardcoded credentials), OIDC ID-token validation is thorough (issuer/audience/nonce/PKCE, JWKS refresh rate-limited, RP HTTP client has redirects disabled), API tokens are SHA-256-hashed at rest, and CORS is a single explicit origin. There are **no passwords** — the server is a pure OIDC relying party — so that whole attack surface is absent.

The real risk clusters in three places: **(1) trust-boundary gaps where a single-document share-link guest can reach workspace-wide data**, **(2) server-side request forgery / secret exposure in the storage-connection layer**, and **(3) defense-in-depth gaps in the Tauri desktop shell**.

## Severity summary

| # | Severity | Title | Location |
|---|----------|-------|----------|
| 1 | **High** | SSRF + server-secret exfiltration via user-controlled storage endpoint | `workspace.rs`, `storage.rs` |
| 2 | **High** | @mention emails/notifications sent to any user with no access check | `mentions.rs`, `notifications.rs`, `api.rs` |
| 3 | Medium | Session cookie missing `Secure` flag | `auth.rs:807` |
| 4 | Medium | Open redirect via `next` parameter | `auth.rs:668` |
| 5 | Medium | Session tokens stored in plaintext in Redis | `auth.rs:584` |
| 6 | Medium | Login CSRF — OIDC `state` not bound to the browser | `auth.rs:706` |
| 7 | Medium | Google Drive refresh token stored plaintext at rest | `gdrive.rs:787` |
| 8 | Medium | Path traversal via `rel_path` in storage backends | `storage.rs:271/472/557` |
| 9 | Medium | Backlinks endpoint leaks slugs/IDs of inaccessible docs | `links.rs:549` |
| 10 | Medium | Presence/awareness identity spoofing | `room.rs:390` |
| 11 | Medium | Room-actor DoS via unbounded anchor resolution / edits | `api.rs:198/581` |
| 12 | Medium | Unbounded object read on S3/Drive ingest (memory DoS) | `storage.rs:371`, `gdrive.rs:606` |
| 13 | Medium | Workspace member roster enumeration by share-link guest | `api.rs:115` |
| 14 | Medium | Tauri CSP disabled (`csp: null`) | `tauri.conf.json:25` |
| 15 | Medium | Desktop file IPC has no workspace-root confinement | `desktop .../workspace/mod.rs:42` |
| 16 | Low | Share-link tokens stored plaintext (not hashed) | `auth.rs:1197` |
| 17 | Low | `get_storage_connection` not workspace-scoped (IDOR) | `persistence.rs:1928` |
| 18 | Low | Caller-supplied `limit` not clamped in list queries | `persistence.rs:1538` |
| 19 | Low | Folder routes ignore token `document_restriction` (latent) | `folders.rs:186` |
| 20 | Low | Cross-tenant existence oracle via distinct MCP errors | `mcp.rs:396` |
| 21 | Low | SSO/tenant-domain enumeration via `/auth/login/select` | `auth.rs:742` |
| 22 | Low | Internal error chain leaked to unauth caller on CLI login | `auth.rs:1129` |
| 23 | Low | External filenames can inject `..` into folder tree | `storage.rs:1102` |
| 24 | Low | Untrusted slug not URL-encoded in notification deep-link | `notifications.rs:110` |
| 25 | Low | Token-endpoint response body written to logs | `gdrive.rs:306` |
| 26 | Low | CLI credential file world-readable before chmod 0600 | `cli/store.rs:83` |
| 27 | Low | CLI `api_request` builds URL by raw concatenation | `cli/api.rs:413` |
| 28 | Low | Share tokens travel in URLs (query string + WS param) | `collabApi.ts:96` |
| 29 | Info | No rate limiting on the auth surface | `main.rs` router |
| 30 | Info | `storage_connections.config` stored as plaintext jsonb | `persistence.rs:1904` |
| 31 | Info | LIKE metacharacters not escaped in one list query | `persistence.rs:1457` |
| 32 | Info | KaTeX live-preview `innerHTML` bypasses DOMPurify | `web .../livePreview/widgets.ts:124` |

---

## Findings

### 1. [High] SSRF + server-secret exfiltration via user-controlled storage endpoint
- **File:** `crates/muesli-server/src/workspace.rs:684` (creation), `crates/muesli-server/src/storage.rs:561` (GitHub auth header), `crates/muesli-server/src/storage.rs:277` (S3 signing)
- **Category:** SSRF / secret exposure / broken access control
- **Description:** When a storage connection is created, the caller supplies the full destination URL (`api_base` for GitHub-family backends, `endpoint` for S3). The server then immediately issues an authenticated probe request to that host carrying **server-wide shared secrets** — `MUESLI_GITHUB_TOKEN` as `Authorization: token …`, or a SigV4 header whose `Credential=` field exposes the S3 access key id in cleartext. There is no scheme/host allowlist and no block on RFC1918/link-local/loopback addresses. Authorization only requires `require_admin` on the target workspace, but first login auto-creates a personal workspace where the user is `admin` (`ensure_personal_workspace`, `persistence.rs:552`) — so **any authenticated user** qualifies.
- **Impact:** Any signed-in user can (a) exfiltrate the shared GitHub token / S3 key id + a valid request signature to an attacker host, compromising storage for every workspace, and (b) use the server as an SSRF proxy against internal services (`http://169.254.169.254/…`, internal admin ports) from inside the trust boundary.
- **Exploit scenario:** Attacker POSTs a `github` connection with `api_base=https://evil.example`. The server synchronously sends `Authorization: token <MUESLI_GITHUB_TOKEN>` to `evil.example`.
- **Recommendation:** Validate `api_base`/`endpoint` against an operator-configured allowlist (https only, allowed hosts); reject private/loopback resolution; disable redirects on these reqwest clients. Prefer per-connection credentials over a single shared server-wide token.

### 2. [High] @mention delivers notifications/emails to any user with no access check
- **File:** `crates/muesli-server/src/mentions.rs:16` (recipient parsing), `crates/muesli-server/src/api.rs:302` (`record_body_mentions`, called from `create_comment`/`reply_comment`), `crates/muesli-server/src/notifications.rs:116` (email render), backed by `crates/muesli-server/src/persistence.rs:969` (`record_mentions`)
- **Category:** Broken authorization / notification & email injection (phishing amplification)
- **Description:** `parse_mentions` extracts any syntactically valid `muesli:user/<uuid>` from a comment body. The only downstream gate is `where exists (select 1 from users where id = $2)` — i.e. "is this a real user anywhere in the system." There is no check that the recipient is a member of the document's workspace or has any ACL grant on the document. Posting a comment requires only `Role::Commenter`, obtainable via a **guest share link**. For each recipient the pipeline writes an in-app notification and dispatches an email whose subject/body embed attacker-influenced strings (`actor_name` = the mentioner's own display name, `doc_title` = a document title the attacker controls), sent from the product's trusted SMTP identity. No rate limiting.
- **Impact:** A share-link guest can push inbox notifications and SPF/DKIM-aligned emails to arbitrary users across other tenants, with an attacker-chosen subject line — a high-credibility phishing/spam relay that also leaks document titles/slugs across tenant boundaries.
- **Exploit scenario:** Attacker sets display name to `Muesli Security`, titles a doc `Verify your account: http://evil.example`, then comments `@[x](muesli:user/<victim-uuid>)`. The unrelated victim receives an email from the trusted Muesli domain with the attacker's text in the subject.
- **Recommendation:** Before recording a mention, intersect parsed recipient IDs with the document's authorized audience (workspace members ∪ ACL grantees, the set `list_document_members` returns) and drop the rest. Do this authoritatively in the recording path. Additionally, treat `actor_name`/`doc_title` as untrusted when composing the subject (clamp length, strip control chars/URLs) and rate-limit outbound mention email per actor. (CRLF header injection itself is already prevented by lettre's typed header encoding.)

### 3. [Medium] Session cookie missing the `Secure` flag
- **File:** `crates/muesli-server/src/auth.rs:807`
- **Category:** Insecure cookie / broken authentication
- **Description:** The session cookie sets `HttpOnly` and `SameSite=Lax` but never `Secure`. The 30-day (`SESSION_TTL_SECS`) opaque token can therefore be transmitted over plaintext HTTP.
- **Impact:** A network attacker on any non-TLS hop (public Wi-Fi, HTTP downgrade, mixed-content sub-resource) captures a long-lived session token and replays it for full account takeover.
- **Exploit scenario:** Victim follows an `http://` link to the app; the browser attaches `muesli_session` in cleartext; the attacker replays it over HTTPS.
- **Recommendation:** Add `.secure(true)` to the session cookie and the logout removal cookie; gate off only for local `http://localhost` dev if needed.

### 4. [Medium] Open redirect via the `next` parameter
- **File:** `crates/muesli-server/src/auth.rs:668` (validation), `auth.rs:812` (redirect)
- **Category:** Open redirect
- **Description:** `next` is accepted if it `starts_with('/')` or `starts_with(&auth.web_origin)`. Both are bypassable: `//evil.com/phish` passes the `/` check (browsers resolve protocol-relative URLs to a full origin), and `https://app.example.com.evil.com` passes the prefix check. The value is stored in `PendingLogin` and used in `Redirect::to(&next)` after a successful login.
- **Impact:** A trusted-domain link redirects the victim to an attacker page **after** a real login, making phishing/consent-laundering look legitimate.
- **Exploit scenario:** Send `https://app.example.com/auth/login?next=//evil.com`; victim authenticates, lands on `https://evil.com`.
- **Recommendation:** Require `next` to start with a single `/` (reject `//` and `/\`), or parse it and compare the full origin for equality rather than using `starts_with`.

### 5. [Medium] Session tokens stored in plaintext in Redis
- **File:** `crates/muesli-server/src/auth.rs:584`
- **Category:** Secrets at rest
- **Description:** Session tokens are stored with the raw token as the Redis key (`muesli:session:{token}`). This is the opposite of API tokens, which are SHA-256-hashed before storage (`hash_token`, `lookup_api_token`). A Redis leak therefore yields directly replayable session credentials.
- **Impact:** Anyone who can read Redis (RDB backup, exposed 6379, shared instance, SSRF-to-Redis) obtains live session tokens usable as cookies — account takeover with no cracking.
- **Exploit scenario:** Read a Redis snapshot, paste a `muesli:session:*` key into a `Cookie: muesli_session=…` header.
- **Recommendation:** Store `hash_token(session_token)` as the key (and in the in-memory map), hashing the incoming cookie on lookup — mirroring the API-token handling.

### 6. [Medium] Login CSRF — OIDC `state` not bound to the initiating browser
- **File:** `crates/muesli-server/src/auth.rs:706` (pending stored globally), `auth.rs:786` (callback consumes any matching state)
- **Category:** CSRF / session fixation of identity
- **Description:** `login` stores `PendingLogin` keyed only by the `state` secret, with no cookie tying the pending attempt to the browser that started it. The callback is a top-level GET that sets a session cookie, so `SameSite=Lax` does not block it. `state`/PKCE protect against code injection but nothing binds the completed login to the victim's browser.
- **Impact:** Classic login CSRF — an attacker forces a victim's browser into a session for the **attacker's** account, so the victim's subsequent work and pasted content land in the attacker's account.
- **Exploit scenario:** Attacker captures a valid `code`+`state` for their own IdP session and lures the victim to `/auth/callback?code=…&state=…`; the victim's browser receives the attacker's session.
- **Recommendation:** On `login`, set a short-lived HttpOnly+Secure cookie carrying the `state` (or a random binding value); in `callback`, require it to match before exchanging the code.

### 7. [Medium] Google Drive OAuth refresh token stored plaintext at rest
- **File:** `crates/muesli-server/src/gdrive.rs:787`
- **Category:** Sensitive data at rest
- **Description:** After the token exchange, the long-lived Drive **refresh token** is written verbatim into `storage_connections.config` jsonb. It is redacted from the listing API but stored in cleartext in Postgres.
- **Impact:** Anyone with DB read access (backup, replica, an unrelated SQL bug, the IDOR in finding 17) recovers a refresh token granting persistent `drive.file` access to every connected user's Drive, surviving password/session changes until revoked at Google.
- **Exploit scenario:** Attacker obtains a DB backup and exchanges each `config.refresh_token` at Google's token endpoint for fresh access tokens.
- **Recommendation:** Encrypt secret config fields at rest (envelope encryption / KMS), or keep them in a dedicated access-restricted secrets store, decrypting only in memory.

### 8. [Medium] Path traversal via `rel_path` in storage backends
- **File:** `crates/muesli-server/src/storage.rs:271` (S3 key), `storage.rs:472` (`join_repo_path`), `storage.rs:557` (`repo_path`)
- **Category:** Path traversal / arbitrary object read-write-delete
- **Description:** Backends map a connection-relative path to an object key by only stripping a leading `/`; `..` segments are never rejected or normalized. `sanitize_filename_segment` is applied only to the title stem, not to folder-chain segments (joined raw) or to stored `rel_path` values. For hierarchical backends (GitHub/Gitea/Forgejo/Drive) a `..`-bearing path escapes the configured `prefix`. (S3 keys are literal, so S3 is not traversable.)
- **Impact:** Where one repo/drive is shared across workspaces via distinct prefixes, a member of one workspace can read/overwrite/delete another workspace's files.
- **Exploit scenario:** Two workspaces share a repo isolated by `prefix: teamA/` / `prefix: teamB/`. Team A attaches a doc with `rel_path=../teamB/secrets.md`; the next materialize does `PUT /contents/teamA/../teamB/secrets.md`.
- **Recommendation:** Add a shared validator rejecting `..`, leading `/`, and empty segments; apply it in `attach_document_storage`, `rel_path_for(_named)`, and defensively inside each backend's `key`/`repo_path`.

### 9. [Medium] Backlinks endpoint leaks slugs/IDs of inaccessible documents
- **File:** `crates/muesli-server/src/links.rs:549` (queries `persistence.rs:2121` `links_from`, `persistence.rs:2142` `links_to`)
- **Category:** Broken access control / information disclosure
- **Description:** `GET /api/documents/{slug}/links` authorizes the caller only as Viewer on the *target* doc (including via a `?share=` guest token), then returns backlink edges verbatim. The queries key only on `document_id` and apply no visibility filter, so every edge exposes the other document's `document_id`, `slug`, and raw link text. The sibling `graph` handler in the same file *does* omit edges to non-visible docs, making this an inconsistent weaker path.
- **Impact:** A Viewer share-link guest (or anonymous, in open mode) can enumerate globally-unique slugs/UUIDs and link text of arbitrary private documents in other workspaces that link to/from the shared doc.
- **Exploit scenario:** `GET /api/documents/public-notes/links?share=<token>` returns `{document_id, slug}` for every private doc referencing `public-notes`.
- **Recommendation:** Filter both link lists to documents visible to the caller (mirror `graph`); for share-link guests, drop backlinks from documents outside the shared scope.

### 10. [Medium] Presence/awareness identity spoofing
- **File:** `crates/muesli-server/src/room.rs:390` (`on_awareness`, rebroadcast at `room.rs:408`)
- **Category:** Message spoofing between collaborators
- **Description:** `on_awareness` rebroadcasts the original awareness bytes untouched. The identity fields (`user.name`, `user.color`, `user.kind`) and Yjs `client_id` are never bound to the connection's authenticated `author_id`. Awareness is allowed for all roles, including read-only Viewers and guests, and malformed payloads are relayed anyway.
- **Impact:** Any participant can impersonate another collaborator's name/cursor, fake the "✦ Agent editing" indicator (`kind: "agent"`), or clobber another user's presence by reusing their `client_id` — undermining the trust signals collaborators rely on.
- **Exploit scenario:** A Viewer guest sends awareness with `user = { name: "<owner>", kind: "agent" }`; peers render the owner as present at an attacker-chosen cursor.
- **Recommendation:** Server-side, overwrite/validate the identity-bearing fields against the connection's authenticated identity before rebroadcast, reject `client_id`s owned by another connection, and drop payloads that fail to decode.

### 11. [Medium] Room-actor DoS via unbounded anchor resolution / edits
- **File:** `crates/muesli-server/src/api.rs:198` (`list_comments` loop), `api.rs:581` (`create_suggestion` per-edit loop); MCP twins `mcp.rs:941`, `mcp.rs:814`
- **Category:** Unbounded resource consumption (DoS)
- **Description:** Each document is served by a single serialized actor. List endpoints issue one blocking `ResolveAnchor` per thread/suggestion (each `materialize()` is O(document size)) with no pagination or cap, and `create_suggestion` / MCP `edit_document` accept an unbounded `edits` array, each element firing a serialized `CreateAnchor`.
- **Impact:** A Commenter can inflate thread/suggestion counts so every list call performs O(threads × doc_size) serialized work, or send one large-`edits` request, monopolizing the room actor and stalling live editing for all collaborators.
- **Exploit scenario:** Script thousands of `create_comment` calls, then repeatedly `GET …/comments`; each request pins the actor for seconds.
- **Recommendation:** Add pagination + hard caps on the list endpoints, cap edits per request, and batch anchor resolution into a single room message.

### 12. [Medium] Unbounded object read on S3/Drive ingest (memory DoS)
- **File:** `crates/muesli-server/src/storage.rs:371` (S3 read), `crates/muesli-server/src/gdrive.rs:606` (Drive read), poll at `storage.rs:1084`
- **Category:** Unbounded resource consumption (DoS)
- **Description:** The GitHub backend guards large blobs (rejects >1 MiB), but S3 and Drive read the whole object into memory with no size cap. The poll loop loads every attached object fully (bytes + `to_vec` + `String`) each pass, sequentially.
- **Impact:** An actor who can place a multi-GB file in the backing store causes the next poll to exhaust memory and stalls ingest for the workspace.
- **Exploit scenario:** Drop a huge object in the connected bucket/Drive; the poll tick loads it entirely into RAM.
- **Recommendation:** Enforce a max object size (streamed read with a byte cap, or check metadata size before download) and skip/log oversized objects, mirroring the GitHub guard.

### 13. [Medium] Workspace member roster enumeration by share-link guest
- **File:** `crates/muesli-server/src/api.rs:115` (`list_members`), query `persistence.rs:918` (`list_document_members`)
- **Category:** Broken access control / information disclosure
- **Description:** `GET /api/documents/{slug}/members` requires only Viewer (obtainable via share link) but returns the union of **all workspace members** plus ACL grantees — user IDs, display names, avatars, kind.
- **Impact:** An external party with a read-only link to one document enumerates the entire host workspace roster. The harvested UUIDs are exactly what makes finding 2 practical.
- **Exploit scenario:** Guest calls `list_members` on the shared doc and receives every workspace member's identity.
- **Recommendation:** For non-member (share-link) callers, restrict the roster to the document's explicit ACL grantees; gate the full workspace roster behind actual membership.

### 14. [Medium] Tauri CSP disabled (`csp: null`)
- **File:** `apps/desktop/src-tauri/tauri.conf.json:25`
- **Category:** Missing defense-in-depth (XSS containment)
- **Description:** `security.csp` is `null` and there is no CSP `<meta>` in `app.html`. The webview renders collaborative markdown authored by other users (via sync) through `{@html}` in `ReadingView.svelte` and `SnapshotView.svelte`. The sole barrier is DOMPurify inside `renderMarkdown`; with no CSP there is no second layer if that barrier ever regresses. The blast radius is large because the webview has broad IPC (findings 15 and 27–29).
- **Impact:** A single DOMPurify bypass / KaTeX-mermaid trust regression becomes arbitrary local file access and Keychain-token-authenticated server requests.
- **Exploit scenario:** Malicious synced document text triggers XSS in the webview, which then drives the file and `api_request` IPC commands.
- **Recommendation:** Set a strict CSP (e.g. `default-src 'self'`, no `unsafe-inline` scripts, `img-src` as needed).

### 15. [Medium] Desktop file IPC has no workspace-root confinement
- **File:** `apps/desktop/src-tauri/src/workspace/mod.rs:42` (`read_note`), `:53` (`write_note`)
- **Category:** Path traversal / arbitrary local file access (local; amplifies finding 14)
- **Description:** `read_note(path)` reads any caller-supplied absolute path; `write_note(path, contents)` does `create_dir_all(parent)` + write on any path. Neither canonicalizes nor checks against the active workspace root — even though `rename_path`/`move_path` in the same file *do* reject `..`/separators (with a passing test), so the guard exists but wasn't applied here. Both commands are reachable from any script in the webview.
- **Impact:** Combined with finding 14, an XSS becomes arbitrary local file read and write/overwrite.
- **Exploit scenario:** Webview script calls `write_note("/Users/x/.zshrc", …)`.
- **Recommendation:** Canonicalize the path and assert `starts_with(workspace_root)` in `read_note`/`write_note`, reusing the existing traversal guard.

### 16. [Low] Share-link tokens stored plaintext (not hashed)
- **File:** `crates/muesli-server/src/auth.rs:1197` (`create_share`), `persistence.rs:1612` (`create_share_link`), `persistence.rs:739` (`share_link_role`)
- **Category:** Secrets at rest
- **Description:** Share tokens have strong entropy (256-bit) and enforced expiry, but unlike API tokens they are stored and compared verbatim rather than as a SHA-256 digest.
- **Impact:** Anyone with read access to `share_links` (backup, SQL bug, log leak) obtains live, directly-usable document capabilities.
- **Recommendation:** Store `hash_token(token)` and compare hashes, mirroring `api_tokens`.

### 17. [Low] `get_storage_connection` is not workspace-scoped
- **File:** `crates/muesli-server/src/persistence.rs:1928`
- **Category:** Missing tenant scoping / potential IDOR
- **Description:** `get_storage_connection(id)` selects by primary key alone and returns the full `config` jsonb, unlike its workspace-scoped siblings `list_storage_connections` / `delete_storage_connection`. Any caller that trusts the result without re-checking `workspace_id` exposes a cross-workspace read of connection config (including the plaintext gdrive OAuth material from finding 7).
- **Recommendation:** Add a `workspace_id` parameter and filter on it, matching `delete_storage_connection`.

### 18. [Low] Caller-supplied `limit` not clamped in list queries
- **File:** `crates/muesli-server/src/persistence.rs:1538` (`search_documents`), `:1130` (`list_notifications`), `:1403` (`history`), `:2638` (`list_audit`)
- **Category:** Unbounded query / DoS
- **Description:** These bind `limit` directly with no server-side maximum, unlike `list_documents_visible` (hard `limit 200`) / `list_folders_visible` (`limit 500`). If a handler forwards an unclamped client value, one request can force a very large result set.
- **Recommendation:** Enforce an upper bound inside these functions (e.g. `limit.clamp(1, 200)`).

### 19. [Low] Folder routes ignore token `document_restriction` (latent)
- **File:** `crates/muesli-server/src/folders.rs:186` (`ctx` / `require_workspace`)
- **Category:** Broken access control / token-scope enforcement gap
- **Description:** `folders.rs::ctx` captures `workspace_restriction` but discards `document_restriction`, unlike `auth::resolve_access`, `folders::doc_editor`, and `workspace::WsCtx` which treat it as a hard boundary. A document-scoped token could thus create documents/folders and rename/move/trash whole folder subtrees. Verified **latent, not currently reachable** — the restriction columns exist and are honored on read, but no code path populates them yet (`insert_api_token` always inserts NULL). The gap becomes live the moment scoped-token minting ships.
- **Recommendation:** Capture and enforce `document_restriction` in `folders.rs::ctx` now, before scoped-token minting is enabled.

### 20. [Low] Cross-tenant existence oracle via distinct MCP errors
- **File:** `crates/muesli-server/src/mcp.rs:396` (`doc_by_slug`; also `slug_from_args` at `:370`)
- **Category:** Information disclosure / enumeration
- **Description:** Returns distinguishable errors for not-found (`document not found: {slug}`), unauthorized (`forbidden: you have no access to {slug}`), and exists-on-create (`document already exists: {slug}`), independent of authorization.
- **Impact:** Any Bearer-token MCP client can distinguish "no such document" from "exists but forbidden," enumerating documents in other tenants.
- **Recommendation:** Collapse not-found and forbidden into one generic error and avoid echoing the caller-supplied slug in a state-distinguishing way.

### 21. [Low] SSO / tenant-domain enumeration via `/auth/login/select`
- **File:** `crates/muesli-server/src/auth.rs:742`
- **Category:** Information disclosure / enumeration
- **Description:** Unauthenticated and unthrottled, the endpoint returns 302 when a domain maps to a configured workspace SSO issuer and a distinct 404 otherwise, revealing which corporate domains are tenants of the deployment.
- **Recommendation:** Return a uniform response and/or add rate limiting, or document as accepted risk.

### 22. [Low] Internal error chain leaked to unauthenticated caller on CLI login
- **File:** `crates/muesli-server/src/auth.rs:1129`
- **Category:** Information disclosure
- **Description:** `format!("login rejected: {e:#}")` returns the full `anyhow` chain in the HTTP body to an unauthenticated client, disclosing issuer URLs, JWKS/discovery failures, and DB error text.
- **Recommendation:** Return a generic message to the client; keep the detailed chain in the `warn!` log only.

### 23. [Low] External filenames can inject `..` into the folder tree
- **File:** `crates/muesli-server/src/storage.rs:1102` (poll folder placement), `persistence.rs:2408` (`ensure_folder_chain`)
- **Category:** Path traversal (folder-tree pollution)
- **Description:** On ingest, `rel_path` is split and fed to `ensure_folder_chain` without `valid_folder_name` validation, so a maliciously-named external file (Drive maps `∕`→`/`) can create folders named `..` and produce `..`-containing backend keys on the next relocate. Impact is confined to remote object stores (no local FS backend), but the DB folder tree gets polluted.
- **Recommendation:** Reject segments failing `valid_folder_name` (including `.`/`..`/empty) in `ensure_folder_chain`, and validate ingested `rel_path`.

### 24. [Low] Untrusted slug not URL-encoded in notification deep-link
- **File:** `crates/muesli-server/src/notifications.rs:110`
- **Category:** URL injection
- **Description:** `doc_deep_link` builds `"{origin}/#/doc/{doc_slug}"` by raw interpolation with no percent-encoding, unlike the Drive path which uses `uri_encode`. A slug with reserved characters yields a malformed/redirecting link in the plaintext mention email, compounding finding 2.
- **Recommendation:** Percent-encode `doc_slug` and constrain the slug charset at creation.

### 25. [Low] Token-endpoint response body written to logs
- **File:** `crates/muesli-server/src/gdrive.rs:306`
- **Category:** Sensitive data in logs
- **Description:** `token_request` folds the full raw response body into an error (`google token endpoint: {status} {body}`) that propagates to `warn!`. Google's error bodies normally carry no secrets, but coupling raw upstream token-endpoint bodies into logs is fragile.
- **Recommendation:** Log only status and a short sanitized message; never fold the raw body into a logged error.

### 26. [Low] CLI credential file world-readable before chmod 0600
- **File:** `crates/muesli-cli/src/store.rs:83`
- **Category:** Insecure credential storage (TOCTOU)
- **Description:** In the keychain-unavailable fallback, `write_file_tokens` does `std::fs::write` (honoring umask, typically 0644) and only then `set_permissions(0o600)`, leaving a world-readable window on first creation. Reached on headless Linux or with `MUESLI_TOKEN_STORE=file`.
- **Impact:** A co-tenant on a shared host can read the bearer token during the race window.
- **Recommendation:** Create the file atomically at 0600 (`OpenOptions … .mode(0o600)`) before writing, or write to a 0600 temp file and rename; set 0700 on the parent dir.

### 27. [Low] CLI `api_request` builds the URL by raw concatenation
- **File:** `crates/muesli-cli/src/api.rs:413`
- **Category:** Unsafe URL construction (defense-in-depth)
- **Description:** `format!("{}{}", http_base(server), path)` with no validation that the result stays same-origin. A `path` beginning with `@`, `//`, or containing `\` can re-point the host (`http://host:8787` + `@evil.com/x` → host `evil.com`), sending the bearer token off-origin. Today paths are app-constructed, so exploitation needs another foothold.
- **Recommendation:** Parse the base into a `reqwest::Url` and join via the URL API (rejecting authority-bearing input), or assert `path` starts with a single `/` and contains no `@`/`\`/`//`.

### 28. [Low] Share tokens travel in URLs
- **File:** `apps/web/src/collabApi.ts:96` (query string), `apps/web/src/session.svelte.ts:48` (WS param)
- **Category:** Secret in URL / log exposure
- **Description:** The share token is appended as `?share=<token>` on every REST request and passed as a WebSocket query param. Secret capability tokens in URLs are recorded in server/proxy access logs and browser history.
- **Recommendation:** Send the share token in a header (e.g. `X-Muesli-Share`) or POST body.

### 29. [Info] No rate limiting on the auth surface
- **File:** router in `crates/muesli-server/src/main.rs:207`
- **Category:** Missing rate limiting
- **Description:** No brute-force / rate limiting on `/auth/*`, `/api/cli/login`, share-token use, or Bearer auth. Largely mitigated because every secret is 256-bit CSPRNG (guessing infeasible) and `cli_login` only accepts cryptographically verified ID tokens. Residual risk is DoS/amplification: each `cli_login`/`mint_token` creates an agent user row, and `/auth/login/select` hits the DB per call.
- **Recommendation:** Add coarse per-IP rate limiting on unauthenticated auth endpoints and cap outstanding agent identities per owner.

### 30. [Info] `storage_connections.config` stored as plaintext jsonb
- **File:** `crates/muesli-server/src/persistence.rs:1904`
- **Category:** Secrets at rest
- **Description:** The `config` jsonb is persisted verbatim. S3/GitHub deliberately keep secrets in env, but the gdrive backend stores its OAuth refresh token here (finding 7), so DB read access exposes it. Also surfaced by `document_attachment`/`attached_documents` and the unscoped `get_storage_connection` (finding 17).
- **Recommendation:** Encrypt secret config fields at rest and keep them out of connection config returned to callers.

### 31. [Info] LIKE metacharacters not escaped in one list query
- **File:** `crates/muesli-server/src/persistence.rs:1457`
- **Category:** Input handling (not injection)
- **Description:** `list_documents_visible` binds the query string (so this is **not** SQL injection) but does not escape LIKE wildcards `%`/`_`, unlike `search_documents` which uses `search::escape_like`. Impact is limited to broadened matching within the caller's already-authorized visibility set.
- **Recommendation:** Reuse `search::escape_like` for consistency.

### 32. [Info] KaTeX live-preview `innerHTML` bypasses DOMPurify
- **File:** `apps/web/src/livePreview/widgets.ts:124` (also `mermaid.ts:89`)
- **Category:** XSS surface (currently mitigated)
- **Description:** `MathWidget`/`InlineMathWidget` set `innerHTML = renderKatexCached(...)` directly, relying solely on KaTeX's `trust: false` (which disables `\href`/`\html*`) rather than the DOMPurify pass used in `render.ts`. Mermaid similarly relies on `securityLevel: "strict"`. Both are the correct safe settings, so this is not currently exploitable — but a config regression would become directly exploitable with no backstop.
- **Recommendation:** Route these `innerHTML` assignments through the same `sanitize()` used in `render.ts`, or add a regression test asserting the KaTeX `trust` / mermaid `securityLevel` settings.

---

## Verified safe (checked, no action needed)

- **SQL injection** — every query uses bound `$n` parameters; search LIKE input is escaped and FTS uses `plainto_tsquery`. No string-built SQL.
- **Markdown/HTML rendering** — `render.ts` always runs output through DOMPurify with a minimal MathML allowlist; the only `{@html}` in the web app is fed sanitized HTML; mention chips use `textContent`.
- **OIDC validation** — signature/issuer/audience/nonce/expiry checked; callback bound to the issuer login started with; JWKS refresh gated to unknown-kid and rate-limited; RP HTTP client has redirects disabled.
- **Token entropy & comparison** — 256-bit CSPRNG tokens throughout; API tokens hashed at rest; timing side-channels non-exploitable given entropy.
- **WebSocket auth** — `resolve_access` runs before upgrade and writes are re-gated per message in the room actor.
- **IDOR object-scoping** — suggestions/threads verified against their document; notifications recipient-scoped on every query; storage-connection mutations workspace-scoped.
- **Role gates** — workspace admin actions call `require_admin`; last-admin guard enforced and tested; share tokens can only raise access, never grant membership.
- **CORS** — single explicit origin with credentials; no wildcard.
- **CLI/desktop TLS** — reqwest with rustls default cert verification; no `danger_accept_invalid_certs`; browser open uses argv (no shell injection); CLI file-sync sanitizes server-provided path segments.
- **Tauri capabilities** — narrow allowlist; no `fs`/`shell`/`http` plugin scopes; no `dangerousRemoteDomainIpcAccess`; local-bundled frontend.

## Recommended remediation order

1. **Finding 1** (SSRF + shared-secret exfiltration) — highest impact, reachable by any authenticated user.
2. **Finding 2** + supporting **13** (mention authorization + roster enumeration) — cross-tenant phishing/spam; the two compound each other.
3. **Findings 3, 5, 6** (session cookie `Secure`, session tokens hashed at rest, login-CSRF binding) — quick, high-value auth hardening.
4. **Findings 7, 8, 12** (gdrive token at rest, storage path traversal, ingest memory cap) — storage-layer confidentiality and availability.
5. **Findings 9, 10, 11** (backlink leak, awareness spoofing, room-actor DoS) — collaboration trust boundary.
6. **Findings 14, 15** (desktop CSP + file IPC confinement) — desktop hardening.
7. Remaining Low/Info items as cleanup, prioritizing **19** before scoped-token minting ships.
