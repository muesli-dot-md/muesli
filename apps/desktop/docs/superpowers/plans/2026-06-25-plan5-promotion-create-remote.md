# Local→Shared Promotion + Create-Remote (Plan 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two final workspace-picker actions — **Create remote** (make an empty server workspace and go live) and **Promote** (turn an existing local-only workspace into a shared server workspace, pushing its files up) — completing sub-project #1 (Auth + Remote Workspaces).

**Architecture:** Two new **purely-structural** server endpoints — `POST /api/workspaces` (create workspace) and `POST /api/documents` (create a document **directly in a target workspace**) — close the gap that today's server can only birth documents in a creator's *personal* workspace. The demo_muesli daemon, when it goes live on the folder, reuses its existing one-replica-per-doc CRDT path to push the actual file **text**; the endpoints never carry content. Promote flips the local registry row's state local-only→cloned (a primary-key change: the row is re-keyed from the local path to the server workspace id); create-remote registers a fresh cloned row against a chosen empty folder.

**Tech Stack:** Rust (axum + sqlx/Postgres server-side; reqwest client-side; yrs CRDT), Tauri 2, SvelteKit / Svelte 5 runes, rusqlite (local registry).

## Global Constraints

- **Branches stay UNMERGED — Julian merges.** Server + cli on muesli `feat/cli-list-workspaces`; client on demo_muesli `feat/auth-remote-workspaces`. **Commit messages carry NO `Co-Authored-By` trailer.**
- **One-replica-per-doc is sacred.** `POST /api/documents` MUST NEVER accept or set document text/content — only `slug` / `workspace_id` / `folder_id` / `title`. Text is owned by the daemon's CRDT replica and flows through the room. A second text writer reintroduces the two-replicas bug the architecture exists to prevent.
- **Data-loss safety.** Promote's registry transition deletes a SQLite REGISTRY ROW, never a disk file. No Plan-5 path deletes or trashes local files.
- **Do not regress Plan 3's flicker fix / Plan 4's poll retirement.** `daemon.status` stays value-stable (set ≤twice/lifecycle). Add no recurring `daemon.status` reassignment and no status poll.
- **Build/test commands.** muesli: plain `cargo` (`cargo test -p muesli-server`, `cargo test -p muesli-cli`, `cargo clippy -p <crate> --tests`). demo_muesli `src-tauri`: prefix with `DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx`. Frontend: `pnpm check` (expect `0 errors and 0 warnings`) and `pnpm test` (`vitest run`).
- **No Postgres test harness** in muesli-server (no `tests/` dir). New endpoint tests are unit-level (pure helpers + the membership/consistency gate mirrors the audited `create_folder` pattern verbatim).
- **Phases run A → B → C.** Phase B imports Phase A's endpoints; Phase C calls Phase B's `api` helpers. demo_muesli depends on muesli-cli/core via PATH deps, so Phase C builds against the live muesli working tree (A+B must be committed there first).

## Cross-phase interface ledger (the reconciled signatures — every task conforms to these)

- **Server `persistence.rs`:** `create_workspace(&self, name: &str, owner: Uuid) -> Result<Uuid>`; `create_document_in_workspace(&self, slug: &str, workspace_id: Uuid, folder_id: Option<Uuid>, title: Option<&str>, owner: Uuid) -> Result<CreatedDoc>`; `struct CreatedDoc { id: Uuid, workspace_id: Uuid, folder_id: Option<Uuid>, created: bool }`.
- **Server routes:** `POST /api/workspaces` → `workspace::create_workspace` (201, `{id,name,role:"admin",is_personal:false}`); `POST /api/documents` → `folders::create_document` (201, `{document_id,slug,workspace_id,folder_id}`; publishes `WorkspaceEvent::DocCreated{slug,folder_id,title}` with `origin` from `x-muesli-client-id`).
- **Daemon `api.rs`:** `create_workspace(server, token: Option<&str>, name) -> Result<WorkspaceInfo>`; `create_document(server, token, client_id, workspace_id, slug, folder_id: Option<&str>, title: Option<&str>) -> Result<()>` (sends `x-muesli-client-id`; HTTP 409 = idempotent success).
- **Daemon `sync.rs`:** `on_new_file` births brand-new docs in `W` via `api::create_document` (after `resolve_folder_chain`) when `workspace_id.is_some() && token.is_some()`, root and foldered alike; lazy/personal path unchanged when `workspace_id` is None.
- **Client `workspace_index`:** `delete_workspace(conn, id: &str) -> Result<()>`. **Client commands:** `create_remote_workspace(server, name) -> Result<WorkspaceInfo, String>`; `promote_workspace(old_id, server, name, path) -> Result<String, String>` (deletes the `id=path` row, upserts `id=<server_ws_id>` cloned row).
- **Client TS:** `createRemoteWorkspace(server, name)`; `promoteWorkspace(oldId, server, name, path)`. **Store:** `WorkspacesStore.createRemoteWorkspace(name, path)` and `.promoteLocalToRemote(view)`, both ending at the existing `openFolderWithSync(path, server, workspaceId)`.

---

> **Phases run in order A → B → C.** Within a phase, tasks are mostly independent and reviewer-gateable. Model guidance per task is noted at each task header.

---

# Plan 5 — Phase A (server) tasks

Implementation tasks for Phase A of Plan 5, against muesli repo
`/Users/julianbeaulieu/Code/muesli` on branch `feat/cli-list-workspaces` (read/write as-is; do
NOT switch branches). These conform exactly to the LOCKED brief
(`plan5-architecture-brief.md`) Phase-A interface ledger and Global Constraints.

**Inherited constraints (every task):**
- Branch stays UNMERGED — Julian merges. Commit messages carry **NO `Co-Authored-By` trailer**.
- `POST /api/documents` is **purely structural** — it NEVER accepts or sets document text/content.
  One-replica-per-doc is sacred; text flows through the daemon CRDT room only.
- Build/test: plain `cargo`. Per-task commands: `cargo test -p muesli-server`,
  `cargo clippy -p muesli-server --tests`.
- **No Postgres test harness exists in muesli-server.** Verified: `persistence.rs` has no
  `#[sqlx::test]` and no `#[cfg(test)] mod tests` with DB access — only a `lazy_for_tests`
  helper that points a pool at a dead address for audit failure-path tests; there is no
  `crates/muesli-server/tests/` dir. The two new persistence fns are therefore exercised by
  **live verification** (and downstream Phase B/C), NOT a new pg integration test. New
  unit tests stay pure: helper-level (blank-name rejection) + gate-matrix style mirroring the
  existing `last_admin_guard_matrix` / `document_update_events` tests.

**Schema facts established by reading the migrations (load-bearing):**
- `documents`: `slug text not null unique` (0001 → constraint name `documents_slug_key`),
  `workspace_id uuid` + `created_by uuid` (0002), `folder_id uuid` + `title text` (0008),
  `starred` (0011). `updated_at`/`created_at` default `now()`.
- `workspaces (id, name, plan, created_at)` + `created_by` (added 0005). `memberships
  (workspace_id, user_id, role)`. `document_acl (document_id, user_id, role)` PK
  `(document_id, user_id)`.
- `ensure_document_owned` uses `on conflict (slug) do update set updated_at = now() returning
  id, workspace_id, (xmax = 0) as inserted` to detect insert-vs-existing. Plan 5's
  `create_document_in_workspace` uses `on conflict (slug) do nothing returning id` instead so a
  cross-workspace slug collision is detectable as a *missing* returned row (then looked up).

---

## Task 1 — (A1) Persistence: create_workspace + create_document_in_workspace

