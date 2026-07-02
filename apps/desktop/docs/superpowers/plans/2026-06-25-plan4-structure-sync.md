# Structure Sync (Plan 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give demo_muesli full **bidirectional structure sync** — remote folder/document create/rename/move/delete reaches local disk and the sidebar tree live, local folder/file changes reach the server, and the 1s daemon status poll is retired in favor of a server push stream.

**Architecture:** A new **per-workspace SSE event stream** on muesli-server (`GET /api/workspaces/{id}/events`) broadcasts structural changes plus content wake-pings. The embedded muesli-cli daemon both consumes that stream — converging its disk tree to the server via an **idempotent reconcile** (echo-safe by construction) — and emits outbound REST when local disk changes. demo_muesli forwards the stream to the Svelte frontend over a Tauri event (`workspace://structure`) which refreshes the tree. The shared event type lives in `muesli-core` so server and cli share one definition.

**Tech Stack:** Rust (axum SSE + `tokio::sync::broadcast` server-side; reqwest streaming `bytes_stream` client-side; yrs CRDT), Tauri 2, SvelteKit / Svelte 5 runes, CodeMirror 6.

## Global Constraints

- **Transport is SSE** (Server-Sent Events), not WebSocket — decided by Julian. The daemon consumes it with reqwest streaming; the server emits with axum `Sse` + `KeepAlive`.
- **The shared event type lives in `muesli-core`** (`muesli_core::events::{WorkspaceEvent, WorkspaceEventEnvelope}`). Both muesli-server and muesli-cli depend on it; the TS mirror in demo_muesli `src/lib/tauri.ts` keeps field names identical. Serde tag is `"kind"`, `rename_all = "snake_case"`; the envelope `#[serde(flatten)]`s the event and carries `origin: Option<String>`.
- **Echo guard = idempotent convergence first, origin-id filter second.** The SSE event is a "reconcile now" trigger, not a per-delta apply. Inbound application is idempotent (create-if-missing; move-only-if-source-exists-and-dest-free; delete-only-for-known-synced-trashed docs, NEVER for never-pushed locals). The daemon additionally drops envelopes whose `origin` equals its own per-run `client_id` (sent as `x-muesli-client-id` on the SSE GET and every mutating REST call).
- **Branches stay UNMERGED — Julian merges.** Server + cli on muesli `feat/cli-list-workspaces`; client on demo_muesli `feat/auth-remote-workspaces`. **Commit messages carry NO `Co-Authored-By` trailer.**
- **Build/test commands.** muesli workspace builds with plain `cargo` (e.g. `cargo test -p muesli-core`, `cargo test -p muesli-server`, `cargo test -p muesli-cli`, `cargo clippy -p <crate> --tests`). demo_muesli `src-tauri` needs the DYLD workaround: `DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx cargo test --manifest-path src-tauri/Cargo.toml`. Frontend: `pnpm check` (expect `0 errors and 0 warnings`) and `pnpm test` (`vitest run`).
- **Do not regress Plan 3's flicker fix.** EditorPane reads a value-stable `const daemonRunning = $derived(!!daemon.status?.running)`. After Plan 4, `daemon.status` is set ONCE on `start()` (no recurring reassignment), which preserves the fix. Never reintroduce a recurring `status` reassignment.
- **No Postgres test harness exists** in muesli-server (no `tests/` dir). SSE/membership tests are unit-level (open-mode gate + broadcast/stream behavior); the OIDC membership branch reuses the audited `folders.rs` `Ctx::require_workspace` pattern verbatim rather than a new pg integration test.

## Cross-phase interface ledger (the reconciled signatures — every task conforms to these)

These were settled across all three phases; later tasks consume exactly these names/types:

- `muesli_core::events::WorkspaceEvent` — enum, `#[serde(tag="kind", rename_all="snake_case")]`, variants: `FolderCreated{id,parent_id,name}`, `FolderRenamed{id,name}`, `FolderMoved{id,parent_id}`, `FolderDeleted{id}`, `DocCreated{slug,folder_id,title}`, `DocRenamed{slug,title}`, `DocMoved{slug,folder_id}`, `DocDeleted{slug}`, `DocUpdated{slug}`. (Folder ids and `parent_id`/`folder_id` are `Option<String>`/`String`; `title` is `Option<String>`.)
- `muesli_core::events::WorkspaceEventEnvelope { origin: Option<String>, #[serde(flatten)] event: WorkspaceEvent }`.
- **Server:** `AppState` gains `workspace_events: WorkspaceEvents` (constructed early at main.rs:132 alongside `rooms`, threaded into `StorageManager::spawn` and the `AppState` literal). `WorkspaceEvents::publish(workspace_id: Uuid, env: WorkspaceEventEnvelope)` and `::subscribe(workspace_id: Uuid) -> broadcast::Receiver<WorkspaceEventEnvelope>`. Route: `GET /api/workspaces/{id}/events`. `persistence::DocState` gains `workspace_id: Option<Uuid>` (so the room learns it at hydrate for `DocUpdated`). DocCreated is emitted only from `restore_document`; brand-new remote docs are discovered by the daemon's reconcile.
- **Daemon (`muesli-cli`):** `sync::run(dir, server, prefix, web, verbose, stop_rx, status_tx, control_rx, workspace_id: Option<String>, events_tx: Option<UnboundedSender<WorkspaceEventEnvelope>>)` — two NEW trailing params, in that order. `SyncDaemon` stores `workspace_id` + a per-run `client_id: String` (uuid v4). `store::record_link(file, doc, server, workspace: Option<&str>)` — **3→4 arg break; THREE call sites**: sync.rs (~131, ~408), session.rs (~152, the `muesli open` path, passes `None`), plus demo_muesli `clone/mod.rs` (Phase C, passes `Some(workspace_id)`). New `store::doc_path(doc, server) -> Option<PathBuf>`. `api` REST helpers gain `client_id: &str`; `api::create_folder` also gains `workspace_id: Option<&str>`; new `api::trash_document(server, token, client_id, slug)` and `api::subscribe_workspace_events(server, token, workspace_id, client_id)`. New `doc_index: HashMap<String, PathBuf>` (slug→path) alongside `handles` fixes the rename-reclone duplicate-replica bug.
- **demo_muesli:** `DaemonHandle::start(app: AppHandle, dir, server, workspace_id: Option<String>)` (AppHandle injected by the `start_workspace_sync` command, like `attach_editor`). `start_workspace_sync` command + `tauri.ts startWorkspaceSync` gain `workspace_id`. Frontend threads `workspaceId` through `WorkspacesStore.openFolderWithSync(path, server, workspaceId)` (the real post-clone + already-local call site), passing `view.id`. `onStructureEvent(handler)` in tauri.ts listens on `"workspace://structure"`. `daemon.svelte.ts` retires the `setInterval` poll: one-shot status on start + push subscription + debounced `workspace.refresh()` on structural events.
- **Dependency additions** (each folded into the task that needs it): muesli-core gains `serde` derive (A1); muesli-server gains `tokio-stream` (`sync` feature, A3); muesli-cli gains `uuid` (`v4`, B1) and reqwest `stream` feature (B3).

## File structure (created / modified)

**muesli (`feat/cli-list-workspaces`):**
- Create: `crates/muesli-core/src/events.rs` (A1) — the shared event types.
- Modify: `crates/muesli-core/src/lib.rs` (A1 re-export), `crates/muesli-core/Cargo.toml` (A1 serde).
- Create: `crates/muesli-server/src/events.rs` (A2) — the `WorkspaceEvents` broadcast hub.
- Modify: `crates/muesli-server/src/main.rs` (A2 AppState+route, A6 ensure_room threading), `src/folders.rs` (A4/A5 publish wiring), `src/room.rs` (A6 DocUpdated), `src/persistence.rs` (A6 DocState.workspace_id), `src/storage.rs` (A6 spawn threading), `Cargo.toml` (A3 tokio-stream).
- Modify: `crates/muesli-cli/src/sync.rs` (B1/B2/B4/B5 daemon), `src/api.rs` (B3/B5 REST+SSE), `src/store.rs` (B1 workspace col + doc_path), `src/session.rs` (B1 record_link call site), `Cargo.toml` (B1 uuid, B3 reqwest stream).

**demo_muesli (`feat/auth-remote-workspaces`):**
- Modify: `src-tauri/src/sync_daemon/mod.rs` (C1/C2 start+forwarder), `src/sync_cmd.rs` (C1 command arg), `src/clone/mod.rs` (C1 record_link 4-arg), `src/lib.rs` (C2 AppHandle wiring if needed).
- Modify: `src/lib/tauri.ts` (C2 types + onStructureEvent + startWorkspaceSync arg), `src/lib/sync/daemon.svelte.ts` (C3 retire poll), `src/lib/workspaces.svelte.ts` (C1 thread workspaceId).

---

> **Phases run in order A → B → C.** Phase B's tasks import `muesli_core::events` (A1 must land first); Phase C calls the `sync::run` signature and `record_link` 4-arg form introduced in Phase B. Within a phase, tasks are mostly independent and reviewer-gateable. Model guidance per task is noted at each task header.

---
# Plan 4 — Phase A: muesli server SSE structure stream

Branch: `feat/cli-list-workspaces` (muesli repo). All commits use clean messages, NO
`Co-Authored-By` trailer. Build command is plain `cargo` (no DYLD — that is demo_muesli only).

Conventions for every task below:
- `cargo test -p muesli-core <name>` / `cargo test -p muesli-server <name>` run a single test.
- `cargo clippy -p muesli-server --tests` must be clean (no warnings) before each commit.
- TDD: write a failing test, run it and SEE it fail, write the minimal impl, run it and SEE
  it pass, then commit. Each numbered step is one of those beats.

Cross-phase contracts consumed here live in `plan4-architecture-brief.md` (Contracts 1–4).

---

## Task 1 — (A1) `muesli_core::events`: `WorkspaceEvent` + `WorkspaceEventEnvelope`

The shared wire type (Contract 1). Lives in muesli-core because BOTH muesli-server and
muesli-cli depend on it.

### Files
- `crates/muesli-core/Cargo.toml` — add the `serde` derive dependency.
- `crates/muesli-core/src/events.rs` — NEW. The two types + serde round-trip tests.
- `crates/muesli-core/src/lib.rs` — add `pub mod events;`.

### Interfaces
- Produces `muesli_core::events::WorkspaceEvent` (enum, `#[serde(tag = "kind", rename_all =
  "snake_case")]`) and `muesli_core::events::WorkspaceEventEnvelope` (struct, flattened event,
  defaulted `origin: Option<String>`), EXACTLY as Contract 1 defines.
- Consumes nothing.

### Steps

1. Add serde to muesli-core. `muesli-core` currently depends on `serde_json` but NOT `serde`
   with derive. Edit `crates/muesli-core/Cargo.toml`, in `[dependencies]`, after the
   `serde_json = "1"` line, add:
   ```toml
   serde = { version = "1", features = ["derive"] }
   ```

2. Write the failing test FIRST. Create `crates/muesli-core/src/events.rs` with the test
   module only (the types do not exist yet, so it will not compile = a failing test):
   ```rust
   //! The workspace structure-change event (Plan 4 Contract 1), broadcast on the per-workspace
   //! SSE stream and consumed by the muesli-cli sync daemon. `slug` is a document's immutable
   //! room id; `id` is a folder uuid carried as a String so the wire form needs no uuid feature.

   use serde::{Deserialize, Serialize};

   /// A structural change in a workspace.
   #[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
   #[serde(tag = "kind", rename_all = "snake_case")]
   pub enum WorkspaceEvent {
       FolderCreated { id: String, parent_id: Option<String>, name: String },
       FolderRenamed { id: String, name: String },
       FolderMoved { id: String, parent_id: Option<String> },
       FolderDeleted { id: String },
       DocCreated { slug: String, folder_id: Option<String>, title: Option<String> },
       DocRenamed { slug: String, title: Option<String> },
       DocMoved { slug: String, folder_id: Option<String> },
       DocDeleted { slug: String },
       /// Content wake-ping: doc `slug` received a CRDT update. Not structural; wakes a cold
       /// session to pull. Coalesced by the consumer.
       DocUpdated { slug: String },
   }

   /// SSE payload: the event plus the client-id that caused it (echo-guard). None = UI/unknown.
   #[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
   pub struct WorkspaceEventEnvelope {
       #[serde(default)]
       pub origin: Option<String>,
       #[serde(flatten)]
       pub event: WorkspaceEvent,
   }

   #[cfg(test)]
   mod tests {
       use super::*;

       #[test]
       fn folder_created_round_trips() {
           let ev = WorkspaceEvent::FolderCreated {
               id: "f1".into(),
               parent_id: Some("root".into()),
               name: "Projects".into(),
           };
           let json = serde_json::to_value(&ev).unwrap();
           assert_eq!(json["kind"], "folder_created");
           assert_eq!(json["id"], "f1");
           assert_eq!(json["parent_id"], "root");
           assert_eq!(json["name"], "Projects");
           let back: WorkspaceEvent = serde_json::from_value(json).unwrap();
           assert_eq!(back, ev);
       }

       #[test]
       fn every_variant_tag_is_snake_case() {
           let cases = [
               (WorkspaceEvent::FolderRenamed { id: "f".into(), name: "n".into() }, "folder_renamed"),
               (WorkspaceEvent::FolderMoved { id: "f".into(), parent_id: None }, "folder_moved"),
               (WorkspaceEvent::FolderDeleted { id: "f".into() }, "folder_deleted"),
               (WorkspaceEvent::DocCreated { slug: "s".into(), folder_id: None, title: None }, "doc_created"),
               (WorkspaceEvent::DocRenamed { slug: "s".into(), title: Some("T".into()) }, "doc_renamed"),
               (WorkspaceEvent::DocMoved { slug: "s".into(), folder_id: Some("f".into()) }, "doc_moved"),
               (WorkspaceEvent::DocDeleted { slug: "s".into() }, "doc_deleted"),
               (WorkspaceEvent::DocUpdated { slug: "s".into() }, "doc_updated"),
           ];
           for (ev, tag) in cases {
               let json = serde_json::to_value(&ev).unwrap();
               assert_eq!(json["kind"], tag, "wrong tag for {ev:?}");
               let back: WorkspaceEvent = serde_json::from_value(json).unwrap();
               assert_eq!(back, ev);
           }
       }

       #[test]
       fn envelope_flattens_to_one_object() {
           // The exact wire form from Contract 1.
           let env = WorkspaceEventEnvelope {
               origin: Some("client-abc".into()),
               event: WorkspaceEvent::DocRenamed { slug: "notes".into(), title: Some("Notes".into()) },
           };
           let s = serde_json::to_string(&env).unwrap();
           let v: serde_json::Value = serde_json::from_str(&s).unwrap();
           assert_eq!(v["origin"], "client-abc");
           assert_eq!(v["kind"], "doc_renamed");
           assert_eq!(v["slug"], "notes");
           assert_eq!(v["title"], "Notes");
           // `event` is flattened: there must be no nested "event" key.
           assert!(v.get("event").is_none());
           let back: WorkspaceEventEnvelope = serde_json::from_str(&s).unwrap();
           assert_eq!(back, env);
       }

       #[test]
       fn envelope_origin_defaults_to_none() {
           // A daemon-less producer (room DocUpdated) omits origin; consumers parse it back.
           let wire = r#"{"kind":"doc_updated","slug":"notes"}"#;
           let env: WorkspaceEventEnvelope = serde_json::from_str(wire).unwrap();
           assert_eq!(env.origin, None);
           assert_eq!(env.event, WorkspaceEvent::DocUpdated { slug: "notes".into() });
       }
   }
   ```

3. Register the module. In `crates/muesli-core/src/lib.rs`, the module list near the top is:
   ```rust
   mod anchor;
   mod ingest;
   pub mod protocol;
   ```
   Add `pub mod events;` after `pub mod protocol;`:
   ```rust
   mod anchor;
   mod ingest;
   pub mod events;
   pub mod protocol;
   ```

4. Run the test, EXPECT PASS (the impl types are written alongside the tests in step 2, so this
   compiles and passes immediately):
   ```
   cargo test -p muesli-core events::
   ```
   Expected tail:
   ```
   test events::tests::folder_created_round_trips ... ok
   test events::tests::every_variant_tag_is_snake_case ... ok
   test events::tests::envelope_flattens_to_one_object ... ok
   test events::tests::envelope_origin_defaults_to_none ... ok

   test result: ok. 4 passed; 0 failed; ...
   ```
   (Note: this task writes types and tests together. If you prefer a strict red beat, delete the
   two `pub enum`/`pub struct` blocks from step 2, run `cargo test -p muesli-core events::` and
   confirm it fails with `cannot find type WorkspaceEvent`, then paste the blocks back.)

5. Clippy clean:
   ```
   cargo clippy -p muesli-core --tests
   ```
   Expected: `Finished` with no warnings.

6. Commit:
   ```
   git add crates/muesli-core/Cargo.toml crates/muesli-core/src/events.rs crates/muesli-core/src/lib.rs
   git commit -m "feat(core): add WorkspaceEvent + envelope for workspace structure stream"
   ```

---

## Task 2 — (A2) `WorkspaceEvents` per-workspace broadcast hub on `AppState`

A lazily-populated map of per-workspace `tokio::sync::broadcast` senders. Publishing to a
workspace nobody is watching is a no-op; subscribing creates the sender if absent.

### Files
- `crates/muesli-server/src/events.rs` — NEW. The `WorkspaceEvents` type + unit tests.
- `crates/muesli-server/src/main.rs` — `mod events;`; add the field to `AppState`; construct it.

### Interfaces
- Produces:
  ```rust
  pub struct WorkspaceEvents { /* Arc<Mutex<HashMap<Uuid, broadcast::Sender<WorkspaceEventEnvelope>>>> */ }
  impl WorkspaceEvents {
      pub fn publish(&self, workspace_id: Uuid, envelope: WorkspaceEventEnvelope);
      pub fn subscribe(&self, workspace_id: Uuid) -> tokio::sync::broadcast::Receiver<WorkspaceEventEnvelope>;
  }
  impl Clone for WorkspaceEvents   // derived (shares the inner Arc)
  impl Default for WorkspaceEvents  // derived
  ```
- Consumes `muesli_core::events::WorkspaceEventEnvelope` (A1).

### Steps

