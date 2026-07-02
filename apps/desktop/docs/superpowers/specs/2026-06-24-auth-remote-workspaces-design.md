# Auth + Remote Workspaces — Design Spec

**Status:** Draft for review
**Date:** 2026-06-24
**Sub-project:** 1 of 3 (Auth + Remote Workspaces). Follow-on specs — (2) Web build, (3) Data-source connectors — are explicitly out of scope here.

## Goal

Make demo_muesli a first-class **authenticated client of the existing muesli-server**: log into a server (Tailscale-style), see every workspace you belong to, and open any of them as a **Finder-visible folder of `.md` files that stays live** — you, colleagues, and AI agents editing the same files at once, with both real-time cursors and effortless on-disk sync.

This is **not** "build a sync backend." The CRDT engine (`muesli-core`), the file-sync bridge (`muesli-cli`'s `FileSession`), and the server (workspaces, folders, documents, OIDC, per-doc CRDT rooms) already exist. We reuse them and add the specific pieces that make a Tauri client whole.

## Posture

**Server is fully in scope.** demo_muesli is intended to fold into muesli, so muesli-server changes are first-class, not throwaway. Where doing it right requires a server addition, we make it (enumerated in [Server-side additions](#server-side-additions)).

## Terminology

- **Server** — a muesli-server instance hosting many workspaces. You log into a specific server; one is *active* at a time, switchable.
- **Workspace** — the unit of sharing and the unit you open in the sidebar. Maps 1:1 to a server workspace. Scope is the admin's choice (whole company → single project). **Replaces "vault" everywhere in the product** ("vault" was Obsidian's word; we drop it).
- **Folder / File** — organization *within* a workspace. You don't share a folder; you create or join a *workspace*.

## Architecture

```
┌─ muesli-server (workspaces, folders, docs, OIDC, CRDT rooms) ─┐
│         ▲ REST (structure, auth)      ▲ y-sync WS (per doc)    │
└─────────┼───────────────────────────┼────────────────────────┘
          │                            │
┌─ demo_muesli Tauri backend (Rust) ───┼────────────────────────┐
│  • auth: device-code login, token in Keychain                 │
│  • daemon: muesli-core replicas (one per live doc)            │
│  • file bridge: watch ⇄ ingest ⇄ materialize (Finder folder)  │
│  • structure sync: REST out, workspace-event-stream in        │
│  • index.db: workspace registry + file↔doc links              │
└──────────────────────── Tauri IPC (TauriProvider) ───────────┘
          │ y-sync updates + awareness, for the OPEN doc only
┌─ Svelte frontend ─────────────────────────────────────────────┐
│  • editor: CodeMirror + yCollab over a JS Y.Doc mirror        │
│  • tree: renders the local Finder folder (today's code)       │
│  • workspace picker: open/create local · join/create remote   │
└───────────────────────────────────────────────────────────────┘
```

### Core principle: one replica per document

The single most important rule. Each document has **exactly one CRDT replica, owned by the Rust backend**, and **one** websocket to the server's room for that doc. This eliminates the "two replicas fighting over one file" failure mode.

- **Tier 1 (whole-folder liveness):** the daemon materializes every live doc's replica to its `.md` file on disk and ingests disk edits back — for *every* file in the workspace, open or not.
- **Tier 2 (presence):** when a doc is *open* in the editor, the frontend additionally attaches to that **same** replica through a `TauriProvider` over Tauri IPC, getting live cursors/selections. Closing the doc detaches the editor; the daemon keeps the replica.

Presence and file-sync are two things plugged into one replica, not two parallel sync systems.

## Components

### Rust backend (Tauri)

- **`auth`** — device-code login (`GET /api/cli/auth-config` → `POST /api/cli/login`), opens the system browser to the server's OIDC, stores the bearer token in the **macOS Keychain** (`keyring` crate). Surfaces login state and a re-login signal on token rejection. Multiple server logins remembered; one active.
- **`workspace_index`** — SQLite. Workspace registry `{ id, server, name, local_path (nullable), local_only }` powering the picker's three states; file↔document links (the `index.db` pattern from `muesli-cli`).
- **`sync_daemon`** — adapts `muesli-cli`'s `FileSession` loop. Owns the CRDT replicas, the file watcher, ingest (`muesli-core::compute_edits`, 50ms settle), materialize (500ms debounce, atomic temp+rename), and the **bounded session pool** (see [Liveness](#liveness-vs-connection-count)).
- **`structure_sync`** — REST client for structural ops outbound (folders/documents endpoints) and consumer of the **workspace event stream** inbound. Holds structure echo guards so the daemon never round-trips its own changes.
- **IPC bridge** — Tauri commands/events carrying y-sync binary updates + awareness frames between a JS `Y.Doc` and the Rust replica for the open doc.

### Frontend (Svelte)

- **`TauriProvider`** — a drop-in replacement for `y-websocket`'s `WebsocketProvider`. Same surface (`on('sync')`, `on('status')`, `awareness`), but its transport is Tauri IPC to the Rust replica instead of a websocket. `yCollab` (cursors included) binds to it unchanged.
- **`workspaces` store** — login state, the merged workspace list (local-only + cloud-only + cloned), active workspace, and the picker actions (open/create local, join/create remote, promote).
- **Editor & tree** — largely unchanged. The tree keeps rendering from the local filesystem (`read_vault_tree`/`TreeNode`); the editor keeps CodeMirror + `yCollab`. Rename "vault" → "workspace" in all UI copy and identifiers.
- **Settings** — server login/logout, active-server switch, connection status (StatusBar already wired).

### Server-side additions

1. **Workspace event stream** — a per-workspace channel (authenticated, scoped to the caller's membership) that announces **structural** changes (doc/folder created, renamed, moved, deleted) *and* **content** notifications ("doc X received an update"). Drives instant structure materialization and the bounded-pool wake.
2. **Create-workspace endpoint** — `POST /api/workspaces` (returns the new workspace id), used by "create remote" and "promote local → remote".
3. **Event-stream auth scoping** — whatever's needed so a client only receives events for workspaces it belongs to.

## Data flows

### Login
Enter server URL → device-code flow → system browser → OIDC approve → token to Keychain → fetch `GET /api/me` (identity) and `GET /api/workspaces` (membership).

### Workspace picker
On login, the sidebar picker shows **all** workspaces in three states:
- **local-only** — a local folder, no server.
- **cloud-only** — a server workspace you belong to but haven't downloaded (cloud affordance).
- **cloned** — a server workspace materialized locally (`local_path` set).

Picker actions: **Open** existing local folder · **Create local** · **Join** a cloud-only workspace · **Create remote** · **Promote** a local workspace to remote. "Create remote" and "Promote" are one operation (create-workspace + push files); promote seeds from the local folder's existing files, create-remote starts empty.

### Clone / pull (lazy, on selection)
Selecting a **cloud-only** workspace → prompt for a local folder (default `~/muesli/<workspace-slug>`) → eager full pull: enumerate folders + documents, build the tree, pull each doc's current text, write the `.md` files, record links in `index.db` → daemon goes live. Selecting an **already-local** workspace just opens it.

### Content sync (both tiers, one replica)
Disk edit → 50ms settle → `compute_edits` → apply to the doc's replica → encode y-sync update → send to server room → broadcast. Remote update → apply to replica → 500ms debounce → atomic write to disk. Echo guard: skip ingest when disk bytes equal last-written. For the **open** doc, the JS `Y.Doc` stays in lockstep with the replica via the `TauriProvider`, and `yCollab` renders local + remote cursors.

### Structure sync
- **Local structural op** (in-app or in Finder) → daemon detects → REST call (`POST /api/folders`, `PATCH /api/documents/{slug}`, etc.) → server broadcasts on the event stream.
- **Remote structural op** → event stream → daemon creates/renames/moves/deletes the local file → appears in the tree instantly.
- Structure echo guards prevent ping-pong of the daemon's own changes.

### Liveness vs. connection count
The daemon does **not** hold a websocket open for every doc. It keeps a **bounded pool** of live sessions (recently active + the open doc; `muesli-cli` caps at 64, idle-disconnect 30s). The **workspace event stream announces content changes**, so when a cold doc changes remotely the daemon **wakes a session on demand**, pulls, and materializes. Bounded connections, near-instant disk.

### Presence / identity
Identity from `GET /api/me` (name, avatar). Awareness local state `{ name, color, kind: "human" }`; cursor **color derived deterministically from user-id**. Other peers' awareness relayed server → Rust → IPC → editor. **Agents** appear as `kind: "agent"`; the server's `MUESLI_AGENT_DIRECT` policy may downgrade agent direct edits to suggestions when a human is co-present (server-enforced; client just sees edits + presence). **Local-only workspaces have no presence** (no server) — solo editing, by design.

### Offline / reconnect
Disconnected, the user keeps editing; the daemon buffers into the local replica and the disk file stays editable. On reconnect, y-sync step1/2 handshake + `muesli-cli`'s `reconcile()` ingests any offline disk divergence as a merged change set. CRDT merge ⇒ no lost edits. Token rejection (expired/revoked) surfaces a re-login prompt.

### Local → shared promotion
"Make shared" on a local workspace → `POST /api/workspaces` → push the folder's files/folders up as documents/folders, recording links → the workspace flips from `local_only` to `cloned`, daemon goes live.

## Error handling

- **Token rejected** → mark server logged-out, prompt re-login; keep working offline against the local copy.
- **Server unreachable** → workspace stays usable offline; StatusBar shows offline; reconnect with backoff (`muesli-cli` already does this).
- **Slug collision** on file create → `unique_slug` suffixing (already in `muesli-cli`).
- **Ambiguous rename** (multiple byte-identical candidates) → never guess; surface a prompt (ADR 0009 behavior).
- **Clone interrupted** → resumable; links recorded incrementally so a re-open continues the pull.

## Testing strategy

- **Rust unit:** structure-sync echo guards; reconcile-on-reconnect; index.db state transitions (local-only → cloned). (`muesli-core` ingest/materialize already tested upstream.)
- **`TauriProvider` conformance:** round-trips y-sync updates + awareness with a `Y.Doc` identically to `WebsocketProvider` (golden-transport test).
- **Integration:** two clients against a throwaway server — edit the same doc, assert convergence on disk *and* mirrored cursors; create a file on client A, assert it appears on client B via the event stream.
- **Auth:** device-code flow against a mocked server (success, denial, token rejection → re-login).

## Out of scope (follow-on specs)

- **Web build** — the same UI served in a browser (partly exists as `muesli/apps/web`).
- **Data-source connectors** — attaching S3 / GitHub / Google Drive storage backends (server already supports; client is mostly a settings surface).

## Open risks

- **Connection scale** in very large workspaces — bounded pool + on-demand wake is the mitigation; needs load validation.
- **Structure echo-guard correctness** across rename+move bursts — covered by tests but the highest-risk logic.
- **yrs (Rust) ↔ yjs (JS) parity** over IPC — wire-compatible by design (y-sync v1), but the `TauriProvider` conformance test is the guard.