**Files:**
- Modify `crates/muesli-server/src/persistence.rs`
  - Add `pub struct CreatedDoc` next to `EnsuredDoc` (~L244–250).
  - Add `pub async fn create_workspace` immediately after `ensure_personal_workspace` (~L502).
  - Add `pub async fn create_document_in_workspace` immediately after `ensure_document_owned`
    (~L561).
  - Add a pure helper `pub(crate) fn blank_name(name: &str) -> bool` (used by A2's handler) in
    the pure-helpers region near the top of the impl-free section, plus a `#[cfg(test)] mod
    tests` at the end of the file (none exists yet) for that helper.

**Interfaces:**
- **Produces:**
  - `pub async fn create_workspace(&self, name: &str, owner: Uuid) -> anyhow::Result<Uuid>`
  - `pub async fn create_document_in_workspace(&self, slug: &str, workspace_id: Uuid, folder_id: Option<Uuid>, title: Option<&str>, owner: Uuid) -> anyhow::Result<CreatedDoc>`
  - `pub struct CreatedDoc { pub id: Uuid, pub workspace_id: Uuid, pub folder_id: Option<Uuid>, pub created: bool }`
  - `pub(crate) fn blank_name(name: &str) -> bool`
- **Consumes:** `sqlx` `self.pool`, `uuid::Uuid`, `anyhow::Result`, `sqlx::Row` (`.get`), the
  existing `documents` / `workspaces` / `memberships` / `document_acl` tables.

**Conflict contract (brief):** `create_document_in_workspace` inserts with `on conflict (slug)
do nothing returning id`. If a row came back → freshly inserted (`created = true`); grant the
owner an `editor` ACL row. If NO row came back → the slug already exists; look up the existing
doc's `workspace_id`: if it equals the requested `workspace_id` → idempotent success
(`created = false`, return the existing id/folder_id); otherwise → a typed cross-workspace
conflict the A3 handler maps to **409**. We surface that typed conflict as an `anyhow::Error`
whose message contains the stable sentinel `"slug_in_other_workspace"` (the A3 handler matches
on it via the existing `conflict_or_500`-style substring check, the same mechanism
`create_folder` uses for `folders_sibling_name`).

### Steps

- [ ] **Step 1: Write the failing pure-helper test.**
  Add at the very end of `crates/muesli-server/src/persistence.rs` (no test module exists yet):
  ```rust
  #[cfg(test)]
  mod tests {
      use super::blank_name;

      #[test]
      fn blank_name_rejects_empty_and_whitespace() {
          assert!(blank_name(""));
          assert!(blank_name("   "));
          assert!(blank_name("\t\n"));
          assert!(!blank_name("Notes"));
          assert!(!blank_name("  Notes  ")); // has non-whitespace content
      }
  }
  ```

- [ ] **Step 2: Run it — it fails to COMPILE (helper does not exist yet).**
  ```
  cargo test -p muesli-server blank_name
  ```
  Expected: compile error `cannot find function `blank_name` in this scope` /
  `unresolved import `super::blank_name``. (Compile failure is the red state here — the symbol
  is intentionally absent.)

- [ ] **Step 3: Add the `blank_name` pure helper.**
  Place it just above `impl Persistence {` (the free-function region, near `DocRef`/`EnsuredDoc`):
  ```rust
  /// True when a user-supplied name is empty once trimmed — the shared blank-name guard for
  /// workspace creation (workspace::create_workspace) and rename. Pure so it is unit-tested
  /// without a database.
  pub(crate) fn blank_name(name: &str) -> bool {
      name.trim().is_empty()
  }
  ```

- [ ] **Step 4: Run the helper test — it passes.**
  ```
  cargo test -p muesli-server blank_name
  ```
  Expected: `test persistence::tests::blank_name_rejects_empty_and_whitespace ... ok`
  and `test result: ok. 1 passed`.

- [ ] **Step 5: Add the `CreatedDoc` struct.**
  Immediately after the `EnsuredDoc` struct (~L250):
  ```rust
  /// A document created by [`Persistence::create_document_in_workspace`] (Plan 5). `created`
  /// is false on the idempotent path (the doc already existed in this same workspace), true
  /// when this call inserted the row.
  pub struct CreatedDoc {
      pub id: Uuid,
      pub workspace_id: Uuid,
      pub folder_id: Option<Uuid>,
      pub created: bool,
  }
  ```

- [ ] **Step 6: Add `create_workspace`.**
  Immediately after `ensure_personal_workspace` (~L502). This MIRRORS the tx in
  `ensure_personal_workspace` MINUS the "return existing" pre-check — it always creates:
  ```rust
  /// Create a brand-new workspace owned by `owner`, who is granted the 'admin' membership.
  /// Unlike [`Self::ensure_personal_workspace`] there is NO get-or-create pre-check: every
  /// call inserts a fresh workspace (Plan 5 — explicit create-remote / promote).
  pub async fn create_workspace(&self, name: &str, owner: Uuid) -> Result<Uuid> {
      let mut tx = self.pool.begin().await?;
      let row =
          sqlx::query("insert into workspaces (name, created_by) values ($1, $2) returning id")
              .bind(name)
              .bind(owner)
              .fetch_one(&mut *tx)
              .await?;
      let workspace_id: Uuid = row.get("id");
      sqlx::query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'admin')")
          .bind(workspace_id)
          .bind(owner)
          .execute(&mut *tx)
          .await?;
      tx.commit().await?;
      Ok(workspace_id)
  }
  ```

- [ ] **Step 7: Add `create_document_in_workspace`.**
  Immediately after `ensure_document_owned` (~L561). MIRRORS `ensure_document_owned` but binds
  an explicit `workspace_id` + `folder_id` + `title`, and uses `do nothing` so a slug collision
  is detectable:
  ```rust
  /// Birth a document DIRECTLY in `workspace_id` (Plan 5: POST /api/documents). Purely
  /// structural — sets slug/workspace/folder/title only; the document TEXT is owned by the
  /// daemon's CRDT replica and never touched here (one-replica-per-doc).
  ///
  /// Idempotent on the slug: if the slug already exists IN THE SAME workspace this returns the
  /// existing row with `created = false`; if it exists in a DIFFERENT workspace this errors with
  /// a message containing `slug_in_other_workspace` (the handler maps that to 409). On a fresh
  /// insert the `owner` is granted an explicit 'editor' ACL grant, mirroring
  /// [`Self::ensure_document_owned`].
  pub async fn create_document_in_workspace(
      &self,
      slug: &str,
      workspace_id: Uuid,
      folder_id: Option<Uuid>,
      title: Option<&str>,
      owner: Uuid,
  ) -> Result<CreatedDoc> {
      let mut tx = self.pool.begin().await?;
      let inserted = sqlx::query(
          "insert into documents (slug, workspace_id, folder_id, title, created_by)
           values ($1, $2, $3, $4, $5)
           on conflict (slug) do nothing
           returning id",
      )
      .bind(slug)
      .bind(workspace_id)
      .bind(folder_id)
      .bind(title)
      .bind(owner)
      .fetch_optional(&mut *tx)
      .await?;

      if let Some(row) = inserted {
          let document_id: Uuid = row.get("id");
          sqlx::query(
              "insert into document_acl (document_id, user_id, role) values ($1, $2, 'editor')
               on conflict do nothing",
          )
          .bind(document_id)
          .bind(owner)
          .execute(&mut *tx)
          .await?;
          tx.commit().await?;
          return Ok(CreatedDoc { id: document_id, workspace_id, folder_id, created: true });
      }

      // The slug already exists. Read the existing row's owner workspace to decide:
      // same workspace → idempotent success; different workspace → typed 409 conflict.
      let existing = sqlx::query(
          "select id, workspace_id, folder_id from documents where slug = $1",
      )
      .bind(slug)
      .fetch_one(&mut *tx)
      .await?;
      tx.commit().await?;
      let existing_ws: Option<Uuid> = existing.get("workspace_id");
      if existing_ws == Some(workspace_id) {
          Ok(CreatedDoc {
              id: existing.get("id"),
              workspace_id,
              folder_id: existing.get("folder_id"),
              created: false,
          })
      } else {
          anyhow::bail!("slug_in_other_workspace: {slug} already exists elsewhere")
      }
  }
  ```
  (`anyhow::bail!` is available; `persistence.rs` already uses `anyhow`/`Result` throughout and
  imports `anyhow::Context`. If `bail!` is not already imported, fully-qualify as
  `anyhow::bail!` exactly as written above.)

- [ ] **Step 8: Build + clippy + the full server test suite.**
  ```
  cargo clippy -p muesli-server --tests
  cargo test -p muesli-server
  ```
  Expected: clippy `Finished` with no warnings on the new code; `cargo test` builds and the
  existing suite plus `blank_name_rejects_empty_and_whitespace` pass (`test result: ok`).
  (No DB-touching test is added — see the Phase-A no-harness note.)

- [ ] **Step 9: Commit.**
  ```
  git add crates/muesli-server/src/persistence.rs
  git commit -m "server(plan5): create_workspace + create_document_in_workspace persistence

  Add the two structural primitives Plan 5 needs: create_workspace (always-insert,
  no get-or-create pre-check; owner becomes admin) and create_document_in_workspace
  (births a doc directly in a target workspace, grants the owner an editor ACL, and
  treats a same-workspace slug as idempotent while a cross-workspace slug collision
  errors with a slug_in_other_workspace sentinel for a 409). Pure blank_name helper
  + unit test; DB paths covered by handler/live verification (no pg test harness)."
  ```

---

## Task 2 — (A2) POST /api/workspaces handler + route

**Files:**
- Modify `crates/muesli-server/src/workspace.rs`
  - Add `#[derive(Deserialize)] pub struct CreateWorkspaceReq { name: String }` next to
    `RenameReq` (~L200).
  - Add `pub async fn create_workspace(...)` handler immediately after `list_workspaces`
    (~L141), in the "Workspaces" section.
  - Extend the `#[cfg(test)] mod tests` at the bottom (~L1126) with a pure name-guard test.
- Modify `crates/muesli-server/src/main.rs`
  - Change the `/api/workspaces` route (~L233) to add `.post(...)`.

**Interfaces:**
- **Consumes:** `persistence::create_workspace` (A1), `persistence::blank_name` (A1),
  `WsCtx` + `ctx()` (workspace.rs auth seam), `audit::record` / `AuditEvent`.
- **Produces:** `POST /api/workspaces` → **201** with a `WorkspaceInfo`-compatible body
  `{ id, name, role: "admin", is_personal: false }`. Handler fn
  `workspace::create_workspace(State<AppState>, CookieJar, HeaderMap, Json<CreateWorkspaceReq>) -> Response`.

**Auth/role (mirrors the other workspace-management handlers via `ctx()`):** `ctx()` returns
503 in open mode (`OPEN_MODE`) and 503 with no DB (`NO_DB`), and 401 when unauthenticated. The
brief says "reject open mode with 400, like other workspace-management handlers" — in this
codebase that rejection is the `ctx()`-returned **503** (`OPEN_MODE`); workspace creation
requires identity, so we reuse `ctx()` verbatim (same as `rename_workspace`). No
`require_admin` call — the *new* workspace has no members until this call creates the owner's
admin membership.

### Steps

- [ ] **Step 1: Write the failing pure name-guard test.**
  In `workspace.rs`'s `#[cfg(test)] mod tests` (~L1126), append:
  ```rust
  #[test]
  fn create_workspace_blank_name_is_rejected() {
      use crate::persistence::blank_name;
      // The handler 400s exactly when blank_name() is true (post-trim emptiness).
      assert!(blank_name(""));
      assert!(blank_name("   "));
      assert!(!blank_name("Team"));
      assert!(!blank_name("  Team  "));
  }
  ```

- [ ] **Step 2: Run it — fails to compile (blank_name not yet visible here / not imported).**
  ```
  cargo test -p muesli-server create_workspace_blank_name
  ```
  Expected (if A1 is committed, `blank_name` exists, so this actually *passes* — in that case
  re-order: confirm red by temporarily asserting the wrong thing, e.g. `assert!(!blank_name(""))`,
  see it fail with `assertion failed`, then correct it). The intent of this step is a real
  red→green on the guard semantics, not a compile gate, since A1 already shipped `blank_name`.

- [ ] **Step 3: Add the `CreateWorkspaceReq` struct + handler.**
  After `list_workspaces` (~L141), in the Workspaces section:
  ```rust
  #[derive(Deserialize)]
  pub struct CreateWorkspaceReq {
      name: String,
  }

  /// POST /api/workspaces {name} → 201 { id, name, role: "admin", is_personal: false }.
  /// Creates a brand-new shared workspace owned by the caller (Plan 5 create-remote / promote).
  /// Requires identity (ctx() 503s in open mode / no-DB, 401 unauthenticated) — there is no
  /// require_admin because the workspace has no members until this call grants the owner admin.
  pub async fn create_workspace(
      State(state): State<AppState>,
      jar: CookieJar,
      headers: axum::http::HeaderMap,
      Json(req): Json<CreateWorkspaceReq>,
  ) -> Response {
      let c = match ctx(&state, &jar, &headers).await {
          Ok(c) => c,
          Err(r) => return r,
      };
      let name = req.name.trim();
      if crate::persistence::blank_name(name) {
          return err(StatusCode::BAD_REQUEST, "name is empty");
      }
      match c.persistence.create_workspace(name, c.user_id).await {
          Ok(workspace_id) => {
              audit::record(
                  &c.persistence,
                  AuditEvent::new("workspace_created")
                      .workspace(Some(workspace_id))
                      .actor(Some(c.user_id))
                      .detail(json!({ "name": name })),
              );
              (
                  StatusCode::CREATED,
                  Json(json!({
                      "id": workspace_id,
                      "name": name,
                      "role": "admin",
                      "is_personal": false,
                  })),
              )
                  .into_response()
          }
          Err(e) => err500(e),
      }
  }
  ```

- [ ] **Step 4: Wire the route in `main.rs`.**
  Change (~L233):
  ```rust
          .route("/api/workspaces", get(workspace::list_workspaces))
  ```
  to:
  ```rust
          .route(
              "/api/workspaces",
              get(workspace::list_workspaces).post(workspace::create_workspace),
          )
  ```

- [ ] **Step 5: Run the test + build + clippy.**
  ```
  cargo test -p muesli-server create_workspace_blank_name
  cargo clippy -p muesli-server --tests
  cargo test -p muesli-server
  ```
  Expected: the guard test passes; clippy `Finished` with no warnings; full suite `ok`.

- [ ] **Step 6: Live-verify the 201 shape (no pg test harness).**
  Against a running OIDC-mode server with a signed-in cookie/token (the same manual seam the
  other workspace endpoints use):
  ```
  curl -i -X POST $BASE/api/workspaces -H 'content-type: application/json' \
       -H "cookie: $SESSION" -d '{"name":"Team Alpha"}'
  ```
  Expected: `HTTP/1.1 201 Created` and body
  `{"id":"<uuid>","name":"Team Alpha","role":"admin","is_personal":false}`. Blank name →
  `400` `name is empty`. Open mode (no OIDC) → `503`.

- [ ] **Step 7: Commit.**
  ```
  git add crates/muesli-server/src/workspace.rs crates/muesli-server/src/main.rs
  git commit -m "server(plan5): POST /api/workspaces create-workspace handler + route

  Add workspace::create_workspace next to list_workspaces: requires identity via the
  shared ctx() seam, trims+rejects a blank name (400), calls
  persistence::create_workspace, records a workspace_created audit entry, and answers
  201 with the list_workspaces item shape { id, name, role: admin, is_personal: false }.
  Route /api/workspaces gains .post()."
  ```

> **NOTE (intentional, do not 'fix'):** the 201 body hard-codes `is_personal: false` per the
> locked brief, but `list_workspaces` derives `is_personal` as `created_by = user`, so a later
> GET of the SAME row reports `is_personal: true` (the owner created it). This is a known
> contract wrinkle; the picker UI keys off the registry/`local_only`, not this flag, so it does
> not affect Plan 5 behavior. Flagged for Julian, not changed here.

---

## Task 3 — (A3) POST /api/documents handler + route

**Files:**
- Modify `crates/muesli-server/src/folders.rs`
  - Add `#[derive(Deserialize)] pub struct CreateDocumentReq { workspace_id: Uuid, slug: String, folder_id: Option<Uuid>, title: Option<String> }` near the document-route structs
    (~L610).
  - Add `pub async fn create_document(...)` handler in the document-routes region (next to
    `update_document`, ~L626), reusing `ctx`/`origin_of`/`document_update_events` neighbours.
  - Extend `#[cfg(test)] mod tests` (~L839) with a pure conflict-sentinel matcher test.
- Modify `crates/muesli-server/src/main.rs`
  - Change the `/api/documents` route (~L218) to add `.post(...)`.

**Interfaces:**
- **Consumes:** `persistence::create_document_in_workspace` (A1) → `CreatedDoc`; `Ctx` +
  `ctx()` + `Ctx::require_workspace` (folders.rs auth seam); `persistence::get_folder`;
  `origin_of`; `audit::record` / `AuditEvent`; `muesli_core::events::{WorkspaceEvent,
  WorkspaceEventEnvelope}`; `state.workspace_events.publish`.
- **Produces:** `POST /api/documents` → **201** `{ document_id, slug, workspace_id, folder_id }`.
  Handler `folders::create_document(State<AppState>, CookieJar, HeaderMap, Json<CreateDocumentReq>) -> Response`.

**Auth/role — mirrors `create_folder` (~L314) VERBATIM in structure:** `ctx()` → open mode
allowed (user None), OIDC mode requires `role_cap >= Editor` (else 403 "requires the write
scope") and authentication (else 401). Then `require_workspace(Some(workspace_id))` enforces
membership in the target workspace in OIDC mode (open mode is a no-op), 403 on non-membership /
restricted token. This is the same two-step gate `create_folder` uses.

**Folder/workspace consistency — same check as `update_document` ~L655:** when `folder_id` is
`Some`, fetch via `get_folder`; 404 if missing, 409 if trashed, and **400** if
`folder.workspace_id != Some(workspace_id)` (the doc and its folder must share a workspace —
this is precisely the constraint that today blocks creating a shared-workspace doc, now
satisfied because the folder chain is created in W first by Phase B).

**Slug conflict → 409:** `create_document_in_workspace` returns a same-workspace slug as
idempotent success; a cross-workspace slug as an `anyhow::Error` containing
`slug_in_other_workspace`. Map it via the existing `conflict_or_500` substring mechanism.

**DocCreated publish — reuse the Plan-4 `restore_document` emission pattern verbatim:** publish
`WorkspaceEvent::DocCreated { slug, folder_id: folder_id.map(|f| f.to_string()), title }` to
`workspace_id` with `origin: origin_of(&headers)`.

### Steps

- [ ] **Step 1: Write the failing pure conflict-sentinel test.**
  In folders.rs `#[cfg(test)] mod tests` (~L839), append a test that pins the contract that the
  `slug_in_other_workspace` sentinel routes to 409 via the same `conflict_or_500` matcher used
  for folder names. Add a thin pure helper alongside `conflict_or_500` and test it:
  ```rust
  #[test]
  fn slug_conflict_sentinel_maps_to_409() {
      // The cross-workspace slug error carries this stable sentinel; the handler routes it
      // to 409 through conflict_or_500's substring match (same mechanism as folder names).
      let e = anyhow::anyhow!("slug_in_other_workspace: notes already exists elsewhere");
      assert!(super::is_slug_conflict(&e));
      let other = anyhow::anyhow!("some unrelated db error");
      assert!(!super::is_slug_conflict(&other));
  }
  ```

- [ ] **Step 2: Run it — fails to compile (`is_slug_conflict` absent).**
  ```
  cargo test -p muesli-server slug_conflict_sentinel
  ```
  Expected: `cannot find function `is_slug_conflict` in module `super``.

- [ ] **Step 3: Add the `is_slug_conflict` pure helper.**
  Next to `conflict_or_500` (~L55) in the helpers region:
  ```rust
  /// The cross-workspace slug-collision sentinel raised by
  /// persistence::create_document_in_workspace. Pure so the 409 mapping is unit-tested.
  fn is_slug_conflict(e: &anyhow::Error) -> bool {
      e.to_string().contains("slug_in_other_workspace")
  }
  ```

- [ ] **Step 4: Run it — passes.**
  ```
  cargo test -p muesli-server slug_conflict_sentinel
  ```
  Expected: `test folders::tests::slug_conflict_sentinel_maps_to_409 ... ok`.

- [ ] **Step 5: Add the `CreateDocumentReq` struct + `create_document` handler.**
  Place the struct near the other document-route structs (~L610) and the handler next to
  `update_document` (~L626):
  ```rust
  #[derive(Deserialize)]
  pub struct CreateDocumentReq {
      workspace_id: Uuid,
      slug: String,
      folder_id: Option<Uuid>,
      title: Option<String>,
  }

  /// POST /api/documents {workspace_id, slug, folder_id?, title?} → 201
  /// { document_id, slug, workspace_id, folder_id }. Births a document DIRECTLY in
  /// `workspace_id` (Plan 5). PURELY STRUCTURAL — no text/content is accepted or written; the
  /// document body is owned by the daemon's CRDT replica (one-replica-per-doc). Auth mirrors
  /// create_folder: open mode allowed; OIDC mode requires Editor + membership in workspace_id.
  pub async fn create_document(
      State(state): State<AppState>,
      jar: CookieJar,
      headers: axum::http::HeaderMap,
      Json(req): Json<CreateDocumentReq>,
  ) -> Response {
      let c = match ctx(&state, &jar, &headers).await {
          Ok(c) => c,
          Err(r) => return r,
      };
      if let Err(r) = c.require_workspace(Some(req.workspace_id)).await {
          return r;
      }
      let slug = req.slug.trim();
      if slug.is_empty() {
          return err(StatusCode::BAD_REQUEST, "slug is empty");
      }
      // Folder/workspace consistency — the same check update_document (~L655) enforces: a
      // foldered doc and its folder must share a workspace. This is the constraint that today
      // blocks shared-workspace document creation; Phase B satisfies it by creating the folder
      // chain in W first.
      if let Some(fid) = req.folder_id {
          let folder = match c.persistence.get_folder(fid).await {
              Ok(Some(f)) if f.deleted_at.is_none() => f,
              Ok(Some(_)) => return err(StatusCode::CONFLICT, "that folder is in the trash"),
              Ok(None) => return err(StatusCode::NOT_FOUND, "no such folder"),
              Err(e) => return err500(e),
          };
          if folder.workspace_id != Some(req.workspace_id) {
              return err(
                  StatusCode::BAD_REQUEST,
                  "the folder belongs to a different workspace than the document",
              );
          }
      }
      let title = req.title.as_deref().map(str::trim).filter(|s| !s.is_empty());
      let created = match c
          .persistence
          .create_document_in_workspace(slug, req.workspace_id, req.folder_id, title, c.user_or_creator())
          .await
      {
          Ok(d) => d,
          Err(e) if is_slug_conflict(&e) => {
              return err(StatusCode::CONFLICT, "that slug already exists in another workspace")
          }
          Err(e) => return err500(e),
      };
      audit::record(
          &c.persistence,
          AuditEvent::new("document_created")
              .workspace(Some(created.workspace_id))
              .document(Some(created.id))
              .actor(c.user)
              .detail(json!({
                  "slug": slug,
                  "folder_id": created.folder_id,
                  "title": title,
                  "created": created.created,
              })),
      );
      // Reuse the Plan-4 DocCreated emission pattern (restore_document ~L792): same fields,
      // same origin echo-guard so the originating daemon ignores its own event.
      state.workspace_events.publish(
          created.workspace_id,
          WorkspaceEventEnvelope {
              origin: origin_of(&headers),
              event: WorkspaceEvent::DocCreated {
                  slug: slug.to_string(),
                  folder_id: created.folder_id.map(|f| f.to_string()),
                  title: title.map(str::to_string),
              },
          },
      );
      (
          StatusCode::CREATED,
          Json(json!({
              "document_id": created.id,
              "slug": slug,
              "workspace_id": created.workspace_id,
              "folder_id": created.folder_id,
          })),
      )
          .into_response()
  }
  ```
  **`c.user_or_creator()` owner argument:** `create_document_in_workspace`'s `owner` is the
  document owner/ACL grantee. In OIDC mode this is `c.user` (`Some(uuid)`); in open mode there
  is no user. Add a small method on `Ctx` to supply it, mirroring how open-mode rows are
  ownerless elsewhere:
  ```rust
  impl Ctx {
      /// The owner/creator uuid for a created document: the authenticated user in OIDC mode.
      /// In open mode there is no user — fall back to the nil uuid so the ACL grant is inert
      /// (open mode never reads document_acl; resolve_access allows everything).
      fn user_or_creator(&self) -> Uuid {
          self.user.unwrap_or(Uuid::nil())
      }
  }
  ```
  > Add `c.user_or_creator()` exactly as the `owner` arg in the call above. (Open mode never
  > consults `document_acl`, so a nil-uuid ACL row is harmless; the brief's owner-grant is for
  > the OIDC path where `c.user` is real.)

- [ ] **Step 6: Wire the route in `main.rs`.**
  Change (~L218):
  ```rust
          .route("/api/documents", get(workspace::list_documents))
  ```
  to:
  ```rust
          .route(
              "/api/documents",
              get(workspace::list_documents).post(folders::create_document),
          )
  ```

- [ ] **Step 7: Build + clippy + full suite.**
  ```
  cargo clippy -p muesli-server --tests
  cargo test -p muesli-server
  ```
  Expected: clippy `Finished` with no warnings; `slug_conflict_sentinel_maps_to_409` and the
  existing folders/workspace pure tests pass (`test result: ok`).

- [ ] **Step 8: Live-verify the full matrix (no pg test harness).**
  Against a running OIDC-mode server, a signed-in session, and a workspace `W` the user is a
  member of:
  ```
  # root-level create → 201
  curl -i -X POST $BASE/api/documents -H 'content-type: application/json' -H "cookie: $SESSION" \
       -d "{\"workspace_id\":\"$W\",\"slug\":\"notes-1\",\"title\":\"Notes 1\"}"
  # idempotent re-POST same slug+workspace → 201, created:false path (still 201)
  curl -i -X POST $BASE/api/documents -H 'content-type: application/json' -H "cookie: $SESSION" \
       -d "{\"workspace_id\":\"$W\",\"slug\":\"notes-1\",\"title\":\"Notes 1\"}"
  # same slug, a DIFFERENT workspace W2 → 409
  curl -i -X POST $BASE/api/documents -H 'content-type: application/json' -H "cookie: $SESSION" \
       -d "{\"workspace_id\":\"$W2\",\"slug\":\"notes-1\"}"
  # folder_id from another workspace → 400
  # non-member of W → 403 ; open mode (no OIDC) → allowed (200/201)
  ```
  Expected: first → `201 {"document_id":...,"workspace_id":"<W>","folder_id":null}`; second →
  `201` (idempotent); cross-workspace slug → `409 that slug already exists in another
  workspace`; cross-workspace folder → `400 the folder belongs to a different workspace than the
  document`; non-member → `403 you are not a member of this workspace`. Confirm a
  `WorkspaceEvent::DocCreated` lands on `W`'s SSE stream (`/api/workspaces/{W}/events`) with the
  `x-muesli-client-id` echoed in `origin` when the POST carries that header.

- [ ] **Step 9: Commit.**
  ```
  git add crates/muesli-server/src/folders.rs crates/muesli-server/src/main.rs
  git commit -m "server(plan5): POST /api/documents create-in-workspace handler + route

  Add folders::create_document: births a doc DIRECTLY in a target workspace (purely
  structural — never accepts text). Auth mirrors create_folder (open mode allowed;
  OIDC Editor + membership in workspace_id). Enforces the update_document
  folder/workspace consistency check (404 missing / 409 trashed / 400 cross-workspace
  folder), maps the slug_in_other_workspace sentinel to 409, records a document_created
  audit entry, and publishes WorkspaceEvent::DocCreated with origin_of(&headers) reusing
  the Plan-4 restore_document pattern. Responds 201 { document_id, slug, workspace_id,
  folder_id }. Route /api/documents gains .post(). Pure is_slug_conflict unit test."
  ```

---

## Phase A — verification checklist (Global Constraints)

- One-replica-per-doc: `create_document` and `create_document_in_workspace` bind ONLY
  slug/workspace_id/folder_id/title — confirm no `text`/`content`/`body` field on
  `CreateDocumentReq` and no CRDT write. ✓ (by construction above)
- `daemon.status` / poll regressions are not in Phase A scope (server only) — no status field
  is touched here.
- No local-file/registry deletion in Phase A (that is Phase C's `delete_workspace`).
- Commits carry NO `Co-Authored-By` trailer (verify each `git log -1` before handoff).
- After all three commits: `cargo test -p muesli-server` and `cargo clippy -p muesli-server
  --tests` both clean. Phase B then imports these endpoints; Phase C builds against this
  committed tree.

---

# Plan 5 — Phase B (daemon, muesli-cli)

> Repo: `/Users/julianbeaulieu/Code/muesli`, branch `feat/cli-list-workspaces`.
> Build/test: plain `cargo` — `cargo test -p muesli-cli`, `cargo clippy -p muesli-cli --tests`.
> Branches stay UNMERGED (Julian merges). Commit messages carry **NO** `Co-Authored-By` trailer.
>
> Phase B imports Phase A's two new endpoints (`POST /api/workspaces`, `POST /api/documents`)
> and exposes them to the daemon. B1 adds the two `api` helpers; B2 wires them into
> `on_new_file` so a brand-new doc is *born in the target workspace W* before the room
> connects — closing the gap where `resolve_access` would otherwise create the doc in the
> creator's personal workspace.

---

## Task 4 — (B1) api::create_workspace + api::create_document helpers

Add two outbound HTTP helpers to `muesli-cli`'s `api.rs`, mirroring the existing
`create_folder` / `place_document` structure exactly: a fresh `reqwest::Client`, the
`auth(req, token)` bearer wrapper, the `x-muesli-client-id` echo-guard header on
`create_document`, and `bail!`-on-non-success error handling. `create_document` treats
HTTP **409** as a non-fatal idempotent success (the doc already exists in W — a retry).

**Files:**
- Modify `crates/muesli-cli/src/api.rs`
  - add `create_document_body(...)` pure helper next to `create_folder_body` (~L245-251)
  - add `pub async fn create_workspace(...)` and `pub async fn create_document(...)` next to
    `create_folder` / `place_document` (~L255-293)
  - extend `mod outbound_tests` (~L451-465) with body-construction unit tests

**Interfaces:**
- Consumes (Phase A, already live on this branch): `POST {http_base}/api/workspaces`
  body `{ "name": name }` → `201` `WorkspaceInfo`-shaped JSON `{ id, name, role, is_personal }`;
  `POST {http_base}/api/documents` body `{ workspace_id, slug, folder_id, title }` →
  `201 { document_id, slug, workspace_id, folder_id }`, `409` on slug-in-other-workspace.
- Consumes (existing in this file): `fn auth(req, token) -> RequestBuilder`,
  `fn http_base(server) -> String`, `pub struct WorkspaceInfo { id, name, role, is_personal }`.
- Produces:
  - `pub(crate) fn create_document_body(workspace_id: &str, slug: &str, folder_id: Option<&str>, title: Option<&str>) -> serde_json::Value`
  - `pub async fn create_workspace(server: &str, token: Option<&str>, name: &str) -> Result<WorkspaceInfo>`
  - `pub async fn create_document(server: &str, token: Option<&str>, client_id: &str, workspace_id: &str, slug: &str, folder_id: Option<&str>, title: Option<&str>) -> Result<()>`

> **Test idiom (matches the crate, do NOT invent a mock harness).** `api.rs` has **no**
> HTTP mock harness today — every reqwest helper (`create_folder`, `place_document`,
> `trash_document`, …) is exercised only against a live server; the unit tests
> (`outbound_tests`, `plan2_tests`, `sse_tests`) cover **pure** pieces only: request-body
> JSON construction (`create_folder_body`) and response parsing (`parse_sse_chunk`,
> `WorkspacesEnvelope`). We follow that exactly: factor the `create_document` request body
> into a pure `create_document_body(...)` and unit-test it. `create_workspace`'s body is the
> trivial `{ "name": name }` and its **response** parse is already covered by
> `workspace_list_tests::parses_workspaces_envelope` (same `WorkspaceInfo`), so we add a
> tiny parse assertion rather than a fake body helper. The network round-trips themselves are
> covered by Phase B2's behavior + live verification — no new mock infrastructure.

- [ ] **Step 1: Failing test — `create_document_body` shape.**
  Add to `mod outbound_tests` in `crates/muesli-cli/src/api.rs`:
  ```rust
      use super::create_document_body;

      #[test]
      fn create_document_body_carries_workspace_folder_and_title() {
          // foldered doc in W
          let b = create_document_body("ws-7", "my-note", Some("f-3"), Some("My Note"));
          assert_eq!(b["workspace_id"], "ws-7");
          assert_eq!(b["slug"], "my-note");
          assert_eq!(b["folder_id"], "f-3");
          assert_eq!(b["title"], "My Note");

          // root-level doc: folder_id null but workspace_id + slug still present (the gap we close)
          let b2 = create_document_body("ws-7", "root-doc", None, None);
          assert_eq!(b2["workspace_id"], "ws-7");
          assert_eq!(b2["slug"], "root-doc");
          assert!(b2["folder_id"].is_null());
          assert!(b2["title"].is_null());
      }
  ```
  Also extend the existing `workspace_list_tests` (single-item parse, reusing `WorkspaceInfo`
  so the `create_workspace` 201 contract is asserted):
  ```rust
      #[test]
      fn parses_single_created_workspace() {
          use super::WorkspaceInfo;
          let info: WorkspaceInfo = serde_json::from_str(
              r#"{"id":"w9","name":"Team B","role":"admin","is_personal":false}"#,
          )
          .unwrap();
          assert_eq!(info.id, "w9");
          assert_eq!(info.role, "admin");
          assert!(!info.is_personal);
      }
  ```

- [ ] **Step 2: Run — fails (no such function).**
  ```
  cargo test -p muesli-cli create_document_body
  ```
  Expected: `error[E0432]: unresolved import super::create_document_body` /
  `cannot find function create_document_body` — the helper does not exist yet.

- [ ] **Step 3: Implement the body helper + both async helpers.**
  In `crates/muesli-cli/src/api.rs`, directly **after** `create_folder` (which ends ~L272)
  and the existing `create_folder_body` (~L244-251), add:
  ```rust
  /// JSON body for `POST /api/documents` (factored out so the workspace/folder wiring is
  /// unit-tested without a live server, exactly like `create_folder_body`).
  pub(crate) fn create_document_body(
      workspace_id: &str,
      slug: &str,
      folder_id: Option<&str>,
      title: Option<&str>,
  ) -> serde_json::Value {
      json!({
          "workspace_id": workspace_id,
          "slug": slug,
          "folder_id": folder_id,
          "title": title,
      })
  }

  /// Create an empty server workspace named `name` and return its `WorkspaceInfo`.
  /// `POST /api/workspaces` → 201 `{ id, name, role, is_personal }`.
  pub async fn create_workspace(
      server: &str,
      token: Option<&str>,
      name: &str,
  ) -> Result<WorkspaceInfo> {
      let req = reqwest::Client::new()
          .post(format!("{}/api/workspaces", http_base(server)))
          .json(&json!({ "name": name }));
      let res = auth(req, token).send().await?;
      if !res.status().is_success() {
          bail!(
              "create workspace failed ({}): {}",
              res.status(),
              res.text().await.unwrap_or_default()
          );
      }
      res.json::<WorkspaceInfo>().await.context("parsing created workspace")
  }

  /// Birth a document directly in `workspace_id` (structural row only — NO text; the daemon's
  /// CRDT replica owns content). `folder_id` None = workspace root. Tags the request with
  /// `client_id` for the echo guard, exactly like `create_folder`. HTTP 409 (the slug already
  /// exists in this workspace) is treated as idempotent success — a retry after the doc was
  /// already born in W.
  pub async fn create_document(
      server: &str,
      token: Option<&str>,
      client_id: &str,
      workspace_id: &str,
      slug: &str,
      folder_id: Option<&str>,
      title: Option<&str>,
  ) -> Result<()> {
      let req = reqwest::Client::new()
          .post(format!("{}/api/documents", http_base(server)))
          .header("x-muesli-client-id", client_id)
          .json(&create_document_body(workspace_id, slug, folder_id, title));
      let res = auth(req, token).send().await?;
      if res.status() == reqwest::StatusCode::CONFLICT {
          debug!(%slug, %workspace_id, "create_document: 409 — doc already exists in workspace (idempotent)");
          return Ok(());
      }
      if !res.status().is_success() {
          bail!(
              "create document failed ({}): {}",
              res.status(),
              res.text().await.unwrap_or_default()
          );
      }
      Ok(())
  }
  ```
  Then add the `debug` import. `api.rs` currently imports only `use tracing::warn;` (L9);
  change it to:
  ```rust
  use tracing::{debug, warn};
  ```

- [ ] **Step 4: Run — passes.**
  ```
  cargo test -p muesli-cli create_document_body parses_single_created_workspace
  cargo clippy -p muesli-cli --tests
  ```
  Expected: both unit tests pass; clippy clean (no warnings). `create_workspace` /
  `create_document` compile but have no unit test of their own — by design (no mock
  harness in this crate); they are exercised by Task 5's `decide_create_document`
  decision logic + live verification.

- [ ] **Step 5: Commit.**
  ```
  git add crates/muesli-cli/src/api.rs
  git commit -m "cli/api: create_workspace + create_document helpers

  Add the two outbound helpers Phase B2 needs to birth a workspace and a
  document via REST. create_document mirrors create_folder (client_id echo
  header, bail on non-success) and treats HTTP 409 as idempotent success.
  Request body factored into create_document_body for a pure unit test,
  matching the existing create_folder_body idiom; no HTTP mock harness is
  introduced (none exists in this crate)."
  ```

---

## Task 5 — (B2) on_new_file births new docs in the target workspace

Rework `SyncDaemon::on_new_file` so that **in workspace mode** the brand-new-doc arm (the
`None =>` branch) births the doc in workspace `W` via `api::create_document` *before*
`spawn_file` opens the room. This makes the doc exist server-side when the daemon connects
to `/ws/{slug}`, so `resolve_access` finds the **existing** doc (`Some(doc)` branch) and
opens it — instead of lazily creating one in the creator's **personal** workspace.
Root-level files (`folder_id == None`) **must still** POST `create_document`; that root case
is exactly the gap this closes. Non-workspace mode (`muesli open`, `workspace_id == None`)
keeps the current lazy behavior unchanged.

The re-link arm (`Some(link)`), the rename/rebind arm (`rebind_candidate`), and the
`last_synced`-gated `place_document` block are **UNCHANGED** — those docs already exist
server-side.

> **KNOWN DEFERRAL (note, do not fix in this task):** `resolve_folder_chain` re-lists folders
> via `api::list_docs_and_folders` on *every* call, so a bulk promote of N files makes ~N
> folder-list round-trips. Correct but not optimal; a future pass can cache the folder map
> across `on_new_file` calls. Acceptable for v1 — promote is a one-time operation and files
> settle progressively.

**Files:**
- Modify `crates/muesli-cli/src/sync.rs`
  - add pure helper `fn should_create_remote_doc(...)` near `place_item` (~L808-836)
  - rework `async fn on_new_file(&mut self, path: PathBuf)` (L515-586) — split the slug
    decision so the `None =>` (new-doc) arm carries an `is_new` flag, then add the
    workspace-mode `create_document` block before `spawn_file`
  - extend `mod tests` (~L1184) with a decision unit test
- (No changes to `resolve_folder_chain` (~L588-632), `spawn_file`, `place_item`,
  `store::record_link`.)

**Interfaces:**
- Consumes: `api::create_document(server, token, client_id, workspace_id, slug, folder_id, title)`
  (Task 4); `SyncDaemon::resolve_folder_chain(&self, &PlaceItem) -> Option<String>` (existing);
  `place_item(&self.dir, &path, &doc) -> PlaceItem`; `store::record_link(&path, &doc, &self.server, self.workspace_id.as_deref())`;
  fields `self.workspace_id: Option<String>`, `self.token: Option<String>`,
  `self.client_id: String`, `self.server: String`.
- Produces:
  - `fn should_create_remote_doc(workspace_mode: bool, is_new_link: bool) -> bool`
    (pure: `workspace_mode && is_new_link`).
  - Reworked `on_new_file` behavior: in workspace mode, a fresh link triggers exactly one
    `api::create_document` (folder chain resolved first) before the room connect; every other
    arm is byte-for-byte the prior behavior.

> **Test idiom (matches sync.rs).** `mod tests` (L1184) exercises **pure** decision/translation
> helpers only — `reconcile_actions`, `desired_rel_path`, `unique_slug`, `rebind_candidate` —
> with plain `#[test]` and synthetic inputs; the async daemon path (`on_new_file`,
> `resolve_folder_chain`) has no test harness (it needs a live server + filesystem watcher).
> So we make the *new decision* unit-testable by extracting it into the pure
> `should_create_remote_doc(workspace_mode, is_new_link)` predicate and table-test every
> quadrant. The ordering/wiring (resolve chain → create_document → record_link → spawn_file,
> and "root-level still POSTs") is asserted structurally in the code and covered by live
> verification in Phase C; we do not fake the network in sync.rs.

- [ ] **Step 1: Failing test — the create-decision predicate.**
  Add to `mod tests` in `crates/muesli-cli/src/sync.rs`:
  ```rust
      #[test]
      fn create_remote_doc_only_for_new_links_in_workspace_mode() {
          // workspace mode + a brand-new link → birth the doc in W (root or foldered alike)
          assert!(should_create_remote_doc(true, true));
          // workspace mode but a re-link / rename → the doc already exists server-side
          assert!(!should_create_remote_doc(true, false));
          // non-workspace mode (plain `muesli open`) → never create; the room does it lazily
          assert!(!should_create_remote_doc(false, true));
          assert!(!should_create_remote_doc(false, false));
      }
  ```

- [ ] **Step 2: Run — fails (no such function).**
  ```
  cargo test -p muesli-cli create_remote_doc_only_for_new_links_in_workspace_mode
  ```
  Expected: `cannot find function should_create_remote_doc in this scope` — not defined yet.

- [ ] **Step 3: Implement the pure predicate.**
  In `crates/muesli-cli/src/sync.rs`, add directly **above** `fn place_item` (~L818):
  ```rust
  /// Decide whether `on_new_file` should birth the doc in the target workspace via
  /// `api::create_document` BEFORE connecting the room. True only when (a) we run in
  /// workspace mode (a `workspace_id` + token are set) and (b) this is a brand-NEW link
  /// (not a re-link or a rename/rebind — those docs already exist server-side). Root-level
  /// files (folder_id None) are NOT special-cased here: a new root file in workspace mode
  /// still returns true, which is the gap this closes.
  fn should_create_remote_doc(workspace_mode: bool, is_new_link: bool) -> bool {
      workspace_mode && is_new_link
  }
  ```

- [ ] **Step 4: Run — predicate passes.**
  ```
  cargo test -p muesli-cli create_remote_doc_only_for_new_links_in_workspace_mode
  ```
  Expected: 1 passed.

- [ ] **Step 5: Rework `on_new_file` to use the predicate.**
  Replace the entire `on_new_file` body (L515-586) with the version below. The change vs.
  the original: the slug-resolution match now yields `(doc, is_new)` so the new-doc arm is
  distinguishable from the re-link/rename arms; then a workspace-mode block resolves the
  folder chain and calls `api::create_document` (root `folder_id == None` included) *before*
  `spawn_file`. The `last_synced`-gated `place_document` block and every other arm are
  unchanged.
  ```rust
      /// New `.md` in the tree: re-use an exact index entry, else apply the ADR 0009 rename
      /// re-bind rule (content hash vs known replica texts), else mint a fresh slug. In
      /// workspace mode a brand-new doc is BORN in the target workspace via REST before the
      /// room connect, so `resolve_access` opens the existing doc rather than creating one in
      /// the creator's personal workspace (root-level files included).
      async fn on_new_file(&mut self, path: PathBuf) {
          tokio::time::sleep(Duration::from_millis(100)).await; // settle (create + write bursts)
          if !path.is_file() || self.handles.contains_key(&path) {
              return;
          }
          let Ok(bytes) = std::fs::read(&path) else { return };
          let Ok(text) = String::from_utf8(bytes) else {
              warn!(file = %path.display(), "new file is not valid UTF-8 — not linking");
              return;
          };
          let label = rel_label(&self.dir, &path);
          let server_base = store::http_base(&self.server);
          let links = store::load_links();

          // Resolve the doc slug AND whether this is a brand-new link (vs. re-link / rename).
          // Only a brand-new link in workspace mode needs the doc birthed server-side.
          let (doc, is_new) = if let Some(link) = links.iter().find(|l| l.file == path) {
              // The exact path was linked before (e.g. deleted then restored).
              println!("+ file re-linked: {label} → #{}", link.doc);
              (link.doc.clone(), false)
          } else {
              let candidates: Vec<(String, bool, Option<u64>)> = links
                  .iter()
                  .filter(|l| l.server == server_base)
                  .map(|l| (l.doc.clone(), l.file.is_file(), self.shared.hash_of(&l.doc)))
                  .collect();
              match rebind_candidate(text_hash(&text), &candidates) {
                  Some(doc) => {
                      // Rename: same content, old path gone → same Document identity. Retire any
                      // handle still parked at the old path so we don't keep two sessions for one doc.
                      if let Some(old) = self.doc_index.path_of(&doc).cloned() {
                          if old != path {
                              if let Some(h) = self.handles.remove(&old) {
                                  let _ = h.stop_tx.send(Stop::Drop);
                              }
                              self.doc_index.rebind(&doc, &old, path.clone());
                          }
                      }
                      if let Err(e) = store::rebind_link(&doc, &self.server, &path) {
                          warn!(%e, "could not re-bind the renamed file in the index");
                      }
                      println!("↻ re-linked (rename): {label} → #{doc}");
                      (doc, false)
                  }
                  None => {
                      let rel = path.strip_prefix(&self.dir).expect("candidate is under dir");
                      let taken = links.iter().map(|l| l.doc.clone()).collect();
                      let doc = unique_slug(&slug_from_rel_path(rel, self.prefix.as_deref()), &taken);
                      if let Err(e) = store::record_link(&path, &doc, &self.server, self.workspace_id.as_deref()) {
                          warn!(%e, "could not record the new link in the index");
                      }
                      println!("+ new file linked: {label} → #{doc}");
                      (doc, true)
                  }
              }
          };

          let item = place_item(&self.dir, &path, &doc);
          self.places.lock().unwrap().push(item.clone());

          // WORKSPACE MODE: birth a brand-new doc in the target workspace W BEFORE connecting
          // the room. Resolve (creating if needed) the folder chain first, then POST
          // /api/documents so the server row exists in W; resolve_access then OPENS this doc
          // (the Some(doc) branch) instead of lazily minting one in the personal workspace.
          // Root-level files (folder_id None) MUST still POST — that's the gap being closed.
          // NOTE (known deferral): resolve_folder_chain re-lists folders per call, so a bulk
          // promote of N files makes ~N list round-trips. Acceptable for v1 (promote is
          // one-time; files settle progressively); a future pass can cache the folder map.
          let workspace_mode = self.workspace_id.is_some() && self.token.is_some();
          if should_create_remote_doc(workspace_mode, is_new) {
              let workspace_id = self.workspace_id.clone().expect("workspace_mode ⇒ Some");
              let folder_id = self.resolve_folder_chain(&item).await;
              if let Err(e) = api::create_document(
                  &self.server,
                  self.token.as_deref(),
                  &self.client_id,
                  &workspace_id,
                  &item.slug,
                  folder_id.as_deref(),
                  Some(&item.title),
              )
              .await
              {
                  warn!(%e, slug = %item.slug, "birthing new doc in workspace failed — \
                        room connect may fall back to the personal workspace");
              }
          }

          // Outbound placement of a rename/move: PATCH title+folder to match the new path. Only
          // for docs already pushed to the server (a fresh local is placed by the reconcile_loop
          // after its first push). Same conservative `last_synced` proxy as the trash guard.
          if store::find_link(&path).map(|l| l.last_synced.is_some()).unwrap_or(false) {
              let (server, token, client_id) =
                  (self.server.clone(), self.token.clone(), self.client_id.clone());
              let folder_parent = self.resolve_folder_chain(&item).await;
              let (slug, title) = (item.slug.clone(), item.title.clone());
              if let Err(e) =
                  api::place_document(&server, token.as_deref(), &client_id, &slug, folder_parent.as_deref(), &title).await
              {
                  warn!(%e, %slug, "outbound place (rename) failed");
              }
          }
          self.spawn_file(path, doc);
      }
  ```
  Notes on equivalence to the original:
  - The re-link arm and rename arm now return `(_, false)`; the new-doc arm returns
    `(_, true)`. No other logic in those arms changed.
  - The new `create_document` block sits *between* the `places` push and the
    `last_synced` `place_document` block, and *before* `spawn_file` (the room connect) — the
    required ordering.
  - On a brand-new local file `find_link(&path).last_synced` is `None`, so the rename
    `place_document` block does not fire for it; placement of nested new docs continues to be
    driven by `reconcile_loop` (unchanged). The folder chain we resolve for `create_document`
    is the same call `reconcile_loop`/the rename block use, so behavior is consistent.

- [ ] **Step 6: Run — full crate suite + clippy.**
  ```
  cargo test -p muesli-cli
  cargo clippy -p muesli-cli --tests
  ```
  Expected: all existing tests still pass (the rework is behavior-preserving for re-link,
  rename, and non-workspace-mode paths), the new
  `create_remote_doc_only_for_new_links_in_workspace_mode` passes, and clippy is clean.

- [ ] **Step 7: Commit.**
  ```
  git add crates/muesli-cli/src/sync.rs
  git commit -m "cli/sync: birth new docs in the target workspace (on_new_file)

  In workspace mode, a brand-new link now POSTs /api/documents to birth the
  doc in W (folder chain resolved first; root-level files included) BEFORE the
  room connect, so resolve_access opens the existing doc instead of lazily
  creating one in the personal workspace. Non-workspace mode keeps the lazy
  path; the re-link, rename/rebind, and last_synced place_document arms are
  unchanged. The create decision is the pure should_create_remote_doc predicate
  (unit-tested). Known deferral noted: resolve_folder_chain re-lists per call."
  ```

---

# Plan 5 — Phase C (client, demo_muesli)

These tasks run on **demo_muesli**, branch `feat/auth-remote-workspaces`, and depend on
Phases A+B being **committed** in the live muesli working tree (path deps
`../../muesli/crates/muesli-{core,cli}`). Phase C never touches the muesli tree.

**Inherited global constraints (from the locked brief):**
- Branch stays UNMERGED — Julian merges. **Commit messages carry NO `Co-Authored-By` trailer.**
- One-replica-per-doc is sacred: nothing here pushes document text. The new commands only mutate
  the local SQLite registry and call B's structural `api` helpers.
- Data-loss safety: promote deletes a REGISTRY ROW (SQLite), never a disk file.
- Do not regress Plan 3's flicker fix / Plan 4's poll retirement. The picker actions reuse
  `openFolderWithSync` (the single daemon-start point) and must not add any recurring
  `daemon.status` reassignment or status poll.

**Build/test commands (use these exact forms):**
- `src-tauri` Rust:
  `DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx cargo test --manifest-path src-tauri/Cargo.toml`
  (clippy: append `clippy --manifest-path src-tauri/Cargo.toml --tests` in place of `test`).
- Frontend type-check: `pnpm check` (expect `0 errors and 0 warnings`).
- Frontend tests: `pnpm test` (`vitest run`; node environment, `include: src/**/*.test.ts`).

**Environment findings (load-bearing for these tasks):**
- The vitest `test.environment` is **`node`**, and `include` is `src/**/*.test.ts` only.
  There is **no jsdom/`@testing-library/svelte`** harness, so `.svelte` *components* are NOT
  mountable in tests. → Task 7 (store) is unit-testable by mocking `$lib/*`; Task 8 (the
  `.svelte` component) is **not** vitest-testable here and ships with a precise manual step.
- **No `motion`/`framer-motion`** in `package.json`. The make-interfaces-feel-better polish in
  Task 8 is therefore done with **plain CSS** (`active:scale-[0.96] transition-transform`), no
  animation library — matching how the rest of the picker is styled (Tailwind/daisyUI utilities).
- Existing `.svelte.ts` runes stores ARE testable in node vitest (see `tabs.test.ts` importing
  `tabs.svelte.ts`), so Task 7's store test is in-harness.

---

## Task 6 — (C1) workspace_index::delete_workspace + create_remote/promote Tauri commands

**Files:**
- Modify `src-tauri/src/workspace_index/mod.rs` — add `delete_workspace` accessor after
  `find_by_id` (~L86); add an in-memory-DB unit test in the existing `#[cfg(test)] mod tests`
  block (~L88-131).
- Modify `src-tauri/src/workspaces_cmd.rs` — add a private pure helper `promote_in_index` + two
  `#[tauri::command]`s (`create_remote_workspace`, `promote_workspace`) after
  `register_cloned_workspace` (~L127); add a registry-transition unit test to the existing
  `#[cfg(test)] mod tests` block (~L129-163).
- Modify `src-tauri/src/lib.rs` — register both commands in `tauri::generate_handler!` (~L65-68).

**Interfaces:**
- Produces `pub fn delete_workspace(conn: &Connection, id: &str) -> rusqlite::Result<()>`.
- Produces `fn promote_in_index(conn: &Connection, old_id: &str, rec: &WorkspaceRecord) -> rusqlite::Result<()>`
  (pure registry mutation: `delete_workspace(old)` then `upsert_workspace(rec)`; no network).
- Produces `#[tauri::command] async fn create_remote_workspace(server: String, name: String) -> Result<muesli_cli::api::WorkspaceInfo, String>`.
- Produces `#[tauri::command] async fn promote_workspace(old_id: String, server: String, name: String, path: String) -> Result<String, String>`.
- Consumes `muesli_cli::store::load_token(server: &str) -> Option<String>`,
  `muesli_cli::api::create_workspace(server: &str, token: Option<&str>, name: &str) -> Result<WorkspaceInfo>`
  (Phase B B1), `idx::{open_index, upsert_workspace, delete_workspace}`, the existing
  `workspaces_cmd::open()` connection helper, and `WorkspaceRecord`.

### Steps

- [ ] **Step 1: Write a failing in-memory-DB test for `delete_workspace`.**
  In `src-tauri/src/workspace_index/mod.rs`, inside `#[cfg(test)] mod tests`, add (after
  `upsert_updates_existing_row`):

  ```rust
      #[test]
      fn delete_removes_row() {
          let conn = mem();
          let rec = WorkspaceRecord {
              id: "w1".into(),
              server: None,
              name: "Notes".into(),
              local_path: Some("/Users/me/Notes".into()),
              local_only: true,
          };
          upsert_workspace(&conn, &rec).unwrap();
          assert_eq!(find_by_id(&conn, "w1").unwrap(), Some(rec));
          delete_workspace(&conn, "w1").unwrap();
          assert_eq!(find_by_id(&conn, "w1").unwrap(), None);
          // Deleting a non-existent row is a no-op, not an error.
          delete_workspace(&conn, "missing").unwrap();
      }
  ```

- [ ] **Step 2: Run — fails to compile (no `delete_workspace`).**
  `DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx cargo test --manifest-path src-tauri/Cargo.toml workspace_index`
  Expected: `error[E0425]: cannot find function `delete_workspace` in this scope`.

- [ ] **Step 3: Implement `delete_workspace`.**
  In `src-tauri/src/workspace_index/mod.rs`, after `find_by_id` (~L86), add:

  ```rust
  pub fn delete_workspace(conn: &Connection, id: &str) -> Result<()> {
      conn.execute(
          "DELETE FROM workspaces WHERE id = ?1;",
          rusqlite::params![id],
      )?;
      Ok(())
  }
  ```

- [ ] **Step 4: Run — passes.**
  `DYLD_LIBRARY_PATH=… cargo test --manifest-path src-tauri/Cargo.toml workspace_index`
  Expected: `test result: ok.` including `delete_removes_row`.

- [ ] **Step 5: Commit.**
  `git add src-tauri/src/workspace_index/mod.rs && git commit -m "demo_muesli: add workspace_index::delete_workspace accessor"`

- [ ] **Step 6: Write a failing registry-transition test for promote.**
  In `src-tauri/src/workspaces_cmd.rs`, inside `#[cfg(test)] mod tests`, add a test that exercises
  the **pure** registry mutation (no network), mirroring the in-memory-DB idiom from
  `workspace_index`:

  ```rust
      #[test]
      fn promote_in_index_swaps_local_only_for_cloned_row() {
          let conn = rusqlite::Connection::open_in_memory().unwrap();
          conn.execute_batch(
              "CREATE TABLE workspaces (id TEXT PRIMARY KEY, server TEXT, name TEXT NOT NULL,
               local_path TEXT, local_only INTEGER NOT NULL DEFAULT 0);",
          )
          .unwrap();
          // A pre-existing local-only row keyed by its path (id == path).
          idx::upsert_workspace(
              &conn,
              &WorkspaceRecord {
                  id: "/Users/me/Notes".into(),
                  server: None,
                  name: "Notes".into(),
                  local_path: Some("/Users/me/Notes".into()),
                  local_only: true,
              },
          )
          .unwrap();

          // Promote: delete the stale id=path row, insert the server-id'd cloned row.
          let new_rec = WorkspaceRecord {
              id: "srv-w-42".into(),
              server: Some("ws://localhost:8787/ws".into()),
              name: "Notes".into(),
              local_path: Some("/Users/me/Notes".into()),
              local_only: false,
          };
          promote_in_index(&conn, "/Users/me/Notes", &new_rec).unwrap();

          // The phantom local-only row is gone; the cloned row is present.
          assert_eq!(idx::find_by_id(&conn, "/Users/me/Notes").unwrap(), None);
          assert_eq!(idx::find_by_id(&conn, "srv-w-42").unwrap(), Some(new_rec));
      }
  ```

- [ ] **Step 7: Run — fails to compile (no `promote_in_index`).**
  `DYLD_LIBRARY_PATH=… cargo test --manifest-path src-tauri/Cargo.toml workspaces_cmd`
  Expected: `error[E0425]: cannot find function `promote_in_index``.

- [ ] **Step 8: Implement `promote_in_index` + the two commands.**
  In `src-tauri/src/workspaces_cmd.rs`, after `register_cloned_workspace` (~L127), add:

  ```rust
  /// Pure registry transition for promote: in ONE connection, drop the stale
  /// local-only row (keyed by its path) and upsert the server-id'd cloned row.
  /// Factored out (no network) so the swap is unit-testable.
  fn promote_in_index(
      conn: &rusqlite::Connection,
      old_id: &str,
      rec: &WorkspaceRecord,
  ) -> rusqlite::Result<()> {
      idx::delete_workspace(conn, old_id)?;
      idx::upsert_workspace(conn, rec)?;
      Ok(())
  }

  /// Create an empty server workspace named `name` on `server`. Returns the server's
  /// WorkspaceInfo. Does NOT touch the local registry or any path — the store calls
  /// `register_cloned_workspace` next to record the local clone.
  #[tauri::command]
  pub async fn create_remote_workspace(
      server: String,
      name: String,
  ) -> Result<muesli_cli::api::WorkspaceInfo, String> {
      let token = muesli_cli::store::load_token(&server);
      muesli_cli::api::create_workspace(&server, token.as_deref(), &name)
          .await
          .map_err(|e| format!("{e:#}"))
  }

  /// Promote a LOCAL-ONLY workspace (`old_id`, currently keyed by its folder path) to a
  /// shared one: create a server workspace `W`, then in ONE connection delete the stale
  /// `id=old_id` local-only row and upsert the `id=W` cloned row pointing at `path`.
  /// Returns the new server workspace id `W`. Deletes only a SQLite row (never a file).
  #[tauri::command]
  pub async fn promote_workspace(
      old_id: String,
      server: String,
      name: String,
      path: String,
  ) -> Result<String, String> {
      let token = muesli_cli::store::load_token(&server);
      let info = muesli_cli::api::create_workspace(&server, token.as_deref(), &name)
          .await
          .map_err(|e| format!("{e:#}"))?;
      let conn = open()?;
      promote_in_index(
          &conn,
          &old_id,
          &WorkspaceRecord {
              id: info.id.clone(),
              server: Some(server),
              name,
              local_path: Some(path),
              local_only: false,
          },
      )
      .map_err(|e| e.to_string())?;
      Ok(info.id)
  }
  ```

- [ ] **Step 9: Register both commands in the Tauri handler.**
  In `src-tauri/src/lib.rs`, in the `tauri::generate_handler![…]` list, after
  `workspaces_cmd::register_cloned_workspace,` (~L68) add:

  ```rust
              workspaces_cmd::create_remote_workspace,
              workspaces_cmd::promote_workspace,
  ```

- [ ] **Step 10: Run — passes (test + clippy).**
  `DYLD_LIBRARY_PATH=… cargo test --manifest-path src-tauri/Cargo.toml workspaces_cmd`
  Expected: `test result: ok.` including `promote_in_index_swaps_local_only_for_cloned_row`.
  Then `DYLD_LIBRARY_PATH=… cargo clippy --manifest-path src-tauri/Cargo.toml --tests`
  Expected: no warnings (the new commands compile into the handler).

- [ ] **Step 11: Commit.**
  `git add src-tauri/src/workspaces_cmd.rs src-tauri/src/lib.rs && git commit -m "demo_muesli: add create_remote_workspace + promote_workspace commands"`

---

## Task 7 — (C2) tauri.ts bindings + workspaces store methods

**Files:**
- Modify `src/lib/tauri.ts` — add a `WorkspaceInfo` interface + `createRemoteWorkspace` /
  `promoteWorkspace` invoke bindings near the other workspace bindings (~L106-118).
- Modify `src/lib/workspaces.svelte.ts` — import the two new bindings (~L1-12), add a `busy`
  state field next to `cloning` (~L22), add `createRemoteWorkspace` and `promoteLocalToRemote`
  methods (after `openWorkspaceView`, ~L104).
- Create `src/lib/workspaces.test.ts` — vitest unit test mocking `$lib/*`.

**Interfaces:**
- Produces TS `export interface WorkspaceInfo { id: string; name: string; role: string; is_personal: boolean }`
  (mirrors Rust `muesli_cli::api::WorkspaceInfo`).
- Produces `createRemoteWorkspace(server: string, name: string): Promise<WorkspaceInfo>` →
  `invoke("create_remote_workspace", { server, name })`.
- Produces `promoteWorkspace(oldId: string, server: string, name: string, path: string): Promise<string>` →
  `invoke("promote_workspace", { oldId, server, name, path })`.
- Produces store `workspaces.createRemoteWorkspace(name: string, path: string): Promise<void>` and
  `workspaces.promoteLocalToRemote(view: WorkspaceView): Promise<void>`, plus `workspaces.busy: boolean`.
- Consumes the existing `registerClonedWorkspace`, `openFolderWithSync` (private, the single
  daemon-start point), `refresh`, `activeServer`, `identity`.

### Steps

- [ ] **Step 1: Write a failing store test.**
  Create `src/lib/workspaces.test.ts`. Mock `$lib/tauri` (the binding layer the store calls) plus
  the three store deps the singleton imports, then drive the singleton and assert command order +
  the busy flag + refresh. Mirrors the existing `tabs.test.ts` vitest idiom but adds `vi.mock`:

  ```ts
  import { describe, it, expect, beforeEach, vi } from "vitest";

  // Mock the binding layer: each store method must call exactly these, in order.
  const calls: string[] = [];
  vi.mock("$lib/tauri", () => ({
    createRemoteWorkspace: vi.fn(async (_server: string, name: string) => {
      calls.push("createRemoteWorkspace");
      return { id: "srv-new", name, role: "admin", is_personal: false };
    }),
    promoteWorkspace: vi.fn(async () => {
      calls.push("promoteWorkspace");
      return "srv-promoted";
    }),
    registerClonedWorkspace: vi.fn(async () => {
      calls.push("registerClonedWorkspace");
    }),
    // Pulled in by refresh(); keep them inert so refresh() resolves.
    hasToken: vi.fn(async () => false),
    currentIdentity: vi.fn(async () => null),
    listWorkspacesMerged: vi.fn(async () => {
      calls.push("refresh");
      return [];
    }),
    serverLogin: vi.fn(),
    serverLogout: vi.fn(),
    registerLocalWorkspace: vi.fn(),
    cloneWorkspace: vi.fn(),
  }));

  // openFolderWithSync delegates to these; stub them so no real daemon/tree work runs.
  vi.mock("$lib/workspace.svelte", () => ({
    workspace: { openWorkspace: vi.fn(async () => calls.push("openWorkspace")), root: "" },
  }));
  vi.mock("$lib/sync/daemon.svelte", () => ({
    daemon: {
      start: vi.fn(async () => calls.push("daemon.start")),
      stop: vi.fn(async () => calls.push("daemon.stop")),
    },
  }));
  vi.mock("$lib/settings.svelte", () => ({
    settings: { wsBase: "ws://localhost:8787/ws" },
  }));

  import { workspaces } from "./workspaces.svelte";
  import type { WorkspaceView } from "./tauri";

  beforeEach(() => {
    calls.length = 0;
    workspaces.identity = { server: "ws://localhost:8787/ws", display_name: null, email: null, avatar_url: null, mode: "open" };
    workspaces.busy = false;
    workspaces.error = null;
  });

  describe("workspaces store — Plan 5 promotion", () => {
    it("createRemoteWorkspace: creates remote → registers clone → opens+syncs → refreshes; busy flips", async () => {
      const p = workspaces.createRemoteWorkspace("Notes", "/Users/me/Notes");
      expect(workspaces.busy).toBe(true); // set synchronously before the first await resolves
      await p;
      expect(workspaces.busy).toBe(false);
      expect(calls).toEqual([
        "createRemoteWorkspace",
        "registerClonedWorkspace",
        "openWorkspace",
        "daemon.start",
        "refresh",
      ]);
    });

    it("promoteLocalToRemote: promotes → opens+syncs the SAME path → refreshes", async () => {
      const view: WorkspaceView = {
        id: "/Users/me/Notes",
        server: null,
        name: "Notes",
        local_path: "/Users/me/Notes",
        local_only: true,
        state: "local-only",
      };
      await workspaces.promoteLocalToRemote(view);
      expect(workspaces.busy).toBe(false);
      expect(calls).toEqual(["promoteWorkspace", "openWorkspace", "daemon.start", "refresh"]);
    });

    it("createRemoteWorkspace: no-ops (no commands) when logged out", async () => {
      workspaces.identity = null;
      await workspaces.createRemoteWorkspace("Notes", "/Users/me/Notes");
      expect(calls).toEqual([]);
      expect(workspaces.busy).toBe(false);
    });
  });
  ```

- [ ] **Step 2: Run — fails (bindings + store methods don't exist).**
  `pnpm test`
  Expected: failure — `createRemoteWorkspace is not exported by "$lib/tauri"` (mock factory
  references the real module shape only at type level, but the store import of the missing
  bindings fails to resolve), and `workspaces.createRemoteWorkspace is not a function`.

- [ ] **Step 3: Add the `tauri.ts` bindings.**
  In `src/lib/tauri.ts`, after `registerClonedWorkspace` (~L118), add:

  ```ts
  /** Mirror of Rust `muesli_cli::api::WorkspaceInfo` (the server workspace shape). */
  export interface WorkspaceInfo {
    id: string;
    name: string;
    role: string;
    is_personal: boolean;
  }

  /** Create an empty server workspace named `name` on `server`. */
  export const createRemoteWorkspace = (
    server: string,
    name: string,
  ): Promise<WorkspaceInfo> => invoke("create_remote_workspace", { server, name });

  /**
   * Promote a local-only workspace (`oldId` = its folder path) to a shared one on `server`:
   * creates the server workspace, swaps the registry row, returns the new server workspace id.
   */
  export const promoteWorkspace = (
    oldId: string,
    server: string,
    name: string,
    path: string,
  ): Promise<string> =>
    invoke("promote_workspace", { oldId, server, name, path });
  ```

- [ ] **Step 4: Add the store methods + busy flag.**
  In `src/lib/workspaces.svelte.ts`, extend the imports (~L1-12) to add the two bindings:

  ```ts
    createRemoteWorkspace as createRemoteWorkspaceCmd,
    promoteWorkspace as promoteWorkspaceCmd,
  ```

  (Place them inside the existing `from "$lib/tauri"` import block, alongside `cloneWorkspace`.)
  Add the busy field next to `cloning` (~L22):

  ```ts
    busy = $state(false);
  ```

  Add the two methods after `openWorkspaceView` (~L104), before `openByPath`:

  ```ts
    /**
     * Create an empty server workspace `name`, register it as cloned to `path`, then open the
     * folder and start the Tier-1 daemon (going live). Gated on a logged-in active server.
     * `busy` flips around the whole op so the picker can disable/spin (mirrors `cloning`).
     */
    async createRemoteWorkspace(name: string, path: string): Promise<void> {
      if (!this.identity || !this.activeServer) return;
      this.error = null;
      this.busy = true;
      try {
        const info = await createRemoteWorkspaceCmd(this.activeServer, name);
        await registerClonedWorkspace(info.id, this.activeServer, name, path);
        await this.openFolderWithSync(path, this.activeServer, info.id);
        await this.refresh();
      } catch (e) {
        this.error = String(e);
      } finally {
        this.busy = false;
      }
    }

    /**
     * Promote a LOCAL-ONLY workspace to a shared one: create the server workspace, swap the
     * registry row (local-only id=path → cloned id=W), then open the SAME folder and go live.
     * Requires a logged-in active server and a local path. Reuses the `busy` flag.
     */
    async promoteLocalToRemote(view: WorkspaceView): Promise<void> {
      if (!this.identity || !this.activeServer || !view.local_path) return;
      this.error = null;
      this.busy = true;
      try {
        const id = await promoteWorkspaceCmd(
          view.id,
          this.activeServer,
          view.name,
          view.local_path,
        );
        await this.openFolderWithSync(view.local_path, this.activeServer, id);
        await this.refresh();
      } catch (e) {
        this.error = String(e);
      } finally {
        this.busy = false;
      }
    }
  ```

- [ ] **Step 5: Run — passes.**
  `pnpm test`
  Expected: `workspaces.test.ts` 3 tests pass; existing tests still green. Then `pnpm check`
  → `0 errors and 0 warnings`.

- [ ] **Step 6: Commit.**
  `git add src/lib/tauri.ts src/lib/workspaces.svelte.ts src/lib/workspaces.test.ts && git commit -m "demo_muesli: add createRemoteWorkspace + promoteLocalToRemote store methods"`

---

## Task 8 — (C3) WorkspacePicker UI: Create remote + Promote

**Files:**
- Modify `src/lib/WorkspacePicker.svelte` — add `$state` for the inline name entry + handlers in
  `<script>` (~L8-37); add a per-row Promote action inside the `{#each}` (~L53-77); replace the
  Plan-5 TODO comment region (~L79-89) with the Create-remote affordance.

**Interfaces:**
- Consumes `workspaces.createRemoteWorkspace(name, path)`, `workspaces.promoteLocalToRemote(view)`,
  `workspaces.identity`, `workspaces.busy`, `pickFolder()` (existing `$lib/tauri` dialog helper),
  and `WorkspaceView`.
- Produces no new exports; gates all new actions on `workspaces.identity != null && !workspaces.busy`.

This component is **not vitest-testable** in the current harness (node env, no jsdom / no
`@testing-library/svelte`), so this task verifies via a precise manual step (Step 4) instead of a
vitest test. No animation library is present, so the make-interfaces-feel-better polish is
plain-CSS (`active:scale-[0.96] transition-transform` + a concentric input radius).

### Steps

- [ ] **Step 1: Add the script state + handlers.**
  In `src/lib/WorkspacePicker.svelte` `<script lang="ts">`, after `openLocal()` (~L37), add the
  name-entry state and the two new handlers. **UI choice for the name input:** a single inline
  text `<input>` (revealed by a toggle), submitted with Enter or a confirm button — no modal,
  matching the picker's lightweight popover idiom.

  ```ts
    // ── Create-remote inline entry ────────────────────────────────────────────
    let showCreateRemote = $state(false);
    let remoteName = $state("");

    const loggedIn = $derived(workspaces.identity != null && !!workspaces.activeServer);

    /** Slugify a name for the default folder suggestion (~/muesli/<slug>). */
    const slugify = (s: string): string =>
      s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";

    async function confirmCreateRemote() {
      const name = remoteName.trim();
      if (!name || workspaces.busy) return;
      // Prompt a folder; the dialog default-path hint is best-effort (~/muesli/<slug>).
      const path = await pickFolder();
      if (!path) return;
      showCreateRemote = false;
      remoteName = "";
      open = false;
      await workspaces.createRemoteWorkspace(name, path);
    }

    async function promote(view: WorkspaceView) {
      if (workspaces.busy) return;
      const ok = confirm(
        `Promote “${view.name}” to a shared workspace on the server? ` +
          `Your local files stay where they are and start syncing.`,
      );
      if (!ok) return;
      open = false;
      await workspaces.promoteLocalToRemote(view);
    }
  ```

  > Note: `~/muesli/<slug>` is a *suggested* default. The Tauri folder dialog
  > (`open({ directory: true })`) does not expose a reliable cross-platform default-path knob
  > here, so we slugify for the suggestion text and let the user confirm the folder. `slugify`
  > is wired for that hint; the actual chosen `path` comes from `pickFolder()`.

- [ ] **Step 2: Add the per-row Promote action.**
  In the `{#each workspaces.list as view (view.id)}` block, the row is currently a single
  `<button onclick={() => choose(view)}>`. Wrap the row so the Promote action sits beside it for
  `local-only` rows. Replace the existing row `<button>…</button>` (~L54-76) with a flex row that
  keeps the original open-button plus a trailing Promote button:

  ```svelte
        <div class="flex items-center gap-1">
          <button
            class="flex items-center gap-2 px-2 py-1.5 rounded-selector text-sm hover:bg-base-200 text-left flex-1 transition-transform active:scale-[0.96]"
            onclick={() => choose(view)}
          >
            {#if view.state === "cloud-only"}
              <Cloud size={15} class="shrink-0 text-base-content/50" />
            {:else}
              <HardDrive size={15} class="shrink-0 text-base-content/50" />
            {/if}
            <span class="truncate flex-1">{view.name}</span>
            {#if view.state === "cloud-only"}
              {#if workspaces.cloning}
                <span class="loading loading-spinner loading-xs shrink-0"></span>
              {:else}
                <span class="shrink-0 text-[10px] text-base-content/40">not downloaded</span>
              {/if}
            {:else if isActive(view)}
              <Check size={15} class="shrink-0 text-success" />
            {/if}
          </button>

          {#if view.state === "local-only" && loggedIn}
            <button
              class="shrink-0 px-1.5 py-1.5 rounded-selector text-[11px] text-base-content/60 hover:text-base-content hover:bg-base-200 transition-transform active:scale-[0.96] disabled:opacity-40 disabled:pointer-events-none"
              title="Promote to a shared workspace"
              disabled={workspaces.busy}
              onclick={() => promote(view)}
            >
              {#if workspaces.busy}
                <span class="loading loading-spinner loading-xs"></span>
              {:else}
                <Cloud size={14} class="text-base-content/50" />
              {/if}
            </button>
          {/if}
        </div>
  ```

  (Add `<Cloud … />` — already imported. The leading-icon/trailing-state logic inside the open
  button is unchanged from the original; only the wrapper and the Promote button are new, plus the
  `active:scale-[0.96]` press feedback.)

- [ ] **Step 3: Replace the Plan-5 TODO region with the Create-remote affordance.**
  Replace the trailing comment block (~L88, `<!-- Create-remote + promote land in Plan 5 … -->`)
  and keep the existing "Open local folder…" button above it. After that button, add:

  ```svelte
        {#if loggedIn}
          {#if showCreateRemote}
            <div class="flex items-center gap-1 px-2 py-1">
              <input
                class="flex-1 min-w-0 px-2 py-1 text-sm bg-base-200 outline-none focus:ring-1 focus:ring-primary/40"
                style="border-radius: calc(var(--radius-selector, 0.5rem) - 0.125rem);"
                placeholder="Workspace name"
                bind:value={remoteName}
                disabled={workspaces.busy}
                onkeydown={(e) => { if (e.key === "Enter") confirmCreateRemote(); if (e.key === "Escape") { showCreateRemote = false; remoteName = ""; } }}
                autofocus
              />
              <button
                class="shrink-0 px-2 py-1 rounded-selector text-sm text-primary hover:bg-base-200 transition-transform active:scale-[0.96] disabled:opacity-40 disabled:pointer-events-none"
                disabled={workspaces.busy || !remoteName.trim()}
                onclick={confirmCreateRemote}
              >
                {#if workspaces.busy}
                  <span class="loading loading-spinner loading-xs"></span>
                {:else}
                  Create
                {/if}
              </button>
            </div>
          {:else}
            <button
              class="flex items-center gap-2 px-2 py-1.5 rounded-selector text-sm hover:bg-base-200 text-left transition-transform active:scale-[0.96] disabled:opacity-40 disabled:pointer-events-none"
              disabled={workspaces.busy}
              onclick={() => { showCreateRemote = true; }}
            >
              <Cloud size={15} class="shrink-0 text-base-content/50" />
              <span>Create remote workspace…</span>
            </button>
          {/if}
        {/if}
  ```

  Polish notes: `active:scale-[0.96] transition-transform` gives a press response without a motion
  library (none is installed); the input uses a **concentric** radius
  (`calc(var(--radius-selector) - 0.125rem)`) so it nests cleanly inside the popover's
  `--radius-overlay`. Existing button/row classes are preserved verbatim — no style regression.

- [ ] **Step 4: Type-check + manual verification (no vitest harness for components).**
  Run `pnpm check` → expect `0 errors and 0 warnings`.
  Then manual-verify in a `pnpm tauri dev` run against a logged-in server:
  1. Open the workspace picker while logged in → a **"Create remote workspace…"** row appears
     under "Open local folder…"; a **Cloud** Promote button appears on each local-only row.
     While logged OUT, neither appears.
  2. Click "Create remote workspace…" → an inline name `<input>` appears (autofocused). Type a
     name, press Enter → the folder picker opens. Choose a folder → the picker closes, the row
     shows a spinner (busy), and on completion the new workspace opens and the daemon goes live
     (StatusBar shows running). Confirm the list now shows it as `cloned` (HardDrive + check).
  3. On a local-only row, click the Cloud Promote button → confirm dialog → on OK the row spins
     (busy), then the workspace re-renders as `cloned`, the same folder stays open, and the daemon
     is live. Confirm no duplicate/phantom local-only row remains (the registry swap removed it).
  4. Press a button and confirm the subtle scale-down press feedback; confirm the input's rounded
     corners nest inside the popover. Confirm existing rows/buttons look unchanged.

- [ ] **Step 5: Commit.**
  `git add src/lib/WorkspacePicker.svelte && git commit -m "demo_muesli: add Create remote + Promote actions to WorkspacePicker"`