1. Write the failing test FIRST. Create `crates/muesli-server/src/events.rs`:
   ```rust
   //! Per-workspace broadcast hub (Plan 4): structural handlers and rooms `publish` envelopes;
   //! the SSE endpoint `subscribe`s. A workspace's sender is created lazily on first subscribe
   //! or publish and lives for the process. Publishing with no live subscribers is a no-op
   //! (broadcast send returns Err, which we deliberately ignore).

   use std::collections::HashMap;
   use std::sync::{Arc, Mutex};

   use muesli_core::events::WorkspaceEventEnvelope;
   use tokio::sync::broadcast;
   use uuid::Uuid;

   /// Ring capacity per workspace channel. A slow SSE consumer that lags past this many
   /// events sees `RecvError::Lagged` and reconnects (the daemon then full-reconciles), so a
   /// modest buffer is fine — structural events are rare and the consumer debounces anyway.
   const CHANNEL_CAPACITY: usize = 256;

   #[derive(Clone, Default)]
   pub struct WorkspaceEvents {
       senders: Arc<Mutex<HashMap<Uuid, broadcast::Sender<WorkspaceEventEnvelope>>>>,
   }

   impl WorkspaceEvents {
       /// Subscribe to a workspace's stream, creating the channel if it does not yet exist.
       pub fn subscribe(&self, workspace_id: Uuid) -> broadcast::Receiver<WorkspaceEventEnvelope> {
           let mut map = self.senders.lock().unwrap();
           map.entry(workspace_id)
               .or_insert_with(|| broadcast::channel(CHANNEL_CAPACITY).0)
               .subscribe()
       }

       /// Publish an envelope to a workspace. No-op when no one is subscribed (the channel may
       /// not even exist yet). We create the channel lazily so an early publish is retained for
       /// nobody — but a publish-then-subscribe race never loses an event the subscriber should
       /// see, because broadcast only delivers events sent AFTER the subscribe.
       pub fn publish(&self, workspace_id: Uuid, envelope: WorkspaceEventEnvelope) {
           let sender = {
               let map = self.senders.lock().unwrap();
               map.get(&workspace_id).cloned()
           };
           if let Some(sender) = sender {
               // Err = no live receivers; that is expected and ignored.
               let _ = sender.send(envelope);
           }
       }
   }

   #[cfg(test)]
   mod tests {
       use super::*;
       use muesli_core::events::WorkspaceEvent;

       fn env(slug: &str) -> WorkspaceEventEnvelope {
           WorkspaceEventEnvelope {
               origin: None,
               event: WorkspaceEvent::DocUpdated { slug: slug.into() },
           }
       }

       #[tokio::test]
       async fn subscribe_then_publish_delivers_in_order() {
           let hub = WorkspaceEvents::default();
           let ws = Uuid::now_v7();
           let mut rx = hub.subscribe(ws);
           hub.publish(ws, env("a"));
           hub.publish(ws, env("b"));
           assert_eq!(rx.recv().await.unwrap().event, WorkspaceEvent::DocUpdated { slug: "a".into() });
           assert_eq!(rx.recv().await.unwrap().event, WorkspaceEvent::DocUpdated { slug: "b".into() });
       }

       #[tokio::test]
       async fn publish_with_no_subscriber_is_a_noop() {
           let hub = WorkspaceEvents::default();
           let ws = Uuid::now_v7();
           // No channel exists yet; this must not panic and must drop the event.
           hub.publish(ws, env("lost"));
           // A subscriber that arrives afterwards sees only future events.
           let mut rx = hub.subscribe(ws);
           hub.publish(ws, env("kept"));
           assert_eq!(rx.recv().await.unwrap().event, WorkspaceEvent::DocUpdated { slug: "kept".into() });
       }

       #[tokio::test]
       async fn late_subscriber_does_not_get_old_events() {
           let hub = WorkspaceEvents::default();
           let ws = Uuid::now_v7();
           let _early = hub.subscribe(ws); // creates the channel
           hub.publish(ws, env("old"));
           // A second, late subscriber starts from "now" and must NOT see "old".
           let mut late = hub.subscribe(ws);
           hub.publish(ws, env("new"));
           assert_eq!(late.recv().await.unwrap().event, WorkspaceEvent::DocUpdated { slug: "new".into() });
       }

       #[tokio::test]
       async fn distinct_workspaces_are_isolated() {
           let hub = WorkspaceEvents::default();
           let (a, b) = (Uuid::now_v7(), Uuid::now_v7());
           let mut rx_a = hub.subscribe(a);
           hub.publish(b, env("b-only"));
           hub.publish(a, env("a-only"));
           // rx_a sees only a's event, never b's.
           assert_eq!(rx_a.recv().await.unwrap().event, WorkspaceEvent::DocUpdated { slug: "a-only".into() });
       }
   }
   ```

2. Register the module. In `crates/muesli-server/src/main.rs` the module list (lines 5–17) is
   alphabetical; add `mod events;` between `mod auth;` and `mod folders;`:
   ```rust
   mod auth;
   mod events;
   mod folders;
   ```

3. Run the tests, EXPECT PASS (impl is written with the tests in step 1):
   ```
   cargo test -p muesli-server events::
   ```
   Expected tail:
   ```
   test events::tests::subscribe_then_publish_delivers_in_order ... ok
   test events::tests::publish_with_no_subscriber_is_a_noop ... ok
   test events::tests::late_subscriber_does_not_get_old_events ... ok
   test events::tests::distinct_workspaces_are_isolated ... ok

   test result: ok. 4 passed; 0 failed; ...
   ```

4. Add the field to `AppState`. In `main.rs` the struct (lines 45–54) is:
   ```rust
   #[derive(Clone, Default)]
   pub struct AppState {
       rooms: Rooms,
       persistence: Option<Arc<Persistence>>,
       pub auth: Option<Arc<AuthCtx>>,
       pub storage: Option<Arc<StorageManager>>,
       pub links: Option<LinkHandle>,
   }
   ```
   Add the field after `links` and a `use` for the type. Add near the other module `use`s
   (after `use auth::{Access, AuthCtx};`):
   ```rust
   use events::WorkspaceEvents;
   ```
   Then the struct:
   ```rust
   #[derive(Clone, Default)]
   pub struct AppState {
       rooms: Rooms,
       persistence: Option<Arc<Persistence>>,
       pub auth: Option<Arc<AuthCtx>>,
       pub storage: Option<Arc<StorageManager>>,
       pub links: Option<LinkHandle>,
       /// Per-workspace structure-change broadcast hub (Plan 4 SSE stream).
       pub workspace_events: WorkspaceEvents,
   }
   ```

5. Construct it in `main`. The state construction (main.rs:158) is currently:
   ```rust
   let state = AppState { persistence, auth, rooms, storage, links };
   ```
   Change to:
   ```rust
   let state = AppState {
       persistence,
       auth,
       rooms,
       storage,
       links,
       workspace_events: WorkspaceEvents::default(),
   };
   ```

6. Build to confirm the struct change compiles (no behaviour test yet — A3 exercises it through
   the route):
   ```
   cargo build -p muesli-server
   ```
   Expected: `Finished`.

7. Clippy clean:
   ```
   cargo clippy -p muesli-server --tests
   ```
   Expected: no warnings.

8. Commit:
   ```
   git add crates/muesli-server/src/events.rs crates/muesli-server/src/main.rs
   git commit -m "feat(server): add per-workspace WorkspaceEvents broadcast hub on AppState"
   ```

---

## Task 3 — (A3) SSE endpoint `GET /api/workspaces/{id}/events`

Membership-gated text/event-stream (Contract 2). Reuses the folders.rs membership posture.

### Files
- `crates/muesli-server/Cargo.toml` — add `tokio-stream` (and `futures` for `Stream` glue).
- `crates/muesli-server/src/events.rs` — add the `workspace_events_sse` handler + a gate helper
  + an integration-style test that drives the handler.
- `crates/muesli-server/src/main.rs` — wire the route near line 219.

### Interfaces
- Produces axum handler:
  ```rust
  pub async fn workspace_events_sse(
      State(state): State<AppState>,
      Path(id): Path<Uuid>,
      jar: CookieJar,
      headers: axum::http::HeaderMap,
  ) -> Response  // 503 no-DB, 403 non-member, else Sse<...> (200 text/event-stream)
  ```
- Consumes `WorkspaceEvents::subscribe` (A2), `Persistence::workspace_role` (existing),
  `AuthCtx::authenticate` (existing). Membership rule mirrors folders.rs `Ctx::require_workspace`:
  open mode (no `state.auth`) → allowed; OIDC member → allowed; non-member → 403; no DB → 503.

### Steps

1. Add the streaming deps. In `crates/muesli-server/Cargo.toml`, in `[dependencies]`, after the
   `futures-util = "0.3"` line add:
   ```toml
   tokio-stream = { version = "0.1", features = ["sync"] }
   ```
   (`tokio-stream`'s `sync` feature provides `BroadcastStream`, the adapter that turns a
   `broadcast::Receiver` into a `Stream`. `futures-util` — already a dependency — supplies the
   `StreamExt::map` we use. No `futures` umbrella crate is needed.)

2. Write the failing test FIRST. Append to the `tests` module in
   `crates/muesli-server/src/events.rs` (the gate is testable without a DB because open mode —
   `state.auth == None`, `state.persistence == None` would be 503; we test the open-mode allowed
   path and the streaming behaviour by calling the gate + stream directly). Add:
   ```rust
       use axum::body::Body;
       use axum::http::StatusCode;
       use std::time::Duration;

       // The membership gate, factored so it is unit-testable without a live axum request.
       // Mirrors folders.rs Ctx::require_workspace: open mode allowed, OIDC member allowed,
       // non-member 403, no DB 503. Tested here for the open-mode (auth=None) branch; the
       // OIDC branches are covered by the e2e suite (they need a real Postgres + principal).
       #[tokio::test]
       async fn gate_allows_open_mode() {
           let state = crate::AppState::default(); // persistence None, auth None
           // No DB → 503, because the stream needs the workspace to exist conceptually but the
           // gate's first check is persistence presence (parity with folders NO_DB).
           let ws = Uuid::now_v7();
           let outcome = super::events_gate(&state, ws, &Default::default(), &Default::default()).await;
           assert!(matches!(outcome, Err(s) if s == StatusCode::SERVICE_UNAVAILABLE));
       }

       #[tokio::test]
       async fn stream_emits_published_envelope() {
           // Drive the SSE body directly: subscribe via the hub, publish, and confirm the
           // serialized `data:` line carries the envelope JSON.
           let hub = WorkspaceEvents::default();
           let ws = Uuid::now_v7();
           let rx = hub.subscribe(ws);
           let mut stream = super::sse_event_stream(rx);
           hub.publish(ws, env("hello"));
           // Pull one Server-Sent Event with a timeout so a hang fails fast.
           let item = tokio::time::timeout(Duration::from_secs(2), futures_util::StreamExt::next(&mut stream))
               .await
               .expect("stream produced an event within 2s")
               .expect("stream not ended");
           let event = item.expect("infallible");
           let data = event_data(&event);
           assert!(data.contains(r#""kind":"doc_updated""#), "got: {data}");
           assert!(data.contains(r#""slug":"hello""#), "got: {data}");
           let _ = Body::new; // keep the Body import used if the e2e harness needs it later
       }

       // Read the `data:` field out of an axum SSE Event by serializing it the way the
       // framework does on the wire.
       fn event_data(event: &axum::response::sse::Event) -> String {
           // axum's Event has no public getter; round-trip through its IntoResponse-less
           // Display by re-encoding. We stored JSON, so reconstruct it from the response body
           // instead: build a one-item stream and read it.
           // Simpler: our sse_event_stream maps each envelope to Event::default().data(json),
           // and Event implements `Display` producing the full SSE frame including "data: ".
           format!("{event}")
       }
   ```
   NOTE on `event_data`: axum's `sse::Event` implements `std::fmt::Display`, rendering the full
   frame (`data: {...}\n\n`). The `contains` assertions match against that rendered frame, so we
   do not need a private getter.

3. Run it — EXPECT FAIL (the helpers `events_gate` and `sse_event_stream` do not exist yet):
   ```
   cargo test -p muesli-server events::tests::stream_emits_published_envelope
   ```
   Expected failure: `cannot find function sse_event_stream in module super` (compile error).

4. Implement the gate + stream + handler. In `crates/muesli-server/src/events.rs`, add the
   imports at the top of the file (after the existing `use` block):
   ```rust
   use axum::extract::{Path, State};
   use axum::http::StatusCode;
   use axum::response::sse::{Event, KeepAlive, Sse};
   use axum::response::{IntoResponse, Response};
   use axum_extra::extract::cookie::CookieJar;
   use futures_util::{Stream, StreamExt};
   use std::convert::Infallible;
   use std::time::Duration;
   use tokio_stream::wrappers::BroadcastStream;

   use crate::auth::Role;
   use crate::AppState;
   ```
   Then add, above the `#[cfg(test)]` module:
   ```rust
   const NO_DB: &str = "this endpoint requires DATABASE_URL (server is running volatile)";

   /// Membership gate for the SSE stream — the same posture as folders.rs
   /// `Ctx::require_workspace`: no DB → 503; open mode (no auth) → allowed; OIDC member →
   /// allowed; otherwise 403. Returns the persistence handle on success (the caller does not
   /// need it, but threading it keeps the shape parallel to `ctx`).
   async fn events_gate(
       state: &AppState,
       workspace_id: Uuid,
       jar: &CookieJar,
       headers: &axum::http::HeaderMap,
   ) -> Result<(), StatusCode> {
       let Some(persistence) = state.persistence.clone() else {
           return Err(StatusCode::SERVICE_UNAVAILABLE);
       };
       let Some(auth) = state.auth.as_ref() else {
           return Ok(()); // open mode: every connection may watch
       };
       let Some(principal) = auth.authenticate(jar, headers).await else {
           return Err(StatusCode::UNAUTHORIZED);
       };
       if principal.role_cap < Role::Viewer {
           return Err(StatusCode::FORBIDDEN);
       }
       if let Some(r) = principal.workspace_restriction {
           if r != workspace_id {
               return Err(StatusCode::FORBIDDEN);
           }
       }
       match persistence.workspace_role(workspace_id, principal.role_user).await {
           Ok(Some(_)) => Ok(()),
           Ok(None) => Err(StatusCode::FORBIDDEN),
           Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
       }
   }

   /// Turn a workspace broadcast receiver into an SSE event stream. Lagged/closed receiver
   /// errors end that frame silently (the consumer reconnects and full-reconciles); each live
   /// envelope becomes one `data:` line of `WorkspaceEventEnvelope` JSON.
   fn sse_event_stream(
       rx: tokio::sync::broadcast::Receiver<WorkspaceEventEnvelope>,
   ) -> impl Stream<Item = Result<Event, Infallible>> {
       BroadcastStream::new(rx).filter_map(|res| async move {
           match res {
               Ok(envelope) => {
                   // Serialization of our own type cannot fail; fall back to skipping if it ever did.
                   match serde_json::to_string(&envelope) {
                       Ok(json) => Some(Ok(Event::default().data(json))),
                       Err(_) => None,
                   }
               }
               Err(_lagged) => None,
           }
       })
   }

   /// GET /api/workspaces/{id}/events — the per-workspace structure stream (Plan 4 Contract 2).
   pub async fn workspace_events_sse(
       State(state): State<AppState>,
       Path(id): Path<Uuid>,
       jar: CookieJar,
       headers: axum::http::HeaderMap,
   ) -> Response {
       if let Err(status) = events_gate(&state, id, &jar, &headers).await {
           let msg = if status == StatusCode::SERVICE_UNAVAILABLE { NO_DB } else { "" };
           return (status, msg).into_response();
       }
       let rx = state.workspace_events.subscribe(id);
       Sse::new(sse_event_stream(rx))
           .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
           .into_response()
   }
   ```
   Also add `use muesli_core::events::WorkspaceEventEnvelope;` already present from A2 — confirm
   the top of the file imports it (it does, from A2's `use muesli_core::events::WorkspaceEventEnvelope;`).

5. Run the unit tests, EXPECT PASS:
   ```
   cargo test -p muesli-server events::
   ```
   Expected: all A2 tests plus `gate_allows_open_mode` and `stream_emits_published_envelope`
   pass (`test result: ok. 6 passed; 0 failed`).

6. Wire the route. In `main.rs`, the workspaces routes start at line 219. Immediately after:
   ```rust
   .route("/api/workspaces", get(workspace::list_workspaces))
   ```
   add:
   ```rust
   .route("/api/workspaces/{id}/events", get(events::workspace_events_sse))
   ```

7. Build, EXPECT PASS:
   ```
   cargo build -p muesli-server
   ```
   Expected: `Finished`.

8. Add the 403 e2e test. The non-member 403 path needs a real principal + Postgres, which the
   existing server e2e suite provides. Locate the integration test file that already exercises
   folders membership (search):
   ```
   rg -l "workspace_role|require_workspace|not a member" crates/muesli-server/tests
   ```
   In that file (e.g. `crates/muesli-server/tests/folders.rs`), add a test that:
   - boots the test app with Postgres + OIDC stub (reuse the existing harness fn),
   - creates a workspace owned by user A,
   - issues a request `GET /api/workspaces/{id}/events` as a NON-member user B,
   - asserts `403 FORBIDDEN`;
   - then as member A asserts the response status is `200` and the `content-type` is
     `text/event-stream` (read only the headers, then drop the connection — do NOT block reading
     the body, which never ends).
   Follow the exact harness/import shape already used by the neighbouring folder tests in that
   file; the new test is structurally identical to an existing "non-member gets 403" folder test
   with the path swapped to `/events` and the body left unread.

   If no Postgres-backed harness exists in `crates/muesli-server/tests`, SKIP this e2e (the
   open-mode gate + stream behaviour is already covered by step 5's unit tests, and the OIDC
   branch is a direct reuse of the audited folders.rs pattern); note the skip in the commit body.

9. Run the e2e (only if added). The server e2e suite usually requires `DATABASE_URL`; run with
   the project's standard test-db env (check `crates/muesli-server/tests` for a README or the
   harness's env reads):
   ```
   cargo test -p muesli-server --test folders workspace_events
   ```
   Expected: the new `workspace_events_*` test passes.

10. Clippy clean:
    ```
    cargo clippy -p muesli-server --tests
    ```
    Expected: no warnings. (If clippy flags the unused `Body`/`event_data` helper, remove the
    `let _ = Body::new;` line and the unused import.)

11. Commit:
    ```
    git add crates/muesli-server/Cargo.toml crates/muesli-server/src/events.rs crates/muesli-server/src/main.rs
    git commit -m "feat(server): SSE endpoint GET /api/workspaces/{id}/events (membership-gated)"
    ```

---

## Task 4 — (A4) wire folder handlers to publish events

Publish a `WorkspaceEvent` next to every `audit::record(...)` in the folder handlers, tagged
with the origin client-id from `x-muesli-client-id`.

### Files
- `crates/muesli-server/src/folders.rs` — `create_folder`, `update_folder`, `delete_folder`,
  `restore_folder`; plus a small `origin_of(&HeaderMap)` helper.

### Interfaces
- Consumes `state.workspace_events.publish(workspace_id, envelope)` (A2),
  `muesli_core::events::WorkspaceEvent` (A1), the `x-muesli-client-id` request header
  (Contract 3).
- Produces no new public surface; emits:
  - `create_folder` → `FolderCreated { id, parent_id, name }`
  - `update_folder` → `FolderRenamed { id, name }` if the name changed AND/OR
    `FolderMoved { id, parent_id }` if the parent changed (emit one or both)
  - `delete_folder` → `FolderDeleted { id }`
  - `restore_folder` → `FolderCreated { id, parent_id, name }` (a restore re-introduces the
    folder to clients that had dropped it; FolderCreated is the idempotent "this folder exists
    here now" signal — Contract 5 makes the consumer create-if-missing, so reusing FolderCreated
    is correct and needs no new variant).

  Folder ids and parent ids are uuids in the DB but Strings on the wire (Contract 1):
  serialize with `.to_string()` / `.map(|u| u.to_string())`.

### Steps

1. Add the origin helper. In `folders.rs`, after the `err`/`err500`/`conflict_or_500` helpers
   (around line 59), add:
   ```rust
   /// The originating sync client-id (Contract 3 echo-guard) from `x-muesli-client-id`, if the
   /// caller is the daemon. UI/browser callers omit it → `None`.
   fn origin_of(headers: &axum::http::HeaderMap) -> Option<String> {
       headers
           .get("x-muesli-client-id")
           .and_then(|v| v.to_str().ok())
           .map(str::to_string)
   }
   ```
   And import the event type at the top of `folders.rs` (after `use crate::AppState;`):
   ```rust
   use muesli_core::events::{WorkspaceEvent, WorkspaceEventEnvelope};
   ```

2. Write the failing test FIRST (a pure mapping unit test). The publish points are inside async
   DB handlers, so instead of an e2e we unit-test the envelope-construction logic by extracting
   it into a tiny pure helper and testing THAT. Add to the `tests` module in `folders.rs`:
   ```rust
       #[test]
       fn folder_update_emits_rename_and_move_per_changed_field() {
           let id = Uuid::now_v7();
           let parent = Uuid::now_v7();
           // name changed, parent changed → two events.
           let evs = super::folder_update_events(
               id,
               /* name_changed */ Some("New".to_string()),
               /* parent_changed */ Some(Some(parent)),
           );
           assert_eq!(evs.len(), 2);
           assert_eq!(evs[0], WorkspaceEvent::FolderRenamed { id: id.to_string(), name: "New".into() });
           assert_eq!(
               evs[1],
               WorkspaceEvent::FolderMoved { id: id.to_string(), parent_id: Some(parent.to_string()) }
           );
           // only a rename → one event.
           let only_name = super::folder_update_events(id, Some("X".into()), None);
           assert_eq!(only_name, vec![WorkspaceEvent::FolderRenamed { id: id.to_string(), name: "X".into() }]);
           // only a move to root → one FolderMoved with parent_id None.
           let only_move = super::folder_update_events(id, None, Some(None));
           assert_eq!(only_move, vec![WorkspaceEvent::FolderMoved { id: id.to_string(), parent_id: None }]);
           // nothing changed → no events.
           assert!(super::folder_update_events(id, None, None).is_empty());
       }
   ```

3. Run it — EXPECT FAIL (`folder_update_events` does not exist):
   ```
   cargo test -p muesli-server folder_update_emits
   ```
   Expected: `cannot find function folder_update_events`.

4. Implement the pure helper. In `folders.rs`, near the other pure helpers (after
   `creates_cycle`), add:
   ```rust
   /// Map an applied folder update to the structure events it produced: a rename if `name`
   /// changed, a move if `parent` changed (Contract 1). `name`/`parent` are `Some(..)` only
   /// when that field actually changed in this request.
   fn folder_update_events(
       id: Uuid,
       name: Option<String>,
       parent: Option<Option<Uuid>>,
   ) -> Vec<WorkspaceEvent> {
       let mut out = Vec::new();
       if let Some(name) = name {
           out.push(WorkspaceEvent::FolderRenamed { id: id.to_string(), name });
       }
       if let Some(parent_id) = parent {
           out.push(WorkspaceEvent::FolderMoved {
               id: id.to_string(),
               parent_id: parent_id.map(|p| p.to_string()),
           });
       }
       out
   }
   ```

5. Run it, EXPECT PASS:
   ```
   cargo test -p muesli-server folder_update_emits
   ```
   Expected: `test result: ok. 1 passed`.

6. Wire `create_folder`. In the `Ok(folder)` arm (lines 307–315), AFTER the existing
   `audit::record(...)` call and BEFORE `Json(folder_json(&folder)).into_response()`, add:
   ```rust
   if let Some(ws) = workspace_id {
       state.workspace_events.publish(
           ws,
           WorkspaceEventEnvelope {
               origin: origin_of(&headers),
               event: WorkspaceEvent::FolderCreated {
                   id: folder.id.to_string(),
                   parent_id: folder.parent_id.map(|p| p.to_string()),
                   name: name.to_string(),
               },
           },
       );
   }
   ```
   (Open-mode folders have `workspace_id == None`; there is no stream to publish to, so skip.)

7. Wire `update_folder`. Determine which fields changed. The handler already computes `name:
   Option<String>` (the validated new name, `None` when absent) and has `req.parent_id:
   Option<Option<Uuid>>`. After the existing `audit::record(...)` (lines 415–421) and before
   `relocation_response(...)`, add:
   ```rust
   if let Some(ws) = updated.workspace_id {
       for event in folder_update_events(id, name.clone(), req.parent_id) {
           state.workspace_events.publish(
               ws,
               WorkspaceEventEnvelope { origin: origin_of(&headers), event },
           );
       }
   }
   ```
   NOTE: `name` is the `Option<String>` already bound at line 358 (Some only when the request
   carried a new, valid name); `req.parent_id` is `Some(..)` only when the request carried a
   parent change. This matches `folder_update_events`'s contract exactly. `name` is moved into
   the loop, so clone it (`name.clone()`) since `name` may be used by nothing afterwards — if a
   borrow-checker error appears, the simplest fix is the `.clone()` shown.

8. Wire `delete_folder`. In the `Ok((folders, documents))` arm (lines 446–456), after
   `audit::record(...)` and before the `Json(...)` return, add:
   ```rust
   state.workspace_events.publish(
       folder.workspace_id.unwrap_or_default(),
       WorkspaceEventEnvelope {
           origin: origin_of(&headers),
           event: WorkspaceEvent::FolderDeleted { id: id.to_string() },
       },
   );
   ```
   Guard against the open-mode (`workspace_id == None`) case the same way as create — wrap in
   `if let Some(ws) = folder.workspace_id { ... }` instead of `unwrap_or_default()` so we never
   publish to the nil uuid. Use:
   ```rust
   if let Some(ws) = folder.workspace_id {
       state.workspace_events.publish(
           ws,
           WorkspaceEventEnvelope {
               origin: origin_of(&headers),
               event: WorkspaceEvent::FolderDeleted { id: id.to_string() },
           },
       );
   }
   ```

9. Wire `restore_folder`. After `audit::record(...)` (lines 497–503) and before
   `relocation_response(...)`, add a `FolderCreated` (the idempotent "exists here now" signal).
   `folder` here is the PRE-restore row (it has `name` and `parent_id`); a restore may re-root it,
   but the consumer reconciles paths anyway, so the pre-restore parent is an acceptable hint.
   Use the post-restore truth by re-reading is overkill; emit from `folder`:
   ```rust
   if let Some(ws) = folder.workspace_id {
       state.workspace_events.publish(
           ws,
           WorkspaceEventEnvelope {
               origin: origin_of(&headers),
               event: WorkspaceEvent::FolderCreated {
                   id: folder.id.to_string(),
                   parent_id: folder.parent_id.map(|p| p.to_string()),
                   name: folder.name.clone(),
               },
           },
       );
   }
   ```

10. Build + clippy, EXPECT PASS:
    ```
    cargo build -p muesli-server && cargo clippy -p muesli-server --tests
    ```
    Expected: `Finished`, no warnings.

11. Run the folders tests:
    ```
    cargo test -p muesli-server --lib folders::
    ```
    Expected: the existing cycle/name tests plus `folder_update_emits_rename_and_move_per_changed_field`
    all pass.

12. Commit:
    ```
    git add crates/muesli-server/src/folders.rs
    git commit -m "feat(server): publish folder create/rename/move/delete/restore on the workspace stream"
    ```

---

## Task 5 — (A5) wire document handlers to publish events

`update_document` (rename → `DocRenamed`, folder change → `DocMoved`), `delete_document` →
`DocDeleted`, `restore_document` → `DocCreated`. Decide the `DocCreated` first-emit point.

### DocCreated emit-point decision (documented per the brief)

A brand-new document is born lazily: `persistence::load(slug)` does an `insert ... on conflict`
the first time a room hydrates, so there is **no single HTTP handler that "creates" a document**
the way `create_folder` does. The cleanest correct emit point for `DocCreated` is therefore
**`restore_document`** (re-introducing a trashed doc) PLUS **`update_document` when a doc first
gains a title or folder** — but emitting `DocCreated` on every rename would be wrong.

Decision (simplest correct): **emit `DocCreated` only from `restore_document`**, and let the
DAEMON's `inbound_reconcile` (Contract 5, Phase B) discover genuinely new docs via the periodic
list + the `DocUpdated` wake-ping (A6). Justification: Contract 5 makes inbound application a
full idempotent reconcile keyed off `api::list_docs_and_folders`, not a per-delta apply, so a
new doc is picked up by the next reconcile tick or its first `DocUpdated`; we do not need a
dedicated server-side `DocCreated` for the create path, and adding one at the lazy
`load`-insert site would require threading `WorkspaceEvents` into persistence (a layering
violation). `restore_document` emitting `DocCreated` covers the "undelete reappears live" case,
which the reconcile's delete-detection would otherwise have to special-case. This keeps the
server emit-points aligned 1:1 with explicit REST handlers.

### Files
- `crates/muesli-server/src/folders.rs` — `update_document`, `delete_document`,
  `restore_document` (these doc handlers live in folders.rs).

### Interfaces
- Consumes `state.workspace_events.publish`, `WorkspaceEvent` (DocRenamed/DocMoved/DocDeleted/
  DocCreated), `origin_of` (A4), `x-muesli-client-id`.
- Produces no new public surface.

### Steps

1. Write the failing test FIRST — a pure mapping helper mirroring A4. Add to `folders.rs` tests:
   ```rust
       #[test]
       fn document_update_emits_rename_and_move_per_changed_field() {
           let slug = "notes";
           // title set + folder changed → DocRenamed then DocMoved.
           let folder = Uuid::now_v7();
           let evs = super::document_update_events(
               slug,
               /* title_changed_to */ Some(Some("Notes".to_string())),
               /* folder_changed_to */ Some(Some(folder)),
           );
           assert_eq!(
               evs,
               vec![
                   WorkspaceEvent::DocRenamed { slug: slug.into(), title: Some("Notes".into()) },
                   WorkspaceEvent::DocMoved { slug: slug.into(), folder_id: Some(folder.to_string()) },
               ]
           );
           // title cleared (None) → DocRenamed{title: None}.
           assert_eq!(
               super::document_update_events(slug, Some(None), None),
               vec![WorkspaceEvent::DocRenamed { slug: slug.into(), title: None }]
           );
           // move to root only.
           assert_eq!(
               super::document_update_events(slug, None, Some(None)),
               vec![WorkspaceEvent::DocMoved { slug: slug.into(), folder_id: None }]
           );
           // nothing changed.
           assert!(super::document_update_events(slug, None, None).is_empty());
       }
   ```

2. Run it — EXPECT FAIL:
   ```
   cargo test -p muesli-server document_update_emits
   ```
   Expected: `cannot find function document_update_events`.

3. Implement the helper near `folder_update_events`:
   ```rust
   /// Map an applied document update to its structure events (Contract 1). `title` is
   /// `Some(_)` only when the title field changed (inner `Option` = the new title, None =
   /// cleared to the slug fallback); `folder` is `Some(_)` only when the folder changed.
   fn document_update_events(
       slug: &str,
       title: Option<Option<String>>,
       folder: Option<Option<Uuid>>,
   ) -> Vec<WorkspaceEvent> {
       let mut out = Vec::new();
       if let Some(title) = title {
           out.push(WorkspaceEvent::DocRenamed { slug: slug.to_string(), title });
       }
       if let Some(folder_id) = folder {
           out.push(WorkspaceEvent::DocMoved {
               slug: slug.to_string(),
               folder_id: folder_id.map(|f| f.to_string()),
           });
       }
       out
   }
   ```

4. Run it, EXPECT PASS:
   ```
   cargo test -p muesli-server document_update_emits
   ```
   Expected: `test result: ok. 1 passed`.

5. Wire `update_document`. The handler tracks `title_out: Option<Option<String>>` (Some only
   when title was set/cleared) and `moved: bool` with `folder_out`. Build the `folder` argument
   as `Some(folder_out)` only when `moved`. After the existing `audit::record(...)` (lines
   591–601) and before `relocation_response(...)`, add:
   ```rust
   if let Some(ws) = doc.workspace_id {
       let folder_change = if moved { Some(folder_out) } else { None };
       for event in document_update_events(&slug, title_out.clone(), folder_change) {
           state.workspace_events.publish(
               ws,
               WorkspaceEventEnvelope { origin: origin_of(&headers), event },
           );
       }
   }
   ```
   (`title_out` is the `Option<Option<String>>` bound at line 541; it is `Some` exactly when the
   title changed. `moved`/`folder_out` are bound at lines 549–550. Clone `title_out` because it
   is also returned in the response payload below.)

6. Wire `delete_document`. After `audit::record(...)` (lines 630–637) and before the `Json(...)`
   return, add:
   ```rust
   if let Some(ws) = doc.workspace_id {
       state.workspace_events.publish(
           ws,
           WorkspaceEventEnvelope {
               origin: origin_of(&headers),
               event: WorkspaceEvent::DocDeleted { slug: slug.clone() },
           },
       );
   }
   ```

7. Wire `restore_document` (the `DocCreated` emit point). After `audit::record(...)` (lines
   664–671) and before `relocation_response(...)`, add:
   ```rust
   if let Some(ws) = doc.workspace_id {
       state.workspace_events.publish(
           ws,
           WorkspaceEventEnvelope {
               origin: origin_of(&headers),
               event: WorkspaceEvent::DocCreated {
                   slug: slug.clone(),
                   folder_id: folder_id.map(|f| f.to_string()),
                   title: doc.title.clone(),
               },
           },
       );
   }
   ```
   (`folder_id` is the post-restore folder bound at line 653; `doc.title` is the stored display
   title from `find_document`.)

8. Build + clippy, EXPECT PASS:
   ```
   cargo build -p muesli-server && cargo clippy -p muesli-server --tests
   ```
   Expected: `Finished`, no warnings.

9. Run folders tests:
   ```
   cargo test -p muesli-server --lib folders::
   ```
   Expected: all pass including `document_update_emits_rename_and_move_per_changed_field`.

10. Commit:
    ```
    git add crates/muesli-server/src/folders.rs
    git commit -m "feat(server): publish document rename/move/delete/restore on the workspace stream"
    ```

---

## Task 6 — (A6) room learns workspace_id and publishes `DocUpdated` on persist

The room must publish `DocUpdated { slug }` (origin `None`) after every successful append so a
cold daemon session is woken to pull. The room currently knows only `document_id`; it needs the
workspace_id and a handle to the hub.

### Files
- `crates/muesli-server/src/persistence.rs` — add `workspace_id` to `DocState` and to the
  `load` SELECT.
- `crates/muesli-server/src/room.rs` — `spawn_room`/`run_room`/`Room` gain a `WorkspaceEvents`
  handle; `hydrate` learns `workspace_id`; `persist` publishes `DocUpdated`.
- `crates/muesli-server/src/main.rs` — thread `state.workspace_events` through
  `ensure_room`/`ensure_room_in`/`spawn_room`.

### Interfaces
- Consumes `WorkspaceEvents::publish` (A2), `WorkspaceEvent::DocUpdated` (A1).
- `persistence::DocState` gains `pub workspace_id: Option<Uuid>` (deviation from the brief: the
  brief said "ADD workspace_id to what `load` returns OR look it up"; we add it to `DocState`,
  the cheaper option — the `documents` row is already being touched by `load`'s insert).
- `spawn_room` signature gains a trailing `workspace_events: WorkspaceEvents`.

### Steps

1. Write the failing test FIRST. The publish-on-persist behaviour is testable without Postgres
   by constructing a `Room` in volatile mode but with a `document_id`, a `workspace_id`, and a
   live `WorkspaceEvents` we subscribe to, then calling `persist`. Since `Room`/`persist` are
   private, add the test inside `room.rs`'s test module (create one if absent). Add at the
   bottom of `room.rs`:
   ```rust
   #[cfg(test)]
   mod tests {
       use super::*;
       use crate::events::WorkspaceEvents;
       use muesli_core::events::WorkspaceEvent;

       fn test_room(doc_id: &str, workspace_id: Option<Uuid>, hub: WorkspaceEvents) -> Room {
           Room {
               doc: MuesliDoc::new(),
               doc_id: doc_id.to_string(),
               clients: HashMap::new(),
               awareness: HashMap::new(),
               persistence: None, // volatile: persist() early-returns on the append, but...
               storage: None,
               links: None,
               document_id: None,
               workspace_id,
               workspace_events: hub,
               seq: 0,
               since_snapshot: 0,
               agent_client_id: 1,
               agent_clock: 0,
               agent_generation: 0,
           }
       }

       #[tokio::test]
       async fn persist_publishes_doc_updated_when_persistence_present() {
           // We cannot stand up Postgres here, so we test the PUBLISH path directly via the
           // helper `publish_doc_updated`, which persist() calls after a successful append.
           let hub = WorkspaceEvents::default();
           let ws = Uuid::now_v7();
           let mut rx = hub.subscribe(ws);
           let room = test_room("notes", Some(ws), hub);
           room.publish_doc_updated();
           let env = rx.try_recv().expect("an envelope was published");
           assert_eq!(env.origin, None);
           assert_eq!(env.event, WorkspaceEvent::DocUpdated { slug: "notes".into() });
       }

       #[tokio::test]
       async fn publish_doc_updated_is_silent_without_workspace_id() {
           let hub = WorkspaceEvents::default();
           let ws = Uuid::now_v7();
           let mut rx = hub.subscribe(ws);
           let room = test_room("notes", None, hub);
           room.publish_doc_updated(); // no workspace_id → nothing to publish
           assert!(rx.try_recv().is_err());
       }
   }
   ```

2. Run it — EXPECT FAIL (the `Room` struct has no `workspace_id`/`workspace_events` fields and
   no `publish_doc_updated` method):
   ```
   cargo test -p muesli-server room::tests
   ```
   Expected: compile errors `struct Room has no field named workspace_id` / `no method named
   publish_doc_updated`.

3. Add `workspace_id` to `DocState` + the `load` query. In `persistence.rs`, the struct
   (lines 17–23) becomes:
   ```rust
   /// Everything a room needs to hydrate.
   pub struct DocState {
       pub document_id: Uuid,
       pub workspace_id: Option<Uuid>,
       pub snapshot: Option<Vec<u8>>,
       pub tail: Vec<Vec<u8>>,
       pub last_seq: i64,
   }
   ```
   In `load` (line 286+), change the upsert to also return `workspace_id`:
   ```rust
   let row = sqlx::query(
       "insert into documents (slug) values ($1)
        on conflict (slug) do update set updated_at = now()
        returning id, workspace_id",
   )
   .bind(slug)
   .fetch_one(&self.pool)
   .await?;
   let document_id: Uuid = row.get("id");
   let workspace_id: Option<Uuid> = row.get("workspace_id");
   ```
   and the final return (line 320):
   ```rust
   Ok(DocState { document_id, workspace_id, snapshot, tail, last_seq })
   ```

4. Add the fields + helper to `Room`. In `room.rs`:
   - import the hub at the top (after `use crate::storage::StorageHandle;`):
     ```rust
     use crate::events::WorkspaceEvents;
     use muesli_core::events::{WorkspaceEvent, WorkspaceEventEnvelope};
     ```
   - add two fields to `struct Room` (after `document_id: Option<Uuid>,`, line 103):
     ```rust
     document_id: Option<Uuid>,
     /// The workspace this room's document belongs to (learned at hydrate); None in open mode
     /// or volatile. Needed to publish DocUpdated on the right stream.
     workspace_id: Option<Uuid>,
     /// Plan 4: per-workspace structure stream. `persist` publishes DocUpdated wake-pings here.
     workspace_events: WorkspaceEvents,
     ```
   - add the publish helper to `impl Room` (right after `persist`, before `on_join`):
     ```rust
     /// Publish a DocUpdated wake-ping for this room's document (Plan 4 Contract 1). Origin is
     /// None — this event is born inside the room, not from a daemon REST call. No-op when the
     /// room has no workspace (open mode / volatile) or no live subscribers.
     fn publish_doc_updated(&self) {
         let Some(ws) = self.workspace_id else { return };
         self.workspace_events.publish(
             ws,
             WorkspaceEventEnvelope {
                 origin: None,
                 event: WorkspaceEvent::DocUpdated { slug: self.doc_id.clone() },
             },
         );
     }
     ```

5. Initialize the fields in `run_room`. In the `Room { ... }` literal inside `run_room`
   (lines 120–137), add after `document_id: None,`:
   ```rust
   document_id: None,
   workspace_id: None,
   workspace_events,
   ```
   and add `workspace_events: WorkspaceEvents` as the parameter to `run_room` (and to
   `spawn_room`). Update both signatures:
   ```rust
   pub fn spawn_room(
       doc_id: String,
       persistence: Option<Arc<Persistence>>,
       storage: Option<StorageHandle>,
       links: Option<LinkHandle>,
       workspace_events: WorkspaceEvents,
   ) -> mpsc::UnboundedSender<RoomMsg> {
       let (tx, rx) = mpsc::unbounded_channel();
       tokio::spawn(run_room(doc_id, persistence, storage, links, workspace_events, rx));
       tx
   }
   ```
   ```rust
   async fn run_room(
       doc_id: String,
       persistence: Option<Arc<Persistence>>,
       storage: Option<StorageHandle>,
       links: Option<LinkHandle>,
       workspace_events: WorkspaceEvents,
       mut rx: mpsc::UnboundedReceiver<RoomMsg>,
   ) {
   ```

6. Learn `workspace_id` in `hydrate`. In `hydrate` (lines 191–222), in the `Ok(state)` arm,
   after `self.document_id = Some(state.document_id);` (line 208), add:
   ```rust
   self.workspace_id = state.workspace_id;
   ```

7. Publish on persist. In `persist` (lines 225–257), after the successful
   `p.append_update(...)` block — i.e. after the `if let Err(e) = ... { return; }` at lines
   234–237 and before the storage `mark_dirty` — add:
   ```rust
   // Plan 4: wake any cold daemon session watching this workspace so it pulls the new text.
   self.publish_doc_updated();
   ```
   Placement: it must be AFTER the early-return on append failure (so we only ping on a real
   append) and is fine before or after the storage/links dirty pings.

8. Thread the hub through `main.rs`. `ensure_room`/`ensure_room_in` (lines 306–330) must pass
   `state.workspace_events`. Update `ensure_room`:
   ```rust
   pub fn ensure_room(state: &AppState, slug: &str) -> mpsc::UnboundedSender<RoomMsg> {
       ensure_room_in(
           &state.rooms,
           &state.persistence,
           state.storage.as_ref().map(|m| m.handle()),
           state.links.clone(),
           state.workspace_events.clone(),
           slug,
       )
   }
   ```
   and `ensure_room_in`:
   ```rust
   pub fn ensure_room_in(
       rooms: &Rooms,
       persistence: &Option<Arc<Persistence>>,
       storage: Option<StorageHandle>,
       links: Option<LinkHandle>,
       workspace_events: WorkspaceEvents,
       slug: &str,
   ) -> mpsc::UnboundedSender<RoomMsg> {
       let mut rooms = rooms.lock().unwrap();
       rooms
           .entry(slug.to_string())
           .or_insert_with(|| {
               spawn_room(slug.to_string(), persistence.clone(), storage, links, workspace_events)
           })
           .clone()
   }
   ```

9. Fix the OTHER `ensure_room_in` caller: the storage manager. Find it:
   ```
   rg -n "ensure_room_in" crates/muesli-server/src
   ```
   In `storage.rs` (the `StorageManager` calls `ensure_room_in` directly per main.rs's doc
   comment), the manager must own a `WorkspaceEvents` to pass. The simplest correct threading:
   give `StorageManager::spawn` the hub. In `main.rs` line 153 the manager is constructed:
   ```rust
   Some(StorageManager::spawn(p.clone(), rooms.clone(), links.clone()))
   ```
   This runs BEFORE `state` exists, so create the hub first. At the top of `main` where `rooms`
   is created (line 132), add:
   ```rust
   let workspace_events = events::WorkspaceEvents::default();
   ```
   Pass it into the manager:
   ```rust
   Some(StorageManager::spawn(p.clone(), rooms.clone(), links.clone(), workspace_events.clone()))
   ```
   and into the state literal (replacing the `WorkspaceEvents::default()` added in A2 step 5):
   ```rust
   let state = AppState {
       persistence,
       auth,
       rooms,
       storage,
       links,
       workspace_events,
   };
   ```
   Then update `StorageManager::spawn` in `storage.rs` to accept and store `workspace_events:
   WorkspaceEvents`, and pass it at its internal `ensure_room_in` call sites. Mirror the existing
   `links: Option<LinkHandle>` field exactly: add a `workspace_events: WorkspaceEvents` field to
   `StorageManager`, set it from the new `spawn` arg, and forward
   `self.workspace_events.clone()` wherever it calls `ensure_room_in`. (Search shows the manager
   holds a `LinkHandle` clone already; copy that pattern verbatim.)

10. Build, EXPECT PASS:
    ```
    cargo build -p muesli-server
    ```
    Expected: `Finished`. (If `storage.rs` has more than one `ensure_room_in` call, the compiler
    error names each remaining one with the wrong arity — fix each by adding
    `self.workspace_events.clone()` in the same position.)

11. Run the room tests, EXPECT PASS:
    ```
    cargo test -p muesli-server room::tests
    ```
    Expected:
    ```
    test room::tests::persist_publishes_doc_updated_when_persistence_present ... ok
    test room::tests::publish_doc_updated_is_silent_without_workspace_id ... ok
    ```

12. Run the whole server test suite to catch any harness that called the changed signatures:
    ```
    cargo test -p muesli-server
    ```
    Expected: all green. Any e2e harness that constructed a `DocState` literal or called
    `spawn_room`/`ensure_room_in`/`StorageManager::spawn` directly must be updated to the new
    arity — the compiler points at each.

13. Clippy clean:
    ```
    cargo clippy -p muesli-server --tests
    ```
    Expected: no warnings.

14. Commit:
    ```
    git add crates/muesli-server/src/persistence.rs crates/muesli-server/src/room.rs crates/muesli-server/src/main.rs crates/muesli-server/src/storage.rs
    git commit -m "feat(server): room learns workspace_id and publishes DocUpdated wake-pings on persist"
    ```

---

## Phase A done-check

Run the full muesli test suite and clippy once at the end:
```
cargo test -p muesli-core && cargo test -p muesli-server && cargo clippy --workspace --tests
```
Expected: all tests pass, no clippy warnings. The server now exposes a membership-gated SSE
stream that carries folder + document structure events (origin-tagged from `x-muesli-client-id`)
and room-born `DocUpdated` wake-pings (origin None). Phase B (muesli-cli daemon) consumes it.
# Plan 4 — Phase B: Daemon bidirectional structure sync (muesli-cli)

Branch: `feat/cli-list-workspaces` (muesli repo). Build: plain `cargo` in the muesli
workspace (NO `DYLD_*` — that is demo_muesli only). Per-crate test/lint:
`cargo test -p muesli-cli <name>` / `cargo clippy -p muesli-cli --tests`.

**Conforms to** Architecture Brief Contracts 3, 4, 5, 6, 7. Phase A (muesli-core
`events` module + server SSE stream) is assumed merged ahead of Phase B; every task here
that touches `muesli_core::events::{WorkspaceEvent, WorkspaceEventEnvelope}` depends on
Phase A task A1 having landed.

Commit messages: NO `Co-Authored-By` trailer (Julian's repos).

> **Dependency notes you must apply as part of the relevant task (not separately):**
> - `uuid` is NOT yet a `muesli-cli` dependency (only the server has it). **B1** adds it.
> - `reqwest` in `muesli-cli` is `default-features = false, features = ["rustls-tls", "json"]`
>   — it has **no `stream` feature**. **B3** adds `"stream"`.
> - `futures-util` IS already a `muesli-cli` dependency (used by `session.rs`); B3 reuses it
>   for `StreamExt`/`bytes_stream` — no add needed.
> - `tokio` is `features = ["full"]` workspace-wide — `mpsc`, `time`, `select!` all available.

---

## Task 7 — (B1) workspace_id + client_id threading; `record_link` workspace column; `store::doc_path`

**Goal:** Thread an optional `workspace_id` and a generated per-run `client_id` (uuid) through
`sync::run`/`SyncDaemon`; add the (currently-unused-in-B) `events_tx` param to `sync::run`'s
signature now (Contract 7) so the CLI passes `None` and demo_muesli (Phase C) can pass a sender;
replace `store::record_link` with a 4-arg form that writes the `workspace` column; add
`store::doc_path`.

### Files
- `crates/muesli-cli/Cargo.toml` — add `uuid` dep.
- `crates/muesli-cli/src/store.rs` — `record_link` signature + `record_link_in` write of the
  `workspace` column; new `doc_path` / `doc_path_in`.
- `crates/muesli-cli/src/sync.rs` — `run` signature (+ `workspace_id`, + `events_tx`),
  `SyncDaemon` fields (`workspace_id`, `client_id`), `sync()` CLI wrapper, all `record_link`
  call sites (~131, ~408), and the `SessionCtx` construction in `session.rs` indirectly.
- `crates/muesli-cli/src/session.rs` — the `record_link` call site in `on_first_sync` (~152).

### Interfaces

**Produces** (store.rs):
```rust
/// Record (or update) the link for `file` → `doc` on `server`, tagging it with the owning
/// `workspace` (None in open mode / personal). REPLACES the old 3-arg `record_link`.
pub fn record_link(file: &Path, doc: &str, server: &str, workspace: Option<&str>) -> Result<()>;

/// Reverse lookup: the linked file path for `doc` on `server`, if any (scans links).
pub fn doc_path(doc: &str, server: &str) -> Option<PathBuf>;
```

**Produces** (sync.rs):
```rust
#[allow(clippy::too_many_arguments)]
pub async fn run(
    dir: PathBuf,
    server: String,
    prefix: Option<String>,
    web: String,
    verbose: bool,
    stop_rx: watch::Receiver<bool>,
    status_tx: watch::Sender<DaemonStatus>,
    control_rx: mpsc::UnboundedReceiver<DaemonControl>,
    workspace_id: Option<String>,
    events_tx: Option<mpsc::UnboundedSender<muesli_core::events::WorkspaceEventEnvelope>>,
) -> Result<()>;
```
- `events_tx` is **not consumed in Phase B** (it is wired in Phase C2). It is added to the
  signature now so the call sites are stable across phases. The CLI wrapper `sync()` passes
  `None, None`. Add a `let _ = &events_tx;` (or store it on `SyncDaemon` unused with
  `#[allow(dead_code)]`) so clippy does not warn — see steps.

**Consumes:** `uuid::Uuid::new_v4().to_string()` for `client_id`.

### TDD steps

1. **Add the `uuid` dependency.** Edit `crates/muesli-cli/Cargo.toml`, after the `dirs` line:
   ```toml
   # Per-run client-id (origin echo-guard, Plan 4 Contract 3) — string uuids only.
   uuid = { version = "1", features = ["v4"] }
   ```
   Run: `cargo build -p muesli-cli` → expect it compiles (no usage yet) with no new warnings.
   Expected tail: `Finished` … (a clean build).

2. **Write a failing store test for the workspace column + `doc_path`.** In
   `crates/muesli-cli/src/store.rs`, inside `mod tests`, add:
   ```rust
   #[test]
   fn records_workspace_and_resolves_doc_path() {
       let dir = tmp_dir("workspace-col");
       record_link_in(&dir, Path::new("/tmp/w.md"), "doc-w", "http://localhost:8787", Some("ws-1"))
           .unwrap();
       record_link_in(&dir, Path::new("/tmp/n.md"), "doc-n", "http://localhost:8787", None)
           .unwrap();

       let links = load_links_in(&dir).unwrap();
       let w = links.iter().find(|l| l.doc == "doc-w").unwrap();
       assert_eq!(w.workspace.as_deref(), Some("ws-1"));
       let n = links.iter().find(|l| l.doc == "doc-n").unwrap();
       assert_eq!(n.workspace, None);

       // reverse lookup by (doc, server)
       assert_eq!(
           doc_path_in(&dir, "doc-w", "http://localhost:8787").unwrap(),
           Some(PathBuf::from("/tmp/w.md"))
       );
       // wrong server → no hit
       assert_eq!(doc_path_in(&dir, "doc-w", "http://other").unwrap(), None);
       // unknown doc → None
       assert_eq!(doc_path_in(&dir, "nope", "http://localhost:8787").unwrap(), None);
       let _ = std::fs::remove_dir_all(&dir);
   }
   ```
   Run: `cargo test -p muesli-cli records_workspace_and_resolves_doc_path`
   Expected: **FAIL to compile** — `record_link_in` takes 4 args not 5, `Link` has no
   `workspace` field, `doc_path_in` does not exist. (e.g. `error[E0061]: this function takes 4
   arguments but 5 arguments were supplied`).

3. **Add the `workspace` field to `Link`.** In `store.rs`, extend the struct:
   ```rust
   #[derive(Clone)]
   pub struct Link {
       pub file: PathBuf,
       pub doc: String,
       pub server: String,
       /// Owning workspace id (None in open mode / personal / legacy rows).
       pub workspace: Option<String>,
       /// `datetime('now')` (UTC) of the last successful sync activity, if any.
       pub last_synced: Option<String>,
   }
   ```

4. **Read the `workspace` column in `load_links_in`.** Replace the SELECT + row mapping:
   ```rust
   fn load_links_in(dir: &Path) -> Result<Vec<Link>> {
       let conn = open_index_in(dir)?;
       let mut stmt = conn.prepare(
           "SELECT file_path, doc_id, server, workspace, last_synced_at FROM links ORDER BY file_path",
       )?;
       let rows = stmt.query_map([], |row| {
           Ok(Link {
               file: PathBuf::from(row.get::<_, String>(0)?),
               doc: row.get(1)?,
               server: row.get(2)?,
               workspace: row.get(3)?,
               last_synced: row.get(4)?,
           })
       })?;
       Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
   }
   ```
   (The `workspace` column already exists in `SCHEMA` — no migration needed.)

5. **Write the `workspace` column in `record_link_in`.** Replace it:
   ```rust
   fn record_link_in(
       dir: &Path,
       file: &Path,
       doc: &str,
       server: &str,
       workspace: Option<&str>,
   ) -> Result<()> {
       let _guard = STORE_LOCK.lock().unwrap();
       let conn = open_index_in(dir)?;
       conn.execute(
           "INSERT INTO links (file_path, doc_id, server, workspace) VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(file_path) DO UPDATE SET
              doc_id = excluded.doc_id, server = excluded.server, workspace = excluded.workspace",
           params![file.to_string_lossy(), doc, http_base(server), workspace],
       )?;
       drop(conn);
       write_mirror_in(dir)
   }
   ```

6. **Add `doc_path_in` + the public `doc_path`.** In `store.rs`, near `find_link`:
   ```rust
   fn doc_path_in(dir: &Path, doc: &str, server: &str) -> Result<Option<PathBuf>> {
       let server = http_base(server);
       Ok(load_links_in(dir)?
           .into_iter()
           .find(|l| l.doc == doc && l.server == server)
           .map(|l| l.file))
   }

   /// The linked file path for `doc` on `server`, if any.
   pub fn doc_path(doc: &str, server: &str) -> Option<PathBuf> {
       data_dir().and_then(|d| doc_path_in(&d, doc, server)).ok().flatten()
   }
   ```

7. **Update the public `record_link` wrapper.** Replace:
   ```rust
   pub fn record_link(file: &Path, doc: &str, server: &str, workspace: Option<&str>) -> Result<()> {
       record_link_in(&data_dir()?, file, doc, server, workspace)
   }
   ```

8. **Fix the existing store tests' `record_link_in` calls** (they pass 4 args). In
   `fresh_index_roundtrip_and_mirror`, `migrates_legacy_links_json` is untouched (uses raw
   JSON), and `rebind_moves_the_path_and_keeps_the_doc`, append `None` as the trailing arg:
   ```rust
   record_link_in(&dir, Path::new("/tmp/a.md"), "doc-a", "ws://localhost:8787/ws", None).unwrap();
   record_link_in(&dir, Path::new("/tmp/b.md"), "doc-b", "http://localhost:8787", None).unwrap();
   ```
   and
   ```rust
   record_link_in(&dir, Path::new("/tmp/old.md"), "kept-doc", "http://localhost:8787", None).unwrap();
   ```
   Run: `cargo test -p muesli-cli records_workspace_and_resolves_doc_path`
   Expected: **PASS** — `test store::tests::records_workspace_and_resolves_doc_path ... ok`.
   Run the whole store module to confirm no regression:
   `cargo test -p muesli-cli store::` → expected `test result: ok.` (all store tests pass).

9. **Update the `sync.rs` call sites of `record_link`.** There are two (the discovery loop
   ~line 131 and `on_new_file` ~line 408). The daemon now owns `workspace_id`; pass it through.
   At the discovery loop the daemon struct does not exist yet, so thread a local
   `let ws = workspace_id.as_deref();` captured before the loop (added in step 11). For now,
   change both calls to pass `self.workspace_id.as_deref()` (the `on_new_file` site has
   `&self`) and the discovery-loop site to pass the local `ws`:
   - discovery loop (~131): `store::record_link(file, &doc, &server, ws)?;`
   - `on_new_file` (~408): `store::record_link(&path, &doc, &self.server, self.workspace_id.as_deref())`

10. **Update the `session.rs` `record_link` call site** in `on_first_sync` (~152). `SessionCtx`
    does not carry a workspace, and `Open`-mode links are personal; pass `None`:
    ```rust
    if let Err(e) = store::record_link(&self.file, &self.doc_id, &self.server, None) {
        warn!(%e, "could not record the link in the local index");
    }
    ```
    (This is the `muesli open` path; sync-mode links are recorded via the daemon, not here.)

11. **Add `workspace_id` + `client_id` to `run`/`SyncDaemon` and the new `events_tx` param.**
    - Add the two trailing params to `run` (signature above). Right after `let token = …`:
      ```rust
      let client_id = uuid::Uuid::new_v4().to_string();
      let ws = workspace_id.as_deref();
      // events_tx is consumed in Phase C2 (forwarder); accept it now for a stable signature.
      let _ = &events_tx;
      ```
    - Add fields to `SyncDaemon`:
      ```rust
      struct SyncDaemon {
          dir: PathBuf,
          server: String,
          prefix: Option<String>,
          token: Option<String>,
          workspace_id: Option<String>,
          client_id: String,
          lazy: bool,
          // … unchanged …
      }
      ```
    - Populate them in the `SyncDaemon { … }` literal:
      ```rust
      workspace_id: workspace_id.clone(),
      client_id: client_id.clone(),
      ```
    - Update the CLI wrapper `sync()` to pass the two new args:
      ```rust
      run(dir, server, prefix, web, true, stop_rx, status_tx, control_rx, None, None).await
      ```

12. **Update `main.rs` `Cmd::Sync` dispatch** — `sync::sync` did not change its own signature,
    so `main.rs` needs no change here. (Confirm: `Cmd::Sync { dir, server, prefix, web } =>
    sync::sync(dir, server, prefix, web).await` is unchanged.) No edit required; note it.

13. **Lint + full build.**
    Run: `cargo clippy -p muesli-cli --tests`
    Expected: `Finished` with **no warnings** (the `let _ = &events_tx;` silences the unused
    binding; the new `SyncDaemon` fields are read in later tasks — if clippy flags
    `workspace_id`/`client_id` as never-read at this checkpoint, add a temporary
    `#[allow(dead_code)]` on those two fields with a `// read in B3/B5` comment; remove it in B5).
    Run: `cargo test -p muesli-cli` → expected `test result: ok.` for all existing tests.

14. **Commit.**
    ```
    git add -A && git commit -m "cli: thread workspace_id + client_id; record_link workspace column; store::doc_path"
    ```

---

## Task 8 — (B2) doc-id session keying fix (secondary `doc_index`)

**Goal:** `handles: HashMap<PathBuf, FileHandle>` is keyed by path only, so a rename/reclone
to a new path mints a SECOND `FileHandle` (and a second replica/session) for one doc. Add a
secondary `doc_index: HashMap<String, PathBuf>` (slug → current path) kept coherent with
`handles` across `spawn_file`/`on_removed`/`on_new_file`/Attach/Detach, so a doc resolves to its
SAME session after a rename. (This is the known deferred bug; it is also the lookup B4 uses to
wake a cold session on `DocUpdated`.)

### Files
- `crates/muesli-cli/src/sync.rs` — `SyncDaemon` (+ `doc_index`), `spawn_file`, `on_removed`,
  `on_new_file`, and the `DaemonControl::Attach`/`Detach` arms in `run`'s select loop.

### Interfaces
**Produces** (internal):
```rust
// On SyncDaemon:
doc_index: HashMap<String, PathBuf>, // doc slug → its current linked path
// helper:
fn handle_for_doc(&self, doc: &str) -> Option<&FileHandle>;
```
No public API change.

### TDD steps

1. **Write a failing test proving a rename leaves exactly one handle for one doc.** The session
   spawn touches the network, so test the *bookkeeping* in isolation via small pure helpers we
   are about to add. Add to `sync.rs` `mod tests`:
   ```rust
   // A path→doc / doc→path bookkeeping model identical to the daemon's, so the coherence
   // rules (rename rebinds in place, no duplicate doc entries) are unit-testable without a
   // live session/socket.
   #[test]
   fn rename_keeps_one_handle_per_doc() {
       let mut idx = DocIndex::default();
       let a = PathBuf::from("/root/a.md");
       let b = PathBuf::from("/root/b.md");

       idx.bind("doc-x".into(), a.clone());
       assert_eq!(idx.path_of("doc-x"), Some(&a));
       assert_eq!(idx.doc_count(), 1);

       // rename a.md → b.md for the SAME doc: old path drops, doc stays, new path binds.
       idx.rebind("doc-x", &a, b.clone());
       assert_eq!(idx.path_of("doc-x"), Some(&b));
       assert_eq!(idx.doc_count(), 1, "a rename must not leave two entries for one doc");
       assert_eq!(idx.docs_for_path(&a), 0, "old path no longer maps");
       assert_eq!(idx.docs_for_path(&b), 1);

       // removing the file drops the doc entry entirely.
       idx.unbind(&b);
       assert_eq!(idx.path_of("doc-x"), None);
       assert_eq!(idx.doc_count(), 0);
   }
   ```
   Run: `cargo test -p muesli-cli rename_keeps_one_handle_per_doc`
   Expected: **FAIL to compile** — `DocIndex` does not exist.

2. **Add the `DocIndex` helper.** This is the pure model the daemon delegates to (keeps both
   maps coherent in one place). Add near the top of `sync.rs` (above `SyncDaemon`):
   ```rust
   /// The doc-slug → current-path index, kept coherent with `handles` so a rename/reclone
   /// resolves to the SAME session instead of minting a second replica (Plan 4 B2).
   #[derive(Default)]
   struct DocIndex(HashMap<String, PathBuf>);

   impl DocIndex {
       fn bind(&mut self, doc: String, path: PathBuf) {
           self.0.insert(doc, path);
       }
       /// A rename of `doc` from `old` to `new_path`: only rebind if the index still points
       /// `doc` at `old` (defensive against stale events). Idempotent.
       fn rebind(&mut self, doc: &str, old: &Path, new_path: PathBuf) {
           if self.0.get(doc).is_some_and(|p| p == old) || !self.0.contains_key(doc) {
               self.0.insert(doc.to_string(), new_path);
           }
       }
       fn unbind(&mut self, path: &Path) {
           self.0.retain(|_, p| p != path);
       }
       fn path_of(&self, doc: &str) -> Option<&PathBuf> {
           self.0.get(doc)
       }
       fn doc_count(&self) -> usize {
           self.0.len()
       }
       fn docs_for_path(&self, path: &Path) -> usize {
           self.0.values().filter(|p| *p == path).count()
       }
   }
   ```
   Run: `cargo test -p muesli-cli rename_keeps_one_handle_per_doc`
   Expected: **PASS** — `test sync::tests::rename_keeps_one_handle_per_doc ... ok`.

3. **Add the field to `SyncDaemon`** (after `handles`):
   ```rust
   handles: HashMap<PathBuf, FileHandle>,
   doc_index: DocIndex,
   ```
   and in the `SyncDaemon { … }` literal in `run` add `doc_index: DocIndex::default(),`.

4. **Maintain `doc_index` in `spawn_file`.** At the end of `spawn_file`, alongside the
   `self.handles.insert(…)`:
   ```rust
   self.handles.insert(file.clone(), FileHandle { fs_tx, stop_tx, bridge_ctl: bridge_ctl_tx, doc: doc.clone() });
   self.doc_index.bind(doc, file);
   ```
   (Note `file`/`doc` are now moved last; reorder the prior uses — `file.clone()`/`doc.clone()`
   are already used to build `ctx`, so by here `file` and `doc` are still owned; clone into the
   `FileHandle` as shown and move the originals into `bind`.)

5. **Maintain `doc_index` in `on_removed`.** After the `handles.remove`:
   ```rust
   fn on_removed(&mut self, path: &Path) {
       if let Some(handle) = self.handles.remove(path) {
           let _ = handle.stop_tx.send(Stop::Drop);
           self.doc_index.unbind(path);
           println!(
               "- file removed: {} — kept #{} (server doc and index entry retained)",
               rel_label(&self.dir, path),
               handle.doc
           );
       }
   }
   ```

6. **Maintain `doc_index` on rebind in `on_new_file`.** In the `rebind_candidate` `Some(doc)`
   arm (the rename case), the OLD path's handle must be retired and the doc rebound to the new
   path BEFORE `spawn_file`. Replace that arm's body:
   ```rust
   Some(doc) => {
       // Rename: same content, old path gone → same Document identity. Retire any handle
       // still parked at the old path so we don't keep two sessions for one doc.
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
       doc
   }
   ```
   (`spawn_file` at the bottom of `on_new_file` then binds the new path; the explicit `rebind`
   here is belt-and-suspenders so the index is coherent even before the spawn.)

7. **Add the `handle_for_doc` accessor** (used by B4 to wake a cold session by slug):
   ```rust
   impl SyncDaemon {
       /// The live handle for a doc slug, via the secondary index (B2).
       fn handle_for_doc(&self, doc: &str) -> Option<&FileHandle> {
           self.doc_index.path_of(doc).and_then(|p| self.handles.get(p))
       }
   }
   ```
   It is unused until B4 — add `#[allow(dead_code)]` above the method with `// used in B4`.

8. **Attach/Detach coherence (run's select loop).** The Attach/Detach arms key off the canonical
   PATH already (`resolve_handle_key`), and `doc_index` maps doc→path, so attach/detach need no
   `doc_index` change — they operate on an existing handle. Add a one-line comment in each arm:
   `// doc_index unaffected: attach/detach reuse the existing path-keyed handle (B2).`
   (No behavioral change; this documents the audited invariant.)

9. **Lint + build.** Run: `cargo clippy -p muesli-cli --tests`
   Expected: `Finished`, no warnings (the `#[allow(dead_code)]` on `handle_for_doc` is removed
   in B4). Run: `cargo test -p muesli-cli sync::` → expected `test result: ok.`.

10. **Commit.**
    ```
    git add -A && git commit -m "cli: secondary doc-slug index so rename/reclone reuses one session (B2)"
    ```

---

## Task 9 — (B3) SSE consumer `api::subscribe_workspace_events`

**Goal:** A reqwest-streaming consumer of `GET /api/workspaces/{id}/events` that parses SSE
`data:` lines into `WorkspaceEventEnvelope`s, sends `x-muesli-client-id`, DROPS own-origin
envelopes, reconnects with backoff, and pushes survivors onto an mpsc the daemon select loop
drains (wired in B4). The risky bit — the byte-level SSE line parser — is split into a pure,
fully-tested function.

### Files
- `crates/muesli-cli/Cargo.toml` — add `"stream"` to reqwest features.
- `crates/muesli-cli/src/api.rs` — `parse_sse_chunk` (pure), `subscribe_workspace_events` (task).

### Interfaces
**Produces** (api.rs):
```rust
/// Spawn a background task that subscribes to the workspace SSE stream and pushes every
/// envelope whose `origin != client_id` onto `tx`. Reconnects with backoff on disconnect;
/// returns immediately (the task runs until `tx` is closed or the process ends).
pub fn subscribe_workspace_events(
    server: String,
    token: Option<String>,
    workspace_id: String,
    client_id: String,
    tx: tokio::sync::mpsc::UnboundedSender<muesli_core::events::WorkspaceEventEnvelope>,
);

/// Pure SSE framing: feed a growing buffer; returns the envelopes completed in it and the
/// unconsumed tail (a partial event still accumulating). Splits on the blank-line event
/// terminator and concatenates multiple `data:` lines per SSE spec; non-`data:` lines
/// (`:` comments / keep-alive, `event:`, `id:`) are ignored.
pub(crate) fn parse_sse_chunk(buf: &str) -> (Vec<muesli_core::events::WorkspaceEventEnvelope>, String);
```
**Consumes:** `reqwest::Client::get(...).bearer_auth(...).header("x-muesli-client-id", ...)
.send().await?.bytes_stream()`; `futures_util::StreamExt`; `muesli_core::events::*` (from A1).

### TDD steps

1. **Add reqwest `stream` feature.** Edit `crates/muesli-cli/Cargo.toml`:
   ```toml
   reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "json", "stream"] }
   ```
   Run: `cargo build -p muesli-cli` → expect a clean build (feature only; no usage yet).

2. **Write the failing SSE-parser test.** In `api.rs`, add a test module:
   ```rust
   #[cfg(test)]
   mod sse_tests {
       use super::parse_sse_chunk;

       #[test]
       fn parses_complete_events_and_keeps_partial_tail() {
           // two complete events + a partial third still accumulating
           let raw = "data: {\"origin\":\"c1\",\"kind\":\"doc_renamed\",\"slug\":\"notes\",\"title\":\"Notes\"}\n\n\
                      : keep-alive comment\n\n\
                      data: {\"kind\":\"folder_created\",\"id\":\"f1\",\"parent_id\":null,\"name\":\"Inbox\"}\n\n\
                      data: {\"kind\":\"doc_upda";
           let (events, tail) = parse_sse_chunk(raw);
           assert_eq!(events.len(), 2, "two complete events; the comment and partial are not events");
           assert_eq!(events[0].origin.as_deref(), Some("c1"));
           use muesli_core::events::WorkspaceEvent;
           assert_eq!(events[0].event, WorkspaceEvent::DocRenamed {
               slug: "notes".into(), title: Some("Notes".into())
           });
           assert_eq!(events[1].origin, None);
           assert_eq!(events[1].event, WorkspaceEvent::FolderCreated {
               id: "f1".into(), parent_id: None, name: "Inbox".into()
           });
           assert!(tail.starts_with("data: {\"kind\":\"doc_upda"), "partial event is returned as tail");
       }

       #[test]
       fn concatenates_multiline_data_and_skips_blank_payloads() {
           // SSE allows multiple data: lines in one event; they join with '\n'. Here the JSON
           // is split across two data: lines.
           let raw = "data: {\"kind\":\"doc_deleted\",\n\
                      data: \"slug\":\"gone\"}\n\n";
           let (events, tail) = parse_sse_chunk(raw);
           assert_eq!(tail, "");
           use muesli_core::events::WorkspaceEvent;
           assert_eq!(events.len(), 1);
           assert_eq!(events[0].event, WorkspaceEvent::DocDeleted { slug: "gone".into() });
       }

       #[test]
       fn ignores_unparseable_data_lines_without_losing_the_stream() {
           let raw = "data: not json\n\n\
                      data: {\"kind\":\"doc_updated\",\"slug\":\"live\"}\n\n";
           let (events, _tail) = parse_sse_chunk(raw);
           use muesli_core::events::WorkspaceEvent;
           assert_eq!(events.len(), 1, "a malformed event is dropped, the stream survives");
           assert_eq!(events[0].event, WorkspaceEvent::DocUpdated { slug: "live".into() });
       }
   }
   ```
   Run: `cargo test -p muesli-cli sse_tests`
   Expected: **FAIL to compile** — `parse_sse_chunk` does not exist. (Depends on A1's
   `muesli_core::events` being present; if A1 is not merged this also fails on the import — that
   is the documented Phase A prerequisite.)

3. **Implement `parse_sse_chunk`.** Add to `api.rs`:
   ```rust
   use muesli_core::events::WorkspaceEventEnvelope;

   /// Split an SSE buffer into completed envelopes + the unconsumed tail. An event ends at a
   /// blank line; within an event, every `data:` line's value is collected and joined with
   /// '\n' (SSE spec), then parsed as one `WorkspaceEventEnvelope`. Comments (`:`…), `event:`,
   /// `id:`, and unparseable payloads are skipped without breaking the stream.
   pub(crate) fn parse_sse_chunk(buf: &str) -> (Vec<WorkspaceEventEnvelope>, String) {
       let mut out = Vec::new();
       // The last "\n\n" marks the end of the final complete event; everything after is tail.
       let split_at = buf.rfind("\n\n").map(|i| i + 2);
       let (complete, tail) = match split_at {
           Some(i) => (&buf[..i], buf[i..].to_string()),
           None => return (out, buf.to_string()),
       };
       for block in complete.split("\n\n") {
           if block.is_empty() {
               continue;
           }
           let mut data = String::new();
           for line in block.lines() {
               if let Some(rest) = line.strip_prefix("data:") {
                   if !data.is_empty() {
                       data.push('\n');
                   }
                   data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
               }
               // `:`-comments, `event:`, `id:`, `retry:` → ignored.
           }
           if data.is_empty() {
               continue;
           }
           match serde_json::from_str::<WorkspaceEventEnvelope>(&data) {
               Ok(env) => out.push(env),
               Err(e) => warn!(%e, payload = %data, "skipping unparseable SSE event"),
           }
       }
       (out, tail)
   }
   ```
   (`warn!` is already imported via `tracing`? `api.rs` does not currently import tracing — add
   `use tracing::warn;` at the top of `api.rs`.)
   Run: `cargo test -p muesli-cli sse_tests`
   Expected: **PASS** — all three `sse_tests` ok.

4. **Implement `subscribe_workspace_events`.** Add to `api.rs`:
   ```rust
   use futures_util::StreamExt;

   /// Subscribe to the workspace SSE stream; push every non-own-origin envelope onto `tx`.
   /// Reconnects with capped exponential backoff; exits when `tx` is closed.
   pub fn subscribe_workspace_events(
       server: String,
       token: Option<String>,
       workspace_id: String,
       client_id: String,
       tx: tokio::sync::mpsc::UnboundedSender<WorkspaceEventEnvelope>,
   ) {
       tokio::spawn(async move {
           let url = format!("{}/api/workspaces/{}/events", http_base(&server), workspace_id);
           let client = reqwest::Client::new();
           let mut attempts: u32 = 0;
           loop {
               if tx.is_closed() {
                   return;
               }
               let mut req = client.get(&url).header("x-muesli-client-id", &client_id);
               if let Some(t) = &token {
                   req = req.bearer_auth(t);
               }
               match req.send().await.and_then(|r| r.error_for_status()) {
                   Ok(resp) => {
                       attempts = 0;
                       let mut stream = resp.bytes_stream();
                       let mut buf = String::new();
                       while let Some(chunk) = stream.next().await {
                           let Ok(bytes) = chunk else { break }; // disconnect → reconnect
                           buf.push_str(&String::from_utf8_lossy(&bytes));
                           let (events, tail) = parse_sse_chunk(&buf);
                           buf = tail;
                           for env in events {
                               // Origin echo-guard (Contract 3): drop our own mutations.
                               if env.origin.as_deref() == Some(client_id.as_str()) {
                                   continue;
                               }
                               if tx.send(env).is_err() {
                                   return; // consumer gone
                               }
                           }
                       }
                   }
                   Err(e) => {
                       warn!(%e, %url, "workspace events stream error");
                   }
               }
               // Backoff before reconnecting (2,4,…,30s).
               attempts = attempts.saturating_add(1);
               let delay = std::time::Duration::from_secs(2u64.pow(attempts.min(5)).min(30));
               tokio::time::sleep(delay).await;
           }
       });
   }
   ```

5. **Write a test for the own-origin drop at the parse level** (the network path is integration,
   not unit-tested; the drop predicate is the load-bearing logic — assert it directly). Add to
   `sse_tests`:
   ```rust
   #[test]
   fn own_origin_is_dropped_others_kept() {
       let raw = "data: {\"origin\":\"me\",\"kind\":\"doc_updated\",\"slug\":\"x\"}\n\n\
                  data: {\"origin\":\"peer\",\"kind\":\"doc_updated\",\"slug\":\"y\"}\n\n\
                  data: {\"kind\":\"doc_updated\",\"slug\":\"z\"}\n\n";
       let (events, _) = parse_sse_chunk(raw);
       let me = "me";
       let kept: Vec<_> = events
           .into_iter()
           .filter(|e| e.origin.as_deref() != Some(me))
           .collect();
       assert_eq!(kept.len(), 2, "own-origin dropped; peer + UI(None) kept");
   }
   ```
   Run: `cargo test -p muesli-cli sse_tests` → expected all `sse_tests` **PASS**.

6. **Lint + build.** Run: `cargo clippy -p muesli-cli --tests`
   Expected: `Finished`, no warnings. (`subscribe_workspace_events` is unused until B4 — if
   clippy flags it `dead_code`, add `#[allow(dead_code)]` above it with `// wired in B4`, removed
   in B4.)

7. **Commit.**
   ```
   git add -A && git commit -m "cli: SSE workspace-events consumer (streaming, origin filter, reconnect) + pure parser (B3)"
   ```

---

## Task 10 — (B4) `inbound_reconcile` idempotent convergence

**Goal:** Implement Contract 5 — the SSE event is a "reconcile now" trigger, not a delta. On
connect, debounced (~300ms) on each structural event, and on a ~30s safety tick, run
`inbound_reconcile`: pull/write/link/spawn remote-created docs, fs-rename + rebind remote
renames/moves, remove+stop+unlink remote deletes (ONLY for docs that had a server row and are now
trashed/absent), mkdir empty remote folders. `DocUpdated{slug}` wakes the cold session via the
B2 `doc_index`; else falls through to reconcile. Coexists with the existing outbound
`reconcile_loop`. The risky decision logic is a pure, unit-tested helper.

### Files
- `crates/muesli-cli/src/sync.rs` — `reconcile_actions` (pure), `inbound_reconcile` (applies
  actions; daemon method), the SSE consumer + debounce wiring in `run`'s select loop.

### Interfaces
**Produces** (sync.rs, internal):
```rust
/// One convergence action computed from the server's doc list vs the local link list.
#[derive(Debug, PartialEq, Eq)]
enum InboundAction {
    /// Remote create / move-in: doc not linked locally → pull + write at `dest` + link + spawn.
    Create { slug: String, dest: PathBuf },
    /// Remote rename/move: linked doc's desired path changed → fs rename `from`→`to` + rebind.
    Move { slug: String, from: PathBuf, to: PathBuf },
    /// Remote delete: a known-synced doc now trashed/absent on the server → remove + unlink.
    Delete { slug: String, path: PathBuf },
    /// An empty remote folder with no docs → mkdir (best-effort).
    Mkdir { path: PathBuf },
}

/// Pure decision: given the server's live docs (slug, desired relative path), the local links
/// (slug → current path), the set of slugs that were known-synced (had a server row), and the
/// set of empty remote folder relative paths → the actions to converge. `root` anchors all
/// relative paths.
fn reconcile_actions(
    root: &Path,
    server_docs: &[(String, PathBuf)],            // (slug, desired path rel to root)
    local_links: &[(String, PathBuf)],            // (slug, current absolute path)
    known_synced: &std::collections::HashSet<String>,
    empty_folders: &[PathBuf],                     // rel to root
) -> Vec<InboundAction>;
```

### TDD steps

1. **Write the failing pure-decision test.** Add to `sync.rs` `mod tests`:
   ```rust
   use std::collections::HashSet;

   fn p(root: &Path, rel: &str) -> PathBuf { root.join(rel) }

   #[test]
   fn reconcile_actions_cover_create_move_delete_mkdir() {
       let root = Path::new("/root");
       // server has: notes (root), moved (now under sub/), keepfresh (never-synced local stays)
       let server_docs = vec![
           ("notes".to_string(), PathBuf::from("notes.md")),
           ("moved".to_string(), PathBuf::from("sub/moved.md")),
       ];
       // locally: notes already at the right place; moved still at the OLD root path;
       // gone was linked + known-synced but no longer on the server; localnew never pushed.
       let local_links = vec![
           ("notes".to_string(), p(root, "notes.md")),
           ("moved".to_string(), p(root, "moved.md")),
           ("gone".to_string(), p(root, "gone.md")),
           ("localnew".to_string(), p(root, "localnew.md")),
       ];
       let known_synced: HashSet<String> =
           ["notes", "moved", "gone"].iter().map(|s| s.to_string()).collect();
       let empty_folders = vec![PathBuf::from("EmptyDir")];

       let mut acts = reconcile_actions(root, &server_docs, &local_links, &known_synced, &empty_folders);
       acts.sort_by_key(|a| format!("{a:?}"));

       // notes: in place → no action. moved: rename old→new. gone: delete (known-synced, absent).
       // localnew: NOT deleted (never on server). EmptyDir: mkdir.
       assert!(acts.contains(&InboundAction::Move {
           slug: "moved".into(), from: p(root, "moved.md"), to: p(root, "sub/moved.md"),
       }));
       assert!(acts.contains(&InboundAction::Delete { slug: "gone".into(), path: p(root, "gone.md") }));
       assert!(acts.contains(&InboundAction::Mkdir { path: p(root, "EmptyDir") }));
       assert!(!acts.iter().any(|a| matches!(a, InboundAction::Delete { slug, .. } if slug == "localnew")),
           "a never-synced local file is never deleted by inbound reconcile");
       assert!(!acts.iter().any(|a| matches!(a, InboundAction::Create { slug, .. } if slug == "notes")),
           "an already-linked, in-place doc needs no create");
   }

   #[test]
   fn reconcile_actions_create_for_remote_new() {
       let root = Path::new("/root");
       let server_docs = vec![("fresh".to_string(), PathBuf::from("dir/fresh.md"))];
       let local_links: Vec<(String, PathBuf)> = vec![];
       let known_synced = HashSet::new();
       let acts = reconcile_actions(root, &server_docs, &local_links, &known_synced, &[]);
       assert_eq!(acts, vec![InboundAction::Create {
           slug: "fresh".into(), dest: p(root, "dir/fresh.md"),
       }]);
   }
   ```
   Run: `cargo test -p muesli-cli reconcile_actions`
   Expected: **FAIL to compile** — `InboundAction` / `reconcile_actions` do not exist.

2. **Implement `InboundAction` + `reconcile_actions` (pure).** Add to `sync.rs`:
   ```rust
   #[derive(Debug, PartialEq, Eq)]
   enum InboundAction {
       Create { slug: String, dest: PathBuf },
       Move { slug: String, from: PathBuf, to: PathBuf },
       Delete { slug: String, path: PathBuf },
       Mkdir { path: PathBuf },
   }

   fn reconcile_actions(
       root: &Path,
       server_docs: &[(String, PathBuf)],
       local_links: &[(String, PathBuf)],
       known_synced: &HashSet<String>,
       empty_folders: &[PathBuf],
   ) -> Vec<InboundAction> {
       use std::collections::HashMap;
       let local: HashMap<&str, &PathBuf> =
           local_links.iter().map(|(s, p)| (s.as_str(), p)).collect();
       let server: HashSet<&str> = server_docs.iter().map(|(s, _)| s.as_str()).collect();
       let mut out = Vec::new();

       // Creates + moves, driven by the server's desired state.
       for (slug, rel) in server_docs {
           let dest = root.join(rel);
           match local.get(slug.as_str()) {
               None => out.push(InboundAction::Create { slug: slug.clone(), dest }),
               Some(cur) if **cur != dest => out.push(InboundAction::Move {
                   slug: slug.clone(),
                   from: (*cur).clone(),
                   to: dest,
               }),
               Some(_) => {} // already in place
           }
       }
       // Deletes: locally-linked, known-synced, and now absent on the server. Never touch a
       // never-synced local (pending first push).
       for (slug, path) in local_links {
           if !server.contains(slug.as_str()) && known_synced.contains(slug) {
               out.push(InboundAction::Delete { slug: slug.clone(), path: path.clone() });
           }
       }
       // Empty remote folders → mkdir.
       for rel in empty_folders {
           out.push(InboundAction::Mkdir { path: root.join(rel) });
       }
       out
   }
   ```
   Run: `cargo test -p muesli-cli reconcile_actions`
   Expected: **PASS** — both `reconcile_actions_*` tests ok.

3. **Add a desired-path helper** mirroring `place_item` but producing a path from server
   folder/title state. Add to `sync.rs`:
   ```rust
   /// The server's desired path (rel to root) for a doc: its folder chain + `<title>.md`
   /// (falling back to the slug when the title is empty/None). `folder_chain` maps a folder id
   /// to its ordered ancestor names.
   fn desired_rel_path(
       folder_id: Option<&str>,
       title: Option<&str>,
       slug: &str,
       folder_chain: &HashMap<String, Vec<String>>,
   ) -> PathBuf {
       let mut path = PathBuf::new();
       if let Some(fid) = folder_id {
           if let Some(names) = folder_chain.get(fid) {
               for n in names {
                   path.push(sanitize_segment(n));
               }
           }
       }
       let stem = title.filter(|t| !t.is_empty()).unwrap_or(slug);
       path.push(format!("{}.md", sanitize_segment(stem)));
       path
   }

   /// Filesystem-safe single path segment: strip separators and leading dots so a server
   /// title can never escape the synced root or create hidden entries.
   fn sanitize_segment(s: &str) -> String {
       let cleaned: String = s.chars().map(|c| if std::path::is_separator(c) { '-' } else { c }).collect();
       let cleaned = cleaned.trim_start_matches('.').trim();
       if cleaned.is_empty() { "untitled".into() } else { cleaned.to_string() }
   }
   ```
   Add a quick test:
   ```rust
   #[test]
   fn desired_rel_path_builds_folder_chain_and_sanitizes() {
       let mut chain = HashMap::new();
       chain.insert("f2".to_string(), vec!["Top".to_string(), "Sub".to_string()]);
       assert_eq!(
           desired_rel_path(Some("f2"), Some("My Note"), "slug", &chain),
           PathBuf::from("Top/Sub/My Note.md")
       );
       // path-escaping title is neutralized
       assert_eq!(
           desired_rel_path(None, Some("../evil"), "s", &HashMap::new()),
           PathBuf::from("-..-evil.md").iter().collect::<PathBuf>()
       );
       // empty title → slug
       assert_eq!(desired_rel_path(None, None, "fallback", &HashMap::new()), PathBuf::from("fallback.md"));
   }
   ```
   (If the escaping assertion is fiddly across platforms, assert instead
   `!desired_rel_path(None, Some("../evil"), "s", &HashMap::new()).to_string_lossy().contains("..")`.)
   Run: `cargo test -p muesli-cli desired_rel_path` → expected **PASS**.

4. **Implement `inbound_reconcile` (applies the actions).** This is the live method; it lists
   the server, builds the folder chain + desired paths (filtered to `workspace_id`), computes
   actions via the pure helper, and applies them. Add to `impl SyncDaemon`:
   ```rust
   /// Converge local disk toward the server's structure (Contract 5). Idempotent; safe to call
   /// on connect, on each debounced structural event, and on the safety tick.
   async fn inbound_reconcile(&mut self) {
       let (docs, folders) = match api::list_docs_and_folders(&self.server, self.token.as_deref()).await {
           Ok(v) => v,
           Err(e) => {
               warn!(%e, "inbound reconcile: list failed");
               return;
           }
       };
       // Filter to our workspace (client-side; Contract 4). None = open mode → keep all.
       let mine = |ws: &Option<String>| match (&self.workspace_id, ws) {
           (Some(want), Some(have)) => want == have,
           (Some(_), None) => false,
           (None, _) => true,
       };
       let folders: Vec<&api::FolderInfo> = folders.iter().filter(|f| mine(&f.workspace_id)).collect();
       let docs: Vec<&api::DocInfo> = docs.iter().filter(|d| mine(&d.workspace_id)).collect();

       // folder id → ordered ancestor names (root-first).
       let by_id: HashMap<&str, &api::FolderInfo> =
           folders.iter().map(|f| (f.id.as_str(), *f)).collect();
       let mut chain: HashMap<String, Vec<String>> = HashMap::new();
       for f in &folders {
           let mut names = Vec::new();
           let mut cur = Some(f.id.as_str());
           let mut guard = 0;
           while let Some(id) = cur {
               let Some(fi) = by_id.get(id) else { break };
               names.push(fi.name.clone());
               cur = fi.parent_id.as_deref();
               guard += 1;
               if guard > 64 { break; } // cycle guard
           }
           names.reverse();
           chain.insert(f.id.clone(), names);
       }

       let server_docs: Vec<(String, PathBuf)> = docs
           .iter()
           .map(|d| (d.slug.clone(), desired_rel_path(d.folder_id.as_deref(), d.title.as_deref(), &d.slug, &chain)))
           .collect();

       // Local links for THIS server.
       let server_base = store::http_base(&self.server);
       let links = store::load_links();
       let local_links: Vec<(String, PathBuf)> = links
           .iter()
           .filter(|l| l.server == server_base)
           .map(|l| (l.doc.clone(), l.file.clone()))
           .collect();
       // known-synced = the local link exists AND the doc currently has (or had) a server row.
       // We approximate "had a server row" as: the link's workspace tag is set (it was recorded
       // by the daemon after a server sync) OR the slug is present on the server now. A pristine
       // never-pushed local has no server row and is excluded from deletes.
       let server_slugs: HashSet<&str> = docs.iter().map(|d| d.slug.as_str()).collect();
       let known_synced: HashSet<String> = links
           .iter()
           .filter(|l| l.server == server_base)
           .filter(|l| l.workspace.is_some() || server_slugs.contains(l.doc.as_str()))
           .map(|l| l.doc.clone())
           .collect();

       // Folders that contain no docs → empty dirs to materialize.
       let nonempty: HashSet<&str> = docs.iter().filter_map(|d| d.folder_id.as_deref()).collect();
       let empty_folders: Vec<PathBuf> = folders
           .iter()
           .filter(|f| !nonempty.contains(f.id.as_str()))
           .filter_map(|f| chain.get(&f.id))
           .map(|names| names.iter().map(|n| sanitize_segment(n)).collect::<PathBuf>())
           .collect();

       let actions = reconcile_actions(&self.dir, &server_docs, &local_links, &known_synced, &empty_folders);
       for action in actions {
           self.apply_inbound(action).await;
       }
   }

   async fn apply_inbound(&mut self, action: InboundAction) {
       match action {
           InboundAction::Create { slug, dest } => {
               if dest.exists() {
                   return; // converged already (echo-safe)
               }
               let text = match api::doc_text(&self.server, self.token.as_deref(), &slug).await {
                   Ok(t) => t,
                   Err(e) => { warn!(%e, %slug, "inbound create: doc_text failed"); return; }
               };
               if let Some(parent) = dest.parent() {
                   let _ = std::fs::create_dir_all(parent);
               }
               if let Err(e) = crate::session::atomic_write(&dest, &text) {
                   warn!(%e, "inbound create: write failed"); return;
               }
               if let Err(e) = store::record_link(&dest, &slug, &self.server, self.workspace_id.as_deref()) {
                   warn!(%e, "inbound create: record_link failed");
               }
               println!("↓ remote new: {} → #{slug}", rel_label(&self.dir, &dest));
               self.spawn_file(dest, slug);
           }
           InboundAction::Move { slug, from, to } => {
               if !from.exists() || to.exists() {
                   return; // already converged
               }
               if let Some(parent) = to.parent() {
                   let _ = std::fs::create_dir_all(parent);
               }
               if let Err(e) = std::fs::rename(&from, &to) {
                   warn!(%e, "inbound move: fs rename failed"); return;
               }
               // Retire the old-path handle, rebind both the index and our maps to the new path.
               if let Some(h) = self.handles.remove(&from) {
                   let _ = h.stop_tx.send(Stop::Drop);
               }
               self.doc_index.rebind(&slug, &from, to.clone());
               if let Err(e) = store::rebind_link(&slug, &self.server, &to) {
                   warn!(%e, "inbound move: rebind_link failed");
               }
               println!("↓ remote move: {} → {}", rel_label(&self.dir, &from), rel_label(&self.dir, &to));
               self.spawn_file(to, slug);
           }
           InboundAction::Delete { slug, path } => {
               if let Some(h) = self.handles.remove(&path) {
                   let _ = h.stop_tx.send(Stop::Drop);
               }
               self.doc_index.unbind(&path);
               let _ = std::fs::remove_file(&path);
               let _ = store::remove_link(&path);
               println!("↓ remote delete: removed {} (#{slug})", rel_label(&self.dir, &path));
           }
           InboundAction::Mkdir { path } => {
               let _ = std::fs::create_dir_all(&path);
           }
       }
   }
   ```

5. **Wire the SSE consumer + debounce + tick into `run`'s select loop.** Before the loop, set up
   the channels and the consumer task (only when we have both a `workspace_id` and a token):
   ```rust
   // Inbound structure stream (Plan 4 B3/B4). Only meaningful for a real workspace; the CLI
   // open-mode/no-token path skips it.
   let (evt_tx, mut evt_rx) = mpsc::unbounded_channel::<muesli_core::events::WorkspaceEventEnvelope>();
   if let (Some(ws), Some(tok)) = (workspace_id.clone(), token.clone()) {
       api::subscribe_workspace_events(daemon.server.clone(), Some(tok), ws, client_id.clone(), evt_tx);
       daemon.inbound_reconcile().await; // converge once on connect
   }
   // Debounce structural events into a single reconcile; a periodic safety tick covers any miss.
   let mut reconcile_due: Option<tokio::time::Instant> = None;
   let mut safety = tokio::time::interval(Duration::from_secs(30));
   safety.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
   ```
   Add two arms to the existing `tokio::select!` (alongside `stop_rx`, `ev_rx`, `tick`,
   `control_rx`):
   ```rust
   Some(env) = evt_rx.recv() => {
       use muesli_core::events::WorkspaceEvent;
       match &env.event {
           // Content wake-ping: nudge the cold session via the B2 doc index; no structure change.
           WorkspaceEvent::DocUpdated { slug } => {
               if let Some(h) = daemon.handle_for_doc(slug) {
                   let _ = h.fs_tx.send(()); // wake it to reconnect + pull
               } else {
                   // No local session/link yet → treat as a structural cue, reconcile soon.
                   reconcile_due = Some(tokio::time::Instant::now() + Duration::from_millis(300));
               }
           }
           // Any structural event → debounced reconcile.
           _ => reconcile_due = Some(tokio::time::Instant::now() + Duration::from_millis(300)),
       }
       publish(&status_tx, &daemon, DaemonState::Running);
   }
   _ = async {
       match reconcile_due {
           Some(at) => tokio::time::sleep_until(at).await,
           None => std::future::pending().await,
       }
   }, if reconcile_due.is_some() => {
       reconcile_due = None;
       daemon.inbound_reconcile().await;
       publish(&status_tx, &daemon, DaemonState::Running);
   }
   _ = safety.tick() => {
       if daemon.workspace_id.is_some() && daemon.token.is_some() {
           daemon.inbound_reconcile().await;
       }
   }
   ```
   Remove the `#[allow(dead_code)]` added on `handle_for_doc` (B2 step 7) and on
   `subscribe_workspace_events` (B3 step 6) — they are now used.

6. **Lint + build.** Run: `cargo clippy -p muesli-cli --tests`
   Expected: `Finished`, no warnings. Run: `cargo test -p muesli-cli sync::` → expected
   `test result: ok.` (the new pure-decision tests + all prior).

7. **Commit.**
   ```
   git add -A && git commit -m "cli: inbound_reconcile idempotent convergence; SSE-driven + debounced + safety tick (B4)"
   ```

---

## Task 11 — (B5) outbound rename/move (place_document) + delete→trash; client-id header on all REST

**Goal:** Contract 6 — on a local rename/move rebind, PATCH the server doc's title+folder to the
new path; on a local delete, **trash** the server doc (only if it has a server row); add a
`client_id: &str` param (→ `x-muesli-client-id`) to every outbound REST helper, and a
`workspace_id: Option<&str>` to `create_folder` (Contract 4). Update `reconcile_loop`'s calls.

### Files
- `crates/muesli-cli/src/api.rs` — `create_folder` (+`client_id`, +`workspace_id`),
  `place_document` (+`client_id`), new `trash_document`.
- `crates/muesli-cli/src/sync.rs` — `reconcile_loop` calls; `on_removed` → outbound trash;
  `on_new_file` rebind → outbound `place_document`; thread `client_id`/`workspace_id` into the
  reconciler.

### Interfaces
**Produces** (api.rs):
```rust
pub async fn create_folder(
    server: &str, token: Option<&str>, client_id: &str,
    workspace_id: Option<&str>, name: &str, parent_id: Option<&str>,
) -> Result<String>;

pub async fn place_document(
    server: &str, token: Option<&str>, client_id: &str,
    slug: &str, folder_id: Option<&str>, title: &str,
) -> Result<()>;

/// Soft-delete (trash) a server doc. Reversible. `DELETE /api/documents/{slug}`.
pub async fn trash_document(
    server: &str, token: Option<&str>, client_id: &str, slug: &str,
) -> Result<()>;
```
All three send `x-muesli-client-id: <client_id>`. `create_folder` also sends `workspace_id` in
the JSON body so non-personal workspaces target correctly.

> **Behavior change (documented):** today a local delete keeps the server doc forever
> (`on_removed` only stops the session). B5 changes this to **trash** the server doc — but ONLY
> for docs with a server row (a known-synced doc); a never-pushed local delete still touches
> nothing on the server. Trash is reversible (soft-delete), matching the "never destructive"
> posture.

### TDD steps

1. **Write a failing api test for the new signatures + header wiring.** A live HTTP test is out
   of scope (no network in unit tests); instead assert the JSON body builder for `create_folder`
   includes `workspace_id`. Extract a tiny pure body helper and test it. Add to `api.rs`:
   ```rust
   #[cfg(test)]
   mod outbound_tests {
       use super::create_folder_body;
       #[test]
       fn create_folder_body_includes_workspace() {
           let b = create_folder_body("Inbox", Some("parent-1"), Some("ws-7"));
           assert_eq!(b["name"], "Inbox");
           assert_eq!(b["parent_id"], "parent-1");
           assert_eq!(b["workspace_id"], "ws-7");
           // open mode: workspace omitted entirely (null), parent null at root
           let b2 = create_folder_body("Top", None, None);
           assert!(b2["parent_id"].is_null());
           assert!(b2["workspace_id"].is_null());
       }
   }
   ```
   Run: `cargo test -p muesli-cli create_folder_body_includes_workspace`
   Expected: **FAIL to compile** — `create_folder_body` does not exist.

2. **Add the body helper + new `create_folder`.** In `api.rs`:
   ```rust
   /// JSON body for `POST /api/folders` (factored out so the workspace wiring is unit-tested).
   pub(crate) fn create_folder_body(
       name: &str, parent_id: Option<&str>, workspace_id: Option<&str>,
   ) -> serde_json::Value {
       json!({ "name": name, "parent_id": parent_id, "workspace_id": workspace_id })
   }

   /// Create a folder under `parent_id` (None = workspace root) in `workspace_id` (None =
   /// caller's personal/default). Tags the request with `client_id` for the echo guard.
   pub async fn create_folder(
       server: &str,
       token: Option<&str>,
       client_id: &str,
       workspace_id: Option<&str>,
       name: &str,
       parent_id: Option<&str>,
   ) -> Result<String> {
       let req = reqwest::Client::new()
           .post(format!("{}/api/folders", http_base(server)))
           .header("x-muesli-client-id", client_id)
           .json(&create_folder_body(name, parent_id, workspace_id));
       let res = auth(req, token).send().await?;
       if !res.status().is_success() {
           bail!("create folder failed ({}): {}", res.status(), res.text().await.unwrap_or_default());
       }
       Ok(res.json::<CreatedFolder>().await.context("parsing created folder")?.id)
   }
   ```
   Run: `cargo test -p muesli-cli create_folder_body_includes_workspace` → expected **PASS**.

3. **Add `client_id` to `place_document`.** Replace its builder line to add the header (signature
   above):
   ```rust
   pub async fn place_document(
       server: &str,
       token: Option<&str>,
       client_id: &str,
       slug: &str,
       folder_id: Option<&str>,
       title: &str,
   ) -> Result<()> {
       let req = reqwest::Client::new()
           .patch(format!("{}/api/documents/{}", http_base(server), slug))
           .header("x-muesli-client-id", client_id)
           .json(&json!({ "folder_id": folder_id, "title": title }));
       let res = auth(req, token).send().await?;
       if !res.status().is_success() {
           bail!("place document failed ({}): {}", res.status(), res.text().await.unwrap_or_default());
       }
       Ok(())
   }
   ```

4. **Add `trash_document`.** In `api.rs`:
   ```rust
   /// Soft-delete (trash) the server doc `slug` (reversible). `DELETE /api/documents/{slug}`.
   pub async fn trash_document(
       server: &str,
       token: Option<&str>,
       client_id: &str,
       slug: &str,
   ) -> Result<()> {
       let req = reqwest::Client::new()
           .delete(format!("{}/api/documents/{}", http_base(server), slug))
           .header("x-muesli-client-id", client_id);
       let res = auth(req, token).send().await?;
       if !res.status().is_success() {
           bail!("trash document failed ({}): {}", res.status(), res.text().await.unwrap_or_default());
       }
       Ok(())
   }
   ```
   Run: `cargo build -p muesli-cli` → expect compile errors at the OLD `create_folder` /
   `place_document` call sites in `sync.rs` (they pass the old arg count). That is expected; fix
   next.

5. **Thread `client_id` + `workspace_id` into `reconcile_loop`.** Change its signature and call
   sites. Signature:
   ```rust
   async fn reconcile_loop(
       server: String,
       token: Option<String>,
       client_id: String,
       workspace_id: Option<String>,
       places: Arc<Mutex<Vec<PlaceItem>>>,
       mut stop_rx: watch::Receiver<bool>,
   ) {
   ```
   Update the two API calls inside it:
   ```rust
   match api::create_folder(&server, token.as_deref(), &client_id, workspace_id.as_deref(), name, parent.as_deref()).await {
   ```
   ```rust
   match api::place_document(&server, token.as_deref(), &client_id, &item.slug, parent.as_deref(), &item.title).await {
   ```
   And the spawn in `run`:
   ```rust
   tokio::spawn(reconcile_loop(recon_server, recon_token, client_id.clone(), workspace_id.clone(), places, stop_rx.clone()));
   ```

6. **Outbound trash on `on_removed`.** `on_removed` is currently sync (no `.await`); the trash is
   async and best-effort, so spawn it. Change `on_removed` to look up whether the doc has a
   server row (known-synced) before trashing. Replace `on_removed`:
   ```rust
   fn on_removed(&mut self, path: &Path) {
       if let Some(handle) = self.handles.remove(path) {
           let _ = handle.stop_tx.send(Stop::Drop);
           self.doc_index.unbind(path);
           let doc = handle.doc.clone();
           // Trash the server doc — but only if it was actually pushed (has a server row).
           // A never-synced local (no workspace tag, absent on the server) touches nothing.
           let known_synced = store::find_link(path)
               .map(|l| l.workspace.is_some())
               .unwrap_or(false);
           if known_synced {
               let (server, token, client_id) =
                   (self.server.clone(), self.token.clone(), self.client_id.clone());
               let slug = doc.clone();
               tokio::spawn(async move {
                   if let Err(e) = api::trash_document(&server, token.as_deref(), &client_id, &slug).await {
                       warn!(%e, %slug, "outbound trash failed");
                   }
               });
               println!("- file removed: {} — trashed #{doc} on the server", rel_label(&self.dir, path));
           } else {
               println!("- file removed: {} — kept #{doc} (never pushed; nothing to trash)", rel_label(&self.dir, path));
           }
       }
   }
   ```
   > Note: `find_link(path)` runs AFTER `handles.remove` but the link row is still present
   > (deletes don't remove the index entry); `record_link` writes the `workspace` tag only after
   > a daemon sync, so `workspace.is_some()` is a sound "was pushed" proxy. (Open-mode/personal
   > syncs that legitimately have `workspace == None` are covered by the inbound reconcile's
   > additional `server_slugs` check; for the OUTBOUND delete we deliberately keep the
   > conservative "tagged ⇒ trash" rule to never trash something we are unsure about.)

7. **Outbound place on rebind in `on_new_file`.** In the rename arm (the `Some(doc)` branch
   already edited in B2), after the local rebind, PATCH the server doc to the new path. The new
   `PlaceItem` is computed at the end of `on_new_file` (`place_item(...)`); reuse it. After
   `self.places.lock().unwrap().push(place_item(&self.dir, &path, &doc));` and before
   `self.spawn_file`, add an outbound place for the rebind case. Simplest: always (re)place on a
   new/renamed file that is known-synced. Replace the tail of `on_new_file`:
   ```rust
   let item = place_item(&self.dir, &path, &doc);
   self.places.lock().unwrap().push(item.clone());
   // Outbound placement of a rename/move: PATCH title+folder to match the new path. Only for
   // docs already on the server (a fresh local is placed by the reconcile_loop after first push).
   if store::find_link(&path).map(|l| l.workspace.is_some()).unwrap_or(false) {
       let (server, token, client_id) =
           (self.server.clone(), self.token.clone(), self.client_id.clone());
       let folder_parent = self.resolve_folder_chain(&item).await;
       let (slug, title) = (item.slug.clone(), item.title.clone());
       if let Err(e) = api::place_document(&server, token.as_deref(), &client_id, &slug, folder_parent.as_deref(), &title).await {
           warn!(%e, %slug, "outbound place (rename) failed");
       }
   }
   self.spawn_file(path, doc);
   ```
   where `resolve_folder_chain` ensures the folder chain exists and returns the leaf folder id:
   ```rust
   impl SyncDaemon {
       /// Ensure `item`'s folder chain exists on the server (creating missing levels) and
       /// return the leaf folder id (None = root). Best-effort: on any error returns what it
       /// has so far (the reconcile_loop will retry placement).
       async fn resolve_folder_chain(&self, item: &PlaceItem) -> Option<String> {
           let (docs_folders) = api::list_docs_and_folders(&self.server, self.token.as_deref()).await.ok()?;
           let (_docs, folders) = docs_folders;
           let mut fmap: HashMap<(Option<String>, String), String> = folders
               .iter()
               .filter(|f| match (&self.workspace_id, &f.workspace_id) {
                   (Some(w), Some(h)) => w == h,
                   (Some(_), None) => false,
                   (None, _) => true,
               })
               .map(|f| ((f.parent_id.clone(), f.name.clone()), f.id.clone()))
               .collect();
           let mut parent: Option<String> = None;
           for name in &item.folders {
               let key = (parent.clone(), name.clone());
               let id = if let Some(id) = fmap.get(&key) {
                   id.clone()
               } else {
                   match api::create_folder(
                       &self.server, self.token.as_deref(), &self.client_id,
                       self.workspace_id.as_deref(), name, parent.as_deref(),
                   ).await {
                       Ok(id) => { fmap.insert(key, id.clone()); id }
                       Err(e) => { warn!(%e, name, "rename place: create folder failed"); return parent; }
                   }
               };
               parent = Some(id);
           }
           parent
       }
   }
   ```
   (The `let (docs_folders) =` line is written as a single binding to keep the tuple; adjust to
   `let (_docs, folders) = api::list_docs_and_folders(...).await.ok()?;` if clippy prefers — both
   compile; prefer the destructured form.)

8. **Build + lint.** Run: `cargo clippy -p muesli-cli --tests`
   Expected: `Finished`, no warnings. (Remove the temporary `#[allow(dead_code)]` from B1 step 13
   on `client_id`/`workspace_id` if it is still present — both fields are now read.)
   Run: `cargo test -p muesli-cli` → expected `test result: ok.` for ALL muesli-cli tests
   (store, sync, api, session, sse, outbound).

9. **Commit.**
   ```
   git add -A && git commit -m "cli: outbound rename->place_document + delete->trash_document; x-muesli-client-id on all REST (B5)"
   ```

---

## Cross-repo note for Phase C (do NOT do here)

- demo_muesli's `clone_workspace` calls `store::record_link(file, doc, server)` (3-arg) directly.
  After B1 it is the **4-arg** `record_link(file, doc, server, Some(&workspace_id))` — Phase C
  must update that call site (the clone already knows its `workspace_id` from the registry).
- demo_muesli's `sync_daemon/mod.rs` calls `sync::run(...)` — after B1 it gains two trailing args
  `workspace_id: Option<String>` and `events_tx: Option<UnboundedSender<WorkspaceEventEnvelope>>`.
  Phase C1 passes the real `workspace_id`; C2 passes a real `events_tx` (the forwarder sender).
# Phase C — demo_muesli client (branch `feat/auth-remote-workspaces`)

Conforms to Architecture Brief Contracts 1, 4, 7. Phase B has already landed (on its own
branch, to be merged before Phase C) the new `sync::run` signature with trailing
`workspace_id: Option<String>` then `events_tx: Option<UnboundedSender<WorkspaceEventEnvelope>>`
params, the 4-arg `store::record_link(file, doc, server, workspace: Option<&str>)`, and
`muesli_core::events::{WorkspaceEvent, WorkspaceEventEnvelope}`.

All commands below run from the demo_muesli repo root:
`/Users/julianbeaulieu/Code/demo_muesli`.

Rust tests use the macOS DYLD workaround (Swift runtime for ScreenCaptureKit linkage):

```
DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx cargo test --manifest-path src-tauri/Cargo.toml <name>
```

Frontend checks: `pnpm check` (svelte-kit sync + svelte-check, expect `0 errors`,
`0 warnings`) and `pnpm test` (vitest run).

Commit messages: NO `Co-Authored-By` trailer.

---

## Task 12 — (C1) Thread `workspace_id` end-to-end (clone → command → `DaemonHandle::start` → `sync::run`)

Threads the cloned workspace's id from the frontend through the `start_workspace_sync` command
into `DaemonHandle::start` and on into `sync::run`'s `workspace_id` param, and updates the
clone's `record_link` call to the Phase-B 4-arg form so links carry the `workspace` column.
(The `events_tx` trailing param of `sync::run` is wired in C2; here it stays `None`.)

### Files

- `/Users/julianbeaulieu/Code/demo_muesli/src-tauri/src/sync_daemon/mod.rs` — add `workspace_id` to `DaemonHandle::start`, pass to `sync::run`.
- `/Users/julianbeaulieu/Code/demo_muesli/src-tauri/src/sync_cmd.rs` — add `workspace_id: Option<String>` arg to the `start_workspace_sync` command.
- `/Users/julianbeaulieu/Code/demo_muesli/src-tauri/src/clone/mod.rs` — update the `store::record_link` call to the 4-arg form.
- `/Users/julianbeaulieu/Code/demo_muesli/src/lib/tauri.ts` — add `workspaceId` to the `startWorkspaceSync` binding.
- `/Users/julianbeaulieu/Code/demo_muesli/src/lib/sync/daemon.svelte.ts` — `start()` accepts and forwards `workspaceId`.
- `/Users/julianbeaulieu/Code/demo_muesli/src/lib/workspaces.svelte.ts` — pass `view.id` through `openFolderWithSync` into `daemon.start`.

### Interfaces

Consumes (from Phase B, already present):
- `muesli_cli::sync::run(dir, server, token: Option<String>, web, dev, stop_rx, status_tx, control_rx, workspace_id: Option<String>, events_tx: Option<tokio::sync::mpsc::UnboundedSender<muesli_core::events::WorkspaceEventEnvelope>>) -> anyhow::Result<()>`
- `muesli_cli::store::record_link(file: &Path, doc: &str, server: &str, workspace: Option<&str>) -> std::io::Result<()>`

Produces:
- `DaemonHandle::start(&self, dir: PathBuf, server: String, workspace_id: Option<String>)`
- Tauri command `start_workspace_sync(server: String, path: String, workspace_id: Option<String>, daemon: State<DaemonHandle>) -> Result<(), String>`
- `tauri.ts`: `startWorkspaceSync(server: string, path: string, workspaceId: string | null): Promise<void>`
- `daemon.svelte.ts`: `DaemonStore.start(server: string, path: string, workspaceId: string | null): Promise<void>`

### TDD steps

C1's deliverable is `workspace_id` threading; it adds NO signature test of its own. The
`DaemonHandle::start` arity is asserted by a single test that C2 owns (C2 changes the signature
again, so a C1-local arity test would only be churn). C1 is gated by the existing daemon-start
path compiling and the full src-tauri suite staying green after every call site is updated:
make all the edits, then run the existing suite as the regression gate.

1. **Add the param and thread it.** In `src-tauri/src/sync_daemon/mod.rs`,
   change `start`'s signature and the `sync::run` call. Replace:

   ```rust
       pub fn start(&self, dir: PathBuf, server: String) {
           let dir = dir.canonicalize().unwrap_or(dir);
   ```

   with:

   ```rust
       pub fn start(&self, dir: PathBuf, server: String, workspace_id: Option<String>) {
           let dir = dir.canonicalize().unwrap_or(dir);
   ```

   and replace the spawned task body:

   ```rust
           let task = tauri::async_runtime::spawn(async move {
               if let Err(e) =
                   sync::run(run_dir, server, None, web, false, stop_rx, status_tx, control_rx).await
               {
                   // `tracing` is not a direct dep of this crate; stderr surfaces in the
                   // `tauri dev` console (matches the clone module's error path).
                   eprintln!("workspace sync daemon error: {e:#}");
               }
           });
   ```

   with:

   ```rust
           let task = tauri::async_runtime::spawn(async move {
               if let Err(e) = sync::run(
                   run_dir,
                   server,
                   None,
                   web,
                   false,
                   stop_rx,
                   status_tx,
                   control_rx,
                   workspace_id,
                   None,
               )
               .await
               {
                   // `tracing` is not a direct dep of this crate; stderr surfaces in the
                   // `tauri dev` console (matches the clone module's error path).
                   eprintln!("workspace sync daemon error: {e:#}");
               }
           });
   ```

2. **Update the command caller.** In `src-tauri/src/sync_cmd.rs`, replace:

   ```rust
   /// Start (or switch to) the Tier-1 content-sync daemon over `path`.
   #[tauri::command]
   pub fn start_workspace_sync(
       server: String,
       path: String,
       daemon: State<'_, DaemonHandle>,
   ) -> Result<(), String> {
       daemon.start(PathBuf::from(path), server);
       Ok(())
   }
   ```

   with:

   ```rust
   /// Start (or switch to) the Tier-1 content-sync daemon over `path` for `workspace_id`
   /// (None = legacy / personal-default; the daemon then targets the personal workspace).
   #[tauri::command]
   pub fn start_workspace_sync(
       server: String,
       path: String,
       workspace_id: Option<String>,
       daemon: State<'_, DaemonHandle>,
   ) -> Result<(), String> {
       daemon.start(PathBuf::from(path), server, workspace_id);
       Ok(())
   }
   ```

3. **Update the clone's `record_link` call.** In `src-tauri/src/clone/mod.rs`, replace:

   ```rust
           store::record_link(&file, &item.slug, server)
               .with_context(|| format!("recording link for {}", item.slug))?;
   ```

   with:

   ```rust
           store::record_link(&file, &item.slug, server, Some(workspace_id))
               .with_context(|| format!("recording link for {}", item.slug))?;
   ```

   (`workspace_id: &str` is already the function's param, so `Some(workspace_id)` is `Option<&str>`.)

4. **Run the full src-tauri test suite, expect PASS** (regression gate — the workspace_id
   threading must not break any existing suite).

   ```
   DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx cargo test --manifest-path src-tauri/Cargo.toml
   ```

   Expected: `test result: ok.` for each suite, including
   `sync_daemon::tests::status_is_idle_before_start`,
   `clone::tests::filter_keeps_only_the_target_workspace`,
   and `editor_bridge::tests::register_then_take_roundtrips_sender`. `0 failed`.

5. **Update the TS binding.** In `src/lib/tauri.ts`, replace:

   ```ts
   export const startWorkspaceSync = (server: string, path: string): Promise<void> =>
     invoke("start_workspace_sync", { server, path });
   ```

   with:

   ```ts
   export const startWorkspaceSync = (
     server: string,
     path: string,
     workspaceId: string | null,
   ): Promise<void> =>
     invoke("start_workspace_sync", { server, path, workspaceId });
   ```

   (Tauri maps the JS key `workspaceId` to the Rust snake_case `workspace_id` arg.)

6. **Thread `workspaceId` through the daemon store.** In `src/lib/sync/daemon.svelte.ts`,
   replace:

   ```ts
     async start(server: string, path: string): Promise<void> {
       await startWorkspaceSync(server, path);
       this.#poll();
       if (!this.#timer) this.#timer = setInterval(() => this.#poll(), 1000);
     }
   ```

   with:

   ```ts
     async start(server: string, path: string, workspaceId: string | null): Promise<void> {
       await startWorkspaceSync(server, path, workspaceId);
       this.#poll();
       if (!this.#timer) this.#timer = setInterval(() => this.#poll(), 1000);
     }
   ```

   (The poll is retired in C3; this step only widens the signature so C1 type-checks.)

7. **Thread `view.id` through `openFolderWithSync`.** In `src/lib/workspaces.svelte.ts`,
    replace the signature and `daemon.start` call:

    ```ts
      /** Open a folder in the tree and, when it has a server, (re)start the Tier-1 daemon. */
      private async openFolderWithSync(path: string, server: string | null): Promise<void> {
        await workspace.openWorkspace(path);
        if (server) {
          await daemon.start(server, path); // start() stops any prior daemon (one at a time)
        } else {
          await daemon.stop();
        }
      }
    ```

    with:

    ```ts
      /** Open a folder in the tree and, when it has a server, (re)start the Tier-1 daemon. */
      private async openFolderWithSync(
        path: string,
        server: string | null,
        workspaceId: string | null,
      ): Promise<void> {
        await workspace.openWorkspace(path);
        if (server) {
          await daemon.start(server, path, workspaceId); // start() stops any prior daemon
        } else {
          await daemon.stop();
        }
      }
    ```

    Then update the two callers of `openFolderWithSync` in `openWorkspaceView`. Replace:

    ```ts
          this.cloning = false;
          await this.openFolderWithSync(chosenPath, view.server);
          await this.refresh();
          return;
        }
        // Already-local (cloned or local-only).
        if (view.local_path) {
          await this.openFolderWithSync(view.local_path, view.server);
        }
    ```

    with:

    ```ts
          this.cloning = false;
          await this.openFolderWithSync(chosenPath, view.server, view.id);
          await this.refresh();
          return;
        }
        // Already-local (cloned or local-only).
        if (view.local_path) {
          await this.openFolderWithSync(view.local_path, view.server, view.id);
        }
    ```

    (`view.id` is the workspace registry id — the cloned workspace's id — per
    `WorkspaceView.id` in `tauri.ts`.)

8. **Run frontend checks, expect PASS.**

    ```
    pnpm check
    ```

    Expected: `svelte-check found 0 errors and 0 warnings`.

    ```
    pnpm test
    ```

    Expected: vitest `passed` with `0 failed` (no test files changed; existing suites green).

9. **Commit.**

    ```
    git add -A && git commit -m "demo_muesli: thread workspace_id into start_workspace_sync and clone links"
    ```

---

## Task 13 — (C2) Daemon→frontend structure-event forwarding (`events_tx` + forwarder + `onStructureEvent`)

Wires the second output channel of `sync::run`: `DaemonHandle::start` creates an
`mpsc::UnboundedSender<WorkspaceEventEnvelope>`, passes it as `sync::run`'s `events_tx`, and
spawns a forwarder task (mirroring `editor_bridge::spawn_forwarder`) that drains the receiver
and `app.emit("workspace://structure", envelope)`. `start` gains an `AppHandle` (the
`start_workspace_sync` command already has `AppHandle` available via Tauri injection — same as
`attach_editor`). Adds the TS mirror types and `onStructureEvent` to `tauri.ts`.

### Files

- `/Users/julianbeaulieu/Code/demo_muesli/src-tauri/src/sync_daemon/mod.rs` — `start` takes `AppHandle`; create `events_tx`; spawn the structure forwarder; pass `Some(events_tx)` to `sync::run`.
- `/Users/julianbeaulieu/Code/demo_muesli/src-tauri/src/sync_cmd.rs` — `start_workspace_sync` injects `AppHandle` and passes it to `start`.
- `/Users/julianbeaulieu/Code/demo_muesli/src/lib/tauri.ts` — add `WorkspaceEvent`, `WorkspaceEventEnvelope` types and `onStructureEvent`.

### Interfaces

Consumes:
- `muesli_core::events::WorkspaceEventEnvelope` (Phase A; serde `Serialize`, with `#[serde(flatten)]` event + optional `origin`).
- `sync::run(..., events_tx: Option<tokio::sync::mpsc::UnboundedSender<WorkspaceEventEnvelope>>)` (Phase B trailing param).
- `tauri::{AppHandle, Emitter as _}` (same imports `editor_bridge` uses).

Produces:
- `DaemonHandle::start(&self, app: AppHandle, dir: PathBuf, server: String, workspace_id: Option<String>)`
- Tauri event `"workspace://structure"` carrying a `WorkspaceEventEnvelope` JSON payload.
- `tauri.ts`: `WorkspaceEvent`, `WorkspaceEventEnvelope` types; `onStructureEvent(handler: (evt: WorkspaceEventEnvelope) => void): Promise<() => void>`.

### TDD steps

1. **Failing Rust test for the new `start` arity.** This is the single arity test for
   `DaemonHandle::start` (C1 added none). Append to the `#[cfg(test)] mod tests` block in
   `src-tauri/src/sync_daemon/mod.rs`:

   ```rust
   #[test]
   fn start_signature_takes_app_handle_and_workspace_id() {
       let h = DaemonHandle::new();
       // Type-level assertion: `start` takes (AppHandle, PathBuf, String, Option<String>).
       let _f: fn(&DaemonHandle, tauri::AppHandle, std::path::PathBuf, String, Option<String>) =
           DaemonHandle::start;
       assert!(!h.status().running);
   }
   ```

2. **Run it, expect FAIL (compile error — `start` is still `AppHandle`-less / 3-arg from C1).**

   ```
   DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx cargo test --manifest-path src-tauri/Cargo.toml start_signature_takes_app_handle
   ```

   Expected: `error[E0308]: mismatched types` on the `_f` assignment. Build fails.

3. **Minimal impl — add `AppHandle`, the events channel, and the forwarder.** In
   `src-tauri/src/sync_daemon/mod.rs`, update the imports at the top. Replace:

   ```rust
   use muesli_cli::store;
   use muesli_cli::sync::{self, DaemonState, DaemonStatus};
   use serde::Serialize;
   use tokio::sync::{mpsc, watch};
   ```

   with:

   ```rust
   use muesli_cli::store;
   use muesli_cli::sync::{self, DaemonState, DaemonStatus};
   use muesli_core::events::WorkspaceEventEnvelope;
   use serde::Serialize;
   use tauri::{AppHandle, Emitter as _};
   use tokio::sync::{mpsc, watch};
   ```

   Then replace the whole `start` method body. Replace:

   ```rust
       pub fn start(&self, dir: PathBuf, server: String, workspace_id: Option<String>) {
           let dir = dir.canonicalize().unwrap_or(dir);
           let mut guard = self.inner.lock().unwrap();
           if guard.as_ref().is_some_and(|r| r.dir == dir) {
               return; // already syncing this workspace
           }
           if let Some(prev) = guard.take() {
               let _ = prev.stop_tx.send(true);
               // Don't abort: stop_tx signals a clean (flushing) shutdown; dropping `prev`
               // detaches the handle so the task finishes flushing in the background.
           }
           let (stop_tx, stop_rx) = watch::channel(false);
           let (status_tx, status_rx) = watch::channel(DaemonStatus::default());
           let (control_tx, control_rx) = mpsc::unbounded_channel::<muesli_cli::sync::DaemonControl>();
           let web = store::http_base(&server);
           let run_dir = dir.clone();
           let task = tauri::async_runtime::spawn(async move {
               if let Err(e) = sync::run(
                   run_dir,
                   server,
                   None,
                   web,
                   false,
                   stop_rx,
                   status_tx,
                   control_rx,
                   workspace_id,
                   None,
               )
               .await
               {
                   // `tracing` is not a direct dep of this crate; stderr surfaces in the
                   // `tauri dev` console (matches the clone module's error path).
                   eprintln!("workspace sync daemon error: {e:#}");
               }
           });
           *guard = Some(Running { dir, stop_tx, status_rx, control_tx, _task: task });
       }
   ```

   with:

   ```rust
       pub fn start(
           &self,
           app: AppHandle,
           dir: PathBuf,
           server: String,
           workspace_id: Option<String>,
       ) {
           let dir = dir.canonicalize().unwrap_or(dir);
           let mut guard = self.inner.lock().unwrap();
           if guard.as_ref().is_some_and(|r| r.dir == dir) {
               return; // already syncing this workspace
           }
           if let Some(prev) = guard.take() {
               let _ = prev.stop_tx.send(true);
               // Don't abort: stop_tx signals a clean (flushing) shutdown; dropping `prev`
               // detaches the handle so the task finishes flushing in the background.
           }
           let (stop_tx, stop_rx) = watch::channel(false);
           let (status_tx, status_rx) = watch::channel(DaemonStatus::default());
           let (control_tx, control_rx) = mpsc::unbounded_channel::<muesli_cli::sync::DaemonControl>();
           // Structure events: the daemon publishes WorkspaceEventEnvelopes here; the forwarder
           // task below drains them and re-emits as `workspace://structure` Tauri events for the
           // sidebar to refresh on (mirrors editor_bridge::spawn_forwarder for `editor://frame`).
           let (events_tx, events_rx) = mpsc::unbounded_channel::<WorkspaceEventEnvelope>();
           spawn_structure_forwarder(app, events_rx);
           let web = store::http_base(&server);
           let run_dir = dir.clone();
           let task = tauri::async_runtime::spawn(async move {
               if let Err(e) = sync::run(
                   run_dir,
                   server,
                   None,
                   web,
                   false,
                   stop_rx,
                   status_tx,
                   control_rx,
                   workspace_id,
                   Some(events_tx),
               )
               .await
               {
                   // `tracing` is not a direct dep of this crate; stderr surfaces in the
                   // `tauri dev` console (matches the clone module's error path).
                   eprintln!("workspace sync daemon error: {e:#}");
               }
           });
           *guard = Some(Running { dir, stop_tx, status_rx, control_tx, _task: task });
       }
   ```

   Then add the free function `spawn_structure_forwarder` just above the
   `impl Default for DaemonHandle` block (after the `impl DaemonHandle { ... }` closes):

   ```rust
   /// Drain the daemon's structure-event channel and re-emit each envelope to the frontend as a
   /// `workspace://structure` Tauri event until the channel closes (daemon stop / restart).
   /// Mirrors `editor_bridge::spawn_forwarder`'s `editor://frame` pump.
   fn spawn_structure_forwarder(
       app: AppHandle,
       mut events_rx: mpsc::UnboundedReceiver<WorkspaceEventEnvelope>,
   ) {
       tauri::async_runtime::spawn(async move {
           while let Some(envelope) = events_rx.recv().await {
               if let Err(e) = app.emit("workspace://structure", envelope) {
                   eprintln!("sync_daemon: structure emit failed: {e}");
                   break;
               }
           }
       });
   }
   ```

4. **Update the command to inject and pass `AppHandle`.** In `src-tauri/src/sync_cmd.rs`,
   `AppHandle` is already imported (`use tauri::{AppHandle, State};`). Replace:

   ```rust
   #[tauri::command]
   pub fn start_workspace_sync(
       server: String,
       path: String,
       workspace_id: Option<String>,
       daemon: State<'_, DaemonHandle>,
   ) -> Result<(), String> {
       daemon.start(PathBuf::from(path), server, workspace_id);
       Ok(())
   }
   ```

   with:

   ```rust
   #[tauri::command]
   pub fn start_workspace_sync(
       app: AppHandle,
       server: String,
       path: String,
       workspace_id: Option<String>,
       daemon: State<'_, DaemonHandle>,
   ) -> Result<(), String> {
       daemon.start(app, PathBuf::from(path), server, workspace_id);
       Ok(())
   }
   ```

   (Tauri injects `app: AppHandle` automatically — it is not a JS-supplied arg, exactly like
   `attach_editor`. The `tauri.ts` `startWorkspaceSync` binding from C1 is unchanged.)

5. **Run the src-tauri suite, expect PASS.**

   ```
   DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx cargo test --manifest-path src-tauri/Cargo.toml
   ```

   Expected: `test result: ok.`; includes
   `sync_daemon::tests::start_signature_takes_app_handle_and_workspace_id` and
   `sync_daemon::tests::status_is_idle_before_start`. `0 failed`.

6. **Commit the Rust side.**

   ```
   git add -A && git commit -m "demo_muesli: forward daemon structure events to frontend via workspace://structure"
   ```

7. **Add the TS mirror types + `onStructureEvent`.** In `src/lib/tauri.ts`, append after the
   `onEditorFrame` function (end of file):

   ```ts

   // ─── Structure-event stream (Plan 4): daemon → frontend sidebar refresh ──────

   /** Mirror of Rust `muesli_core::events::WorkspaceEvent` (serde tag = "kind", snake_case). */
   export type WorkspaceEvent =
     | { kind: "folder_created"; id: string; parent_id: string | null; name: string }
     | { kind: "folder_renamed"; id: string; name: string }
     | { kind: "folder_moved"; id: string; parent_id: string | null }
     | { kind: "folder_deleted"; id: string }
     | { kind: "doc_created"; slug: string; folder_id: string | null; title: string | null }
     | { kind: "doc_renamed"; slug: string; title: string | null }
     | { kind: "doc_moved"; slug: string; folder_id: string | null }
     | { kind: "doc_deleted"; slug: string }
     | { kind: "doc_updated"; slug: string };

   /**
    * Mirror of Rust `WorkspaceEventEnvelope`: the event (flattened) plus the optional
    * origin client-id that caused it. `origin` is null for UI/unknown-origin events.
    */
   export type WorkspaceEventEnvelope = WorkspaceEvent & { origin?: string | null };

   /**
    * Subscribe to `workspace://structure` events from the Tauri backend.
    * Calls `handler` with each incoming envelope. Returns a cleanup function that
    * removes the listener. Mirrors `onEditorFrame`.
    */
   export async function onStructureEvent(
     handler: (evt: WorkspaceEventEnvelope) => void,
   ): Promise<() => void> {
     const unlisten = await listen<WorkspaceEventEnvelope>(
       "workspace://structure",
       (event) => {
         handler(event.payload);
       },
     );
     return unlisten;
   }
   ```

   (`origin` flattens alongside the event because Rust uses `#[serde(flatten)]` on `event`; the
   intersection type `WorkspaceEvent & { origin? }` matches the on-the-wire shape.)

8. **Run frontend checks, expect PASS.**

   ```
   pnpm check
   ```

   Expected: `svelte-check found 0 errors and 0 warnings`.

   ```
   pnpm test
   ```

   Expected: vitest `passed`, `0 failed`.

9. **Commit the TS side.**

   ```
   git add -A && git commit -m "demo_muesli: add onStructureEvent and WorkspaceEvent TS mirror types"
   ```

---

## Task 14 — (C3) Retire the 1s poll; subscribe to push events; debounced tree refresh

Rewrites `daemon.svelte.ts`'s `DaemonStore`: remove the recurring `setInterval`. On `start()`:
call `startWorkspaceSync`, do ONE `workspaceSyncStatus()` to populate `status`, then subscribe
via `onStructureEvent`. On each *structural* event (folder_*/doc_created/doc_renamed/doc_moved/
doc_deleted — NOT `doc_updated`, which is content-only) call `workspace.refresh()` debounced
~150ms. On `stop()`: unsubscribe + clear `status`. Preserves Plan 3's value-stable
`daemonRunning` (`status` set once on start, never reassigned per-second).

### Files

- `/Users/julianbeaulieu/Code/demo_muesli/src/lib/sync/daemon.svelte.ts` — rewrite `DaemonStore`.

### Interfaces

Consumes:
- `startWorkspaceSync(server, path, workspaceId)` (C1), `stopWorkspaceSync()`, `workspaceSyncStatus()`.
- `onStructureEvent(handler): Promise<() => void>` and type `WorkspaceEventEnvelope` (C2).
- `workspace.refresh(): Promise<void>` (`$lib/workspace.svelte`).

Produces:
- `DaemonStore.start(server: string, path: string, workspaceId: string | null): Promise<void>` (push-subscribing, no timer).
- `DaemonStore.stop(): Promise<void>` (unsubscribes; clears `status`).
- `daemon.status` is set ONCE on `start()` and never reassigned on a recurring timer.

### TDD steps

This module drives Tauri IPC and a Svelte rune (`$state`), neither of which runs under the
plain vitest node env, so the test asserts the *behavioral contract* with mocks: structural
events trigger a debounced `workspace.refresh()`; `doc_updated` does NOT; and `status` is set
exactly once (no recurring reassignment). We inject the dependencies through module mocks.

1. **Failing test.** Create `src/lib/sync/daemon.svelte.test.ts`:

   ```ts
   import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

   // Capture the structure-event handler the store registers so the test can drive it.
   let structureHandler: ((evt: any) => void) | null = null;
   const unlisten = vi.fn();

   const startWorkspaceSync = vi.fn(async () => {});
   const stopWorkspaceSync = vi.fn(async () => {});
   const workspaceSyncStatus = vi.fn(async () => ({
     running: true,
     dir: "/ws",
     files: 3,
     last_activity: null,
     events: 0,
     error: null,
   }));
   const onStructureEvent = vi.fn(async (h: (evt: any) => void) => {
     structureHandler = h;
     return unlisten;
   });
   const refresh = vi.fn(async () => {});

   vi.mock("$lib/tauri", () => ({
     startWorkspaceSync,
     stopWorkspaceSync,
     workspaceSyncStatus,
     onStructureEvent,
   }));
   vi.mock("$lib/workspace.svelte", () => ({ workspace: { refresh } }));

   // Import AFTER the mocks are registered.
   const { daemon } = await import("./daemon.svelte");

   describe("DaemonStore push subscription", () => {
     beforeEach(() => {
       vi.useFakeTimers();
       structureHandler = null;
       startWorkspaceSync.mockClear();
       workspaceSyncStatus.mockClear();
       onStructureEvent.mockClear();
       unlisten.mockClear();
       refresh.mockClear();
     });
     afterEach(() => {
       vi.useRealTimers();
     });

     it("populates status once and subscribes on start (no recurring poll)", async () => {
       await daemon.start("http://s", "/ws", "w1");
       expect(startWorkspaceSync).toHaveBeenCalledWith("http://s", "/ws", "w1");
       expect(workspaceSyncStatus).toHaveBeenCalledTimes(1);
       expect(onStructureEvent).toHaveBeenCalledTimes(1);
       // Advance well past any old 1s poll interval: status must NOT be re-fetched.
       await vi.advanceTimersByTimeAsync(5000);
       expect(workspaceSyncStatus).toHaveBeenCalledTimes(1);
       await daemon.stop();
     });

     it("debounces a structural event into a single workspace.refresh()", async () => {
       await daemon.start("http://s", "/ws", "w1");
       refresh.mockClear();
       structureHandler!({ kind: "doc_created", slug: "a", folder_id: null, title: "A" });
       structureHandler!({ kind: "folder_renamed", id: "f1", name: "F" });
       expect(refresh).not.toHaveBeenCalled(); // still within debounce window
       await vi.advanceTimersByTimeAsync(200);
       expect(refresh).toHaveBeenCalledTimes(1); // coalesced
       await daemon.stop();
     });

     it("ignores doc_updated (content-only, not structural)", async () => {
       await daemon.start("http://s", "/ws", "w1");
       refresh.mockClear();
       structureHandler!({ kind: "doc_updated", slug: "a" });
       await vi.advanceTimersByTimeAsync(200);
       expect(refresh).not.toHaveBeenCalled();
       await daemon.stop();
     });

     it("unsubscribes and clears status on stop", async () => {
       await daemon.start("http://s", "/ws", "w1");
       await daemon.stop();
       expect(unlisten).toHaveBeenCalledTimes(1);
       expect(stopWorkspaceSync).toHaveBeenCalledTimes(1);
       expect(daemon.status).toBeNull();
     });
   });
   ```

2. **Run it, expect FAIL.**

   ```
   pnpm test -- daemon.svelte
   ```

   Expected: failures — current `DaemonStore.start` has the old 2-arg signature and no
   `onStructureEvent`/debounce, so `onStructureEvent` is never called, `workspaceSyncStatus`
   keeps polling on the 1s timer (fake-timer advance bumps its call count past 1), and
   `structureHandler` stays `null` → `structureHandler!(...)` throws. Tests fail / error.

3. **Minimal impl — rewrite the store.** Replace the entire contents of
   `src/lib/sync/daemon.svelte.ts` with:

   ```ts
   import {
     startWorkspaceSync,
     stopWorkspaceSync,
     workspaceSyncStatus,
     onStructureEvent,
     type DaemonStatusView,
     type WorkspaceEventEnvelope,
   } from "$lib/tauri";
   import { workspace } from "$lib/workspace.svelte";

   /** Event kinds that change the folder/document TREE (vs. doc_updated = content only). */
   const STRUCTURAL_KINDS = new Set([
     "folder_created",
     "folder_renamed",
     "folder_moved",
     "folder_deleted",
     "doc_created",
     "doc_renamed",
     "doc_moved",
     "doc_deleted",
   ]);

   /**
    * The Tier-1 daemon's reactive status. `status` is populated ONCE on start() and not on a
    * recurring timer, which keeps EditorPane's `daemonRunning = $derived(!!daemon.status?.running)`
    * value-stable (Plan 3's flicker fix). Structural changes arrive as pushed
    * `workspace://structure` events and rebuild the sidebar tree via a debounced refresh.
    */
   class DaemonStore {
     status = $state<DaemonStatusView | null>(null);
     #unlisten: (() => void) | null = null;
     #refreshTimer: ReturnType<typeof setTimeout> | null = null;

     async start(server: string, path: string, workspaceId: string | null): Promise<void> {
       await startWorkspaceSync(server, path, workspaceId);
       // One-shot status read to populate the StatusBar and the value-stable `running` flag.
       try {
         this.status = await workspaceSyncStatus();
       } catch {
         // transient; leave status null and let a later start retry
       }
       // Replace any prior subscription (start() may switch workspaces).
       this.#unlisten?.();
       this.#unlisten = await onStructureEvent((evt) => this.#onStructure(evt));
     }

     async stop(): Promise<void> {
       this.#unlisten?.();
       this.#unlisten = null;
       if (this.#refreshTimer) {
         clearTimeout(this.#refreshTimer);
         this.#refreshTimer = null;
       }
       await stopWorkspaceSync();
       this.status = null;
     }

     #onStructure(evt: WorkspaceEventEnvelope): void {
       // doc_updated is content-only — it never changes the tree, so don't refresh on it.
       if (!STRUCTURAL_KINDS.has(evt.kind)) return;
       this.#scheduleRefresh();
     }

     /** Coalesce a burst of structural events into a single tree rebuild (~150ms). */
     #scheduleRefresh(): void {
       if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
       this.#refreshTimer = setTimeout(() => {
         this.#refreshTimer = null;
         workspace.refresh().catch(() => {});
       }, 150);
     }
   }

   export const daemon = new DaemonStore();
   ```

4. **Run it, expect PASS.**

   ```
   pnpm test -- daemon.svelte
   ```

   Expected: 4 passed, `0 failed`. (`$state` outside a component compiles via the svelte
   vitest plugin; the rune assigns a plain value here, which the test reads directly.)

   If your vitest config does not compile `.svelte.ts` rune files under test (no
   `@sveltejs/vite-plugin-svelte` / `svelteTesting` in `vitest.config`), verify the runner
   handles the existing `$state` in this module BEFORE relying on it; the module already used
   `$state` pre-change, so the existing config compiled it. No config change expected.

5. **Run the full frontend test + check, expect PASS.**

   ```
   pnpm test
   ```

   Expected: all suites `passed`, `0 failed`.

   ```
   pnpm check
   ```

   Expected: `svelte-check found 0 errors and 0 warnings`.

6. **Verify the Plan-3 flicker fix is preserved (read-only confirmation, no edit).** Confirm
   `src/lib/EditorPane.svelte:57` still reads `const daemonRunning = $derived(!!daemon.status?.running);`
   and that `status` is now assigned only inside `start()` (one-shot) and cleared in `stop()` —
   never on a recurring timer. Because `status` flips value at most on start/stop, `daemonRunning`
   stays value-stable and the editor does not remount. (`StatusBar.svelte` reads
   `daemon.status?.running` / `.files` / `.error`; these still render from the one-shot snapshot.)

7. **Commit.**

   ```
   git add -A && git commit -m "demo_muesli: retire 1s daemon poll for pushed structure events with debounced tree refresh"
   ```

---

### Phase C done-when

- `src-tauri` `cargo test` green; `pnpm check` 0/0; `pnpm test` green.
- `workspace_id` flows clone → `start_workspace_sync` → `DaemonHandle::start` → `sync::run`; the
  clone records links with the `workspace` column.
- The daemon emits `workspace://structure` envelopes; the frontend subscribes via
  `onStructureEvent` and rebuilds the sidebar on structural changes (debounced), with no 1s poll
  and no regression to Plan 3's `daemonRunning` flicker fix.
