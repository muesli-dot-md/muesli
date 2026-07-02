# Plan 3 — Presence & Live Cursors (Tier-2 TauriProvider) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a synced document is *open* in the editor, attach its CodeMirror `Y.Doc` to the **same** Rust-owned CRDT replica the Tier-1 daemon already syncs — over Tauri IPC — so edits are lockstep-instant and remote collaborators' cursors/selections render live.

**Architecture:** The Tier-1 daemon's `FileSession` owns one canonical `MuesliDoc` replica per file and one websocket to the server room (Plan 2). Plan 3 makes that `FileSession` treat the open editor as a **second y-sync + awareness peer** of the very same replica. A JS `TauriProvider` (drop-in for `y-websocket`'s `WebsocketProvider`) carries opaque y-protocols frames over Tauri IPC instead of a websocket. No second replica, no second server connection — presence and file-sync are two things plugged into one replica (spec §"Two tiers, one replica"). The Plan-2 1-second disk-poll reload is **replaced** by live provider updates for the open doc.

**Tech Stack:** Rust (muesli-cli `FileSession`/`sync`, tokio channels), Tauri 2 (`AppHandle::emit`, managed state, commands), SvelteKit/Svelte 5, yjs `^13.6.31`, `y-protocols` (sync + awareness), `lib0` (encoding), `y-codemirror.next` `yCollab`.

## Global Constraints

- **Two repos, two branches.** Upstream CRDT/daemon changes land in `~/Code/muesli` on branch **`feat/cli-list-workspaces`** (the same branch Plans 1–2 used for upstream work). App changes land in `~/Code/demo_muesli` on branch **`feat/auth-remote-workspaces`** (current branch, continues from Plan 2 @ `b2f3bbc`). The plan document itself lives in demo_muesli.
- **Single replica per doc, owned by Rust.** The editor never opens its own server websocket for a synced doc. It attaches to the daemon's `FileSession` replica. The Plan-2 invariant "no per-note `WebsocketProvider` while the daemon runs" stays; Tier-2 plugs a *different* provider (`TauriProvider`) into the daemon, it does not re-enable the legacy one.
- **Frames are y-protocols/y-websocket wire-compatible.** `muesli_core::protocol::frame_sync`/`frame_awareness` already match what `y-websocket` emits (the muesli web app proves interop against the same server). The JS side reuses `y-protocols/sync` + `y-protocols/awareness` verbatim; only the transport differs (Tauri IPC vs websocket). Do **not** invent a new frame format.
- **"workspace" not "vault"** in all new copy/identifiers.
- **Clean commits: NO `Co-Authored-By` trailer.** Branch off the named branches; do not merge — Julian merges.
- **muesli-core stays awareness-agnostic at the doc layer.** Awareness is a pure passthrough relayed by `FileSession`; do NOT add awareness state to `MuesliDoc`. The server (`room.rs`) already tracks/replays awareness. Replica-change detection uses the existing `MuesliDoc` API only: `state_vector()`, `diff_update(&sv)`, `apply_update()`. Do not add observe-callbacks to muesli-core.
- **Tier boundary.** Plan 3 = presence + lockstep content for the OPEN doc. Structure sync (remote folder/rename/move/delete → disk; workspace-correct placement) remains Plan 4. Local→shared promotion remains Plan 5.
- **macOS DYLD workaround for cargo in `src-tauri`** (ScreenCaptureKit links): prefix cargo test/build with
  `DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx`.
  muesli crate tests need `DYLD_FALLBACK_LIBRARY_PATH=<same path>` only if they link Swift (they don't — plain `cargo test -p muesli-cli` works).
- **`pnpm check` must end 0 errors / 0 warnings** in demo_muesli.
- **Path deps** from `src-tauri`: `muesli-core = { path = "../../muesli/crates/muesli-core" }`, `muesli-cli = { path = "../../muesli/crates/muesli-cli" }` (already present).

---

## File Structure

**muesli (`feat/cli-list-workspaces`):**
- Modify `crates/muesli-cli/src/session.rs` — add `EditorBridge`; refactor `handle_frame` to route awareness + report applied delta; integrate the bridge into `run_once`'s select loop; persist bridge across reconnects on `FileSession`.
- Modify `crates/muesli-cli/src/sync.rs` — add `DaemonControl` enum + `control_rx` param to `run`; add `bridge_ctl` sender to `FileHandle`; create it in `spawn_file`; handle `Attach`/`Detach` in `run`'s select loop.

**demo_muesli (`feat/auth-remote-workspaces`):**
- Modify `src-tauri/src/sync_daemon/mod.rs` — `DaemonHandle` gains `control_tx`; `start` wires `control_rx` into `sync::run`; add `attach_editor`/`detach_editor` methods.
- Create `src-tauri/src/editor_bridge/mod.rs` — `EditorBridges` managed state (per-path editor-facing channels + the daemon→editor forwarder task that `app.emit`s frames).
- Modify `src-tauri/src/sync_cmd.rs` — `attach_editor`, `detach_editor`, `send_editor_frame` commands.
- Modify `src-tauri/src/lib.rs` — `mod editor_bridge;`, `.manage(EditorBridges::new())`, three commands in `generate_handler!`.
- Create `src/lib/sync/tauri-provider.ts` — `TauriProvider` + `createTauriSession` (drop-in `Session`).
- Modify `src/lib/sync/session.ts` — widen `Session.provider`/`awareness` types so both providers satisfy the interface.
- Modify `src/lib/tauri.ts` — `attachEditor`/`detachEditor`/`sendEditorFrame` invoke wrappers + `editor://frame` event subscription helper.
- Modify `src/lib/EditorPane.svelte` — choose `TauriProvider` when the daemon is running for a synced file; remove the Plan-2 1s disk-poll `$effect`.
- Modify `package.json` — add `y-protocols` and `lib0` as **direct** deps (currently transitive).

---

## Interfaces (the contract every task shares)

```rust
// muesli-cli/src/session.rs — NEW public types
/// A live attachment of an in-process editor to a FileSession's replica (Tier-2).
/// The session treats the editor as a second y-sync + awareness peer of the canonical
/// replica. Frames are opaque y-protocols wire frames (MSG_SYNC / MSG_AWARENESS).
pub struct EditorBridge {
    /// Frames arriving FROM the editor (sent by the TauriProvider over IPC).
    pub inbound: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    /// Frames to deliver TO the editor (the embedder emits them as Tauri events).
    pub outbound: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
}

/// Per-session control: attach/detach an editor bridge while the session runs.
pub enum BridgeCmd {
    Attach(EditorBridge),
    Detach,
}
```

```rust
// muesli-cli/src/sync.rs — NEW control surface on the daemon
pub enum DaemonControl {
    /// Attach an editor to the session for `path` (spawning/keeping it live).
    Attach { path: std::path::PathBuf, bridge: crate::session::EditorBridge },
    /// Detach any editor from the session for `path`.
    Detach { path: std::path::PathBuf },
}
// run() gains a trailing parameter: control_rx: mpsc::UnboundedReceiver<DaemonControl>
```

```typescript
// demo_muesli src/lib/sync/tauri-provider.ts — drop-in Session
export function createTauriSession(opts: { path: string; identity: PresenceIdentity }): Session;
export interface PresenceIdentity { name: string; color: string; colorLight: string; kind: "human" | "agent"; }
```

---

### Task 1: `EditorBridge` types + awareness-aware `handle_frame` (muesli-cli)

**Repo/branch:** muesli `feat/cli-list-workspaces`.

**Files:**
- Modify: `crates/muesli-cli/src/session.rs`
- Test: `crates/muesli-cli/src/session.rs` (`#[cfg(test)]` module at the bottom — add one if absent)

**Interfaces:**
- Consumes: `muesli_core::protocol::{frame_sync, frame_awareness, Cursor, MSG_SYNC, MSG_AWARENESS, SYNC_STEP1, SYNC_STEP2, SYNC_UPDATE}`, `muesli_core::MuesliDoc`.
- Produces: `pub struct EditorBridge`, `pub enum BridgeCmd`, and a refactored `handle_frame` returning what changed so callers can fan-out to peers.

**Context:** Today `handle_frame(replica, data, dirty)` (session.rs:406) applies sync payloads and **drops** `MSG_AWARENESS` (line 428). Plan 3 needs two new behaviours from frame handling: (a) when a sync update mutates the replica, the caller must learn the *delta* so it can forward it to the OTHER peer; (b) awareness frames must be forwarded, not dropped. We refactor `handle_frame` to return a small struct describing the outcome; the existing server arm keeps working unchanged in behaviour (still replies to STEP1, still sets `dirty`).

- [ ] **Step 1: Write failing tests for the new `handle_frame` contract + bridge types.**

Add to the `#[cfg(test)] mod tests` in `session.rs` (create the module if none exists — `use super::*;`):

```rust
#[test]
fn handle_frame_reports_sync_delta_and_step1_reply() {
    let replica = MuesliDoc::with_text("hello");
    let peer = MuesliDoc::new();

    // STEP1 from an empty peer → we reply STEP2, no local change.
    let step1 = frame_sync(SYNC_STEP1, &peer.state_vector());
    let mut dirty = false;
    let out = handle_frame(&replica, &step1, &mut dirty);
    assert!(!dirty, "answering step1 must not dirty the replica");
    assert!(out.delta.is_none(), "step1 reply is not a local delta");
    let reply = out.reply.expect("step1 must produce a step2 reply");
    // Applying that reply to the peer converges it to our text.
    if let FrameOut { .. } = out {}
    // Decode the step2 payload out of the reply frame and apply.
    let payload = sync_payload(&reply).expect("reply is a sync frame");
    peer.apply_update(&payload).unwrap();
    assert_eq!(peer.materialize(), "hello");

    // An UPDATE that changes the replica → dirty + a forwardable delta.
    let other = MuesliDoc::with_text("hello");
    let sv = other.state_vector();
    other.ingest("hello world");
    let upd = other.diff_update(&sv).unwrap();
    let frame = frame_sync(SYNC_UPDATE, &upd);
    let mut dirty2 = false;
    let out2 = handle_frame(&replica, &frame, &mut dirty2);
    assert!(dirty2, "an effective update sets dirty");
    assert!(out2.delta.is_some(), "an effective update yields a delta to fan out");
    assert!(out2.reply.is_none());
}

#[test]
fn handle_frame_surfaces_awareness_for_relay() {
    let replica = MuesliDoc::new();
    let aw = frame_awareness(b"{\"opaque\":true}");
    let mut dirty = false;
    let out = handle_frame(&replica, &aw, &mut dirty);
    assert!(!dirty);
    assert!(out.delta.is_none());
    assert!(out.reply.is_none());
    assert_eq!(out.awareness.as_deref(), Some(&b"{\"opaque\":true}"[..]),
        "awareness payload is surfaced verbatim for relay, not dropped");
}
```

Add this tiny test helper near the tests (decodes a sync frame's payload):

```rust
#[cfg(test)]
fn sync_payload(frame: &[u8]) -> Option<Vec<u8>> {
    let mut c = Cursor::new(frame);
    if c.read_var_u64().ok()? != MSG_SYNC { return None; }
    let _sub = c.read_var_u64().ok()?;
    c.read_bytes().ok().map(|b| b.to_vec())
}
```

- [ ] **Step 2: Run the tests — expect FAIL (compile error: `FrameOut`/`out.delta` unknown).**

Run: `cd ~/Code/muesli && cargo test -p muesli-cli handle_frame -- --nocapture`
Expected: FAIL to compile (`handle_frame` returns `Result<Option<Vec<u8>>>`, no `FrameOut`).

- [ ] **Step 3: Refactor `handle_frame` to return a `FrameOut` and surface awareness.**

Replace the existing `fn handle_frame(...)` (session.rs:404-432) with:

```rust
/// What parsing one frame produced. `reply` is a frame to send back to the SAME peer
/// (a STEP2 answering its STEP1). `delta` is a y-sync update describing how the replica
/// changed (to fan out to OTHER peers). `awareness` is a raw awareness payload to relay.
#[derive(Default)]
pub(crate) struct FrameOut {
    pub reply: Option<Vec<u8>>,
    pub delta: Option<Vec<u8>>,
    pub awareness: Option<Vec<u8>>,
}

/// Parse one peer frame against `replica`. Applies sync payloads; sets `dirty` when the
/// replica content changed and returns that change as `delta` (so the caller can forward
/// it to other peers). Surfaces awareness payloads verbatim for relay (never drops them).
pub(crate) fn handle_frame(replica: &MuesliDoc, data: &[u8], dirty: &mut bool) -> FrameOut {
    let mut out = FrameOut::default();
    let mut c = Cursor::new(data);
    let Ok(msg_type) = c.read_var_u64() else { return out };
    match msg_type {
        MSG_SYNC => {
            let Ok(subtype) = c.read_var_u64() else { return out };
            let Ok(payload) = c.read_bytes() else { return out };
            match subtype {
                SYNC_STEP1 => {
                    if let Ok(diff) = replica.diff_update(payload) {
                        out.reply = Some(frame_sync(SYNC_STEP2, &diff));
                    }
                }
                SYNC_STEP2 | SYNC_UPDATE => {
                    let before = replica.state_vector();
                    if replica.apply_update(payload).is_ok() && replica.state_vector() != before {
                        *dirty = true;
                        if let Ok(delta) = replica.diff_update(&before) {
                            out.delta = Some(delta);
                        }
                    }
                }
                _ => {}
            }
        }
        MSG_AWARENESS => {
            if let Ok(payload) = c.read_bytes() {
                out.awareness = Some(payload.to_vec());
            }
        }
        _ => {}
    }
    out
}
```

> NOTE: this drops the previous `Result<...>` return. Errors from `diff_update`/`apply_update` were already non-fatal in spirit (a malformed frame shouldn't kill the session); swallowing them into "no change" is correct and removes the `?` at the call site. The call site is updated in Task 2.

- [ ] **Step 4: Update the existing server-arm call site so the crate compiles.**

In `run_once` (session.rs ~290), the current call is:
```rust
if let Some(reply) = handle_frame(replica, &data, &mut dirty)? {
    sink.send(Message::Binary(reply)).await?;
}
```
Replace with (Task 2 will extend this to also fan-out `delta`/`awareness` to the bridge; for now just preserve behaviour):
```rust
let fo = handle_frame(replica, &data, &mut dirty);
if let Some(reply) = fo.reply {
    sink.send(Message::Binary(reply)).await?;
}
```

- [ ] **Step 5: Add the `EditorBridge` + `BridgeCmd` types** (near the top of session.rs, after the `Stop` enum):

```rust
/// A live attachment of an in-process editor to a FileSession's replica (Tier-2, Plan 3).
/// The session treats the editor as a second y-sync + awareness peer of the canonical
/// replica. Frames are opaque y-protocols wire frames (MSG_SYNC / MSG_AWARENESS); the
/// session never inspects awareness, only relays it.
pub struct EditorBridge {
    /// Frames arriving FROM the editor (the TauriProvider sends them over IPC).
    pub inbound: mpsc::UnboundedReceiver<Vec<u8>>,
    /// Frames to deliver TO the editor (the embedder emits them as Tauri events).
    pub outbound: mpsc::UnboundedSender<Vec<u8>>,
}

/// Attach/detach an editor bridge on a running session.
pub enum BridgeCmd {
    Attach(EditorBridge),
    Detach,
}
```

Add a `bridge: Option<EditorBridge>` field to `FileSession` and initialise it `None` in `FileSession::new`:
```rust
pub struct FileSession {
    pub ctx: SessionCtx,
    replica: MuesliDoc,
    last_written: String,
    announced: bool,
    bridge: Option<EditorBridge>,   // Tier-2 editor attachment (Plan 3)
}
// in new():
Self { ctx, replica: MuesliDoc::new(), last_written: String::new(), announced: false, bridge: None }
```

- [ ] **Step 6: Run the tests — expect PASS.**

Run: `cd ~/Code/muesli && cargo test -p muesli-cli` (whole crate, to catch the call-site refactor).
Expected: PASS (all prior tests + the two new ones). Fix any unused-import warnings (`frame_awareness` is now used in tests).

- [ ] **Step 7: Commit.**
```bash
cd ~/Code/muesli
git add crates/muesli-cli/src/session.rs
git commit -m "feat(cli): handle_frame reports sync delta + relays awareness; add EditorBridge types"
```

---

### Task 2: Integrate the editor bridge into `run_once` (muesli-cli)

**Repo/branch:** muesli `feat/cli-list-workspaces`.

**Files:**
- Modify: `crates/muesli-cli/src/session.rs` (`FileSession::run` / `run_once`)
- Test: `crates/muesli-cli/src/session.rs` tests (a focused fan-out unit test; the full two-peer convergence is exercised by the Task-9 integration check)

**Interfaces:**
- Consumes: `EditorBridge`, `BridgeCmd`, `FrameOut`, `handle_frame` (Task 1).
- Produces: `run`/`run_once` gain a `bridge_ctl_rx: &mut mpsc::UnboundedReceiver<BridgeCmd>` parameter; the session now: (1) accepts an editor bridge mid-flight, (2) on attach sends STEP1 to the editor, (3) applies editor frames to the replica and forwards their deltas to the server, (4) forwards server/disk deltas + server awareness to the editor, (5) does not idle-disconnect while a bridge is attached.

**Context:** `run_once` (session.rs:226) is the per-connection loop with a `tokio::select!`. It destructures `self` into `replica`/`last_written`/`announced` locals (lines 233-237) to avoid borrow conflicts. We add `let bridge = &mut self.bridge;`. The bridge persists across reconnects because it lives on `FileSession`, but the **control receiver** must be threaded into the loop so an attach that happens while connected is seen immediately.

The fan-out rule (one canonical replica, ≤2 peers — server always, editor 0/1):
- **Editor frame** (`bridge.inbound`): parse via `handle_frame`. `reply` (STEP2) → back to editor. `delta` (its edit) → to the **server** sink + set `dirty` (materialize to disk). `awareness` → to the **server** sink (relay editor presence outward).
- **Server frame** (existing `stream.next()` arm): `reply` → server (unchanged). `delta` → to the **editor** (`bridge.outbound`). `awareness` → to the **editor**.
- **Disk ingest** (existing `fs_rx` arm): the computed `update` already goes to the server; ALSO send it to the editor (so disk edits show live — this replaces the Plan-2 poll).
- **Attach**: push `frame_sync(SYNC_STEP1, &replica.state_vector())` into `bridge.outbound` so the freshly-opened editor pulls current content.

- [ ] **Step 1: Write a failing unit test for editor→replica→server fan-out.**

This test drives `run` is heavyweight (needs a websocket). Instead, unit-test the pure fan-out helper we will extract. Add to tests:

```rust
#[test]
fn editor_update_produces_server_delta_and_dirties() {
    // Simulate: replica holds "hi"; editor sends an UPDATE turning it into "hi there".
    let replica = MuesliDoc::with_text("hi");
    let editor_doc = MuesliDoc::with_text("hi");
    let sv = editor_doc.state_vector();
    editor_doc.ingest("hi there");
    let upd = editor_doc.diff_update(&sv).unwrap();
    let frame = frame_sync(SYNC_UPDATE, &upd);

    let mut dirty = false;
    let out = handle_frame(&replica, &frame, &mut dirty);
    assert!(dirty);
    let delta = out.delta.expect("editor edit yields a server-bound delta");
    // The delta carries the edit: a fresh server replica applying it converges.
    let server = MuesliDoc::with_text("hi");
    server.apply_update(&delta).unwrap();
    assert_eq!(server.materialize(), "hi there");
}
```

(Behaviour here is already provided by Task 1's `handle_frame`; this test pins the fan-out contract the loop relies on.)

- [ ] **Step 2: Run it — expect PASS already** (it exercises Task 1 code). This guards the contract the loop wiring depends on.

Run: `cd ~/Code/muesli && cargo test -p muesli-cli editor_update_produces`
Expected: PASS.

- [ ] **Step 3: Thread `bridge_ctl_rx` through `run` and `run_once`.**

Change signatures:
```rust
pub async fn run(
    &mut self,
    fs_rx: &mut mpsc::UnboundedReceiver<()>,
    stop_rx: &mut watch::Receiver<Stop>,
    bridge_ctl_rx: &mut mpsc::UnboundedReceiver<BridgeCmd>,   // NEW
    idle_timeout: Option<Duration>,
) -> Result<SessionOutcome> { /* … pass bridge_ctl_rx into run_once … */ }

async fn run_once(
    &mut self,
    fs_rx: &mut mpsc::UnboundedReceiver<()>,
    stop_rx: &mut watch::Receiver<Stop>,
    bridge_ctl_rx: &mut mpsc::UnboundedReceiver<BridgeCmd>,   // NEW
    idle_timeout: Option<Duration>,
    synced: &mut bool,
) -> Result<SessionOutcome> { … }
```
In `run`, the existing `self.run_once(fs_rx, stop_rx, idle_timeout, &mut synced)` call becomes `self.run_once(fs_rx, stop_rx, bridge_ctl_rx, idle_timeout, &mut synced)`.

- [ ] **Step 4: Add the bridge local + drain control before connecting.**

At the top of `run_once`, alongside the existing field locals, add:
```rust
let bridge = &mut self.bridge;
```
Apply any pending control commands that arrived while idle/reconnecting (non-blocking), and if a bridge is now attached, bootstrap it with STEP1:
```rust
while let Ok(cmd) = bridge_ctl_rx.try_recv() {
    match cmd {
        BridgeCmd::Attach(b) => *bridge = Some(b),
        BridgeCmd::Detach => *bridge = None,
    }
}
```
After the initial `sink.send(... SYNC_STEP1 ...)` to the server, if `bridge.is_some()`, also push STEP1 to the editor:
```rust
if let Some(b) = bridge.as_ref() {
    let _ = b.outbound.send(frame_sync(SYNC_STEP1, &replica.state_vector()));
}
```

- [ ] **Step 5: Extend the select loop — editor inbound + control arms, and fan-out on the existing arms.**

Inside the `loop { tokio::select! { … } }`:

(a) **Server arm** — replace the existing `handle_frame` block (Task 1 Step 4 left it replying only) with full fan-out:
```rust
Message::Binary(data) => {
    let fo = handle_frame(replica, &data, &mut dirty);
    if let Some(reply) = fo.reply { sink.send(Message::Binary(reply)).await?; }
    if let Some(b) = bridge.as_ref() {
        if let Some(delta) = fo.delta { let _ = b.outbound.send(frame_sync(SYNC_UPDATE, &delta)); }
        if let Some(aw) = fo.awareness { let _ = b.outbound.send(frame_awareness(&aw)); }
    }
    // (existing first-sync reconcile + materialize-timer arming stays as-is below)
    …
}
```
Import `frame_awareness` at the top: `use muesli_core::protocol::{frame_awareness, frame_sync, Cursor, MSG_AWARENESS, MSG_SYNC, SYNC_STEP1, SYNC_STEP2, SYNC_UPDATE};`

(b) **Disk-ingest arm** — after the existing `sink.send(... SYNC_UPDATE, &update ...)` to the server, also send to the editor:
```rust
let update = replica.diff_update(&sv).map_err(|e| anyhow::anyhow!(e.to_string()))?;
ctx.on_ingest(update.len());
sink.send(Message::Binary(frame_sync(SYNC_UPDATE, &update))).await?;
if let Some(b) = bridge.as_ref() {
    let _ = b.outbound.send(frame_sync(SYNC_UPDATE, &update));
}
```

(c) **NEW editor-inbound arm** — pending future when no bridge (so the arm is inert until attached):
```rust
// ── Editor → replica → server (Tier-2 inbound) ─────────────────────────
frame = async {
    match bridge.as_mut() {
        Some(b) => b.inbound.recv().await,
        None => std::future::pending().await,
    }
} => {
    touch_idle!();
    let Some(frame) = frame else { *bridge = None; continue }; // editor detached/closed
    let fo = handle_frame(replica, &frame, &mut dirty);
    if let Some(b) = bridge.as_ref() {
        if let Some(reply) = fo.reply { let _ = b.outbound.send(reply); } // STEP2 back to editor
    }
    if let Some(delta) = fo.delta {
        sink.send(Message::Binary(frame_sync(SYNC_UPDATE, &delta))).await?; // editor edit → server
    }
    if let Some(aw) = fo.awareness {
        sink.send(Message::Binary(frame_awareness(&aw))).await?;            // editor presence → server
    }
    if dirty {
        materialize_timer.as_mut().reset(tokio::time::Instant::now() + MATERIALIZE_DEBOUNCE);
    }
}
```

(d) **NEW control arm** — attach/detach mid-flight:
```rust
// ── Editor attach/detach ───────────────────────────────────────────────
Some(cmd) = bridge_ctl_rx.recv() => {
    match cmd {
        BridgeCmd::Attach(b) => {
            // Bootstrap the new editor with current replica state.
            let _ = b.outbound.send(frame_sync(SYNC_STEP1, &replica.state_vector()));
            *bridge = Some(b);
        }
        BridgeCmd::Detach => *bridge = None,
    }
}
```

(e) **Idle arm** — keep the session connected while an editor is attached:
```rust
() = &mut idle_timer, if idle_timeout.is_some() && bridge.is_none() => {
    return Ok(SessionOutcome::Idle);
}
```

> Borrow note: `bridge` is `&mut Option<EditorBridge>`. The inbound arm borrows it mutably for `recv()`; the other arms borrow `bridge.as_ref()`. Because `tokio::select!` evaluates each arm's future/body sequentially (not concurrently across arms within one poll), this compiles. If the borrow checker objects to overlapping `bridge` uses, move the `bridge.outbound` sends into a small local `|frame| { if let Some(b) = bridge.as_ref() { let _ = b.outbound.send(frame); } }` closure declared per-arm, or capture `let out_tx = bridge.as_ref().map(|b| b.outbound.clone());` at loop top (UnboundedSender is `Clone`) and send through `out_tx`. Prefer cloning the `outbound` sender once per loop iteration if needed — it's cheap.

- [ ] **Step 6: Update the only other caller of `run` (the daemon) — placeholder until Task 3.**

`sync.rs` `spawn_file` calls `session.run(&mut fs_rx, &mut stop_rx, lazy.then_some(IDLE_TIMEOUT))`. To keep muesli compiling between tasks, add a throwaway channel inline now (Task 3 replaces it with the real one):
```rust
let (_bridge_ctl_tx, mut bridge_ctl_rx) = mpsc::unbounded_channel::<crate::session::BridgeCmd>();
…
let outcome = session.run(&mut fs_rx, &mut stop_rx, &mut bridge_ctl_rx, lazy.then_some(IDLE_TIMEOUT)).await;
```

- [ ] **Step 7: Run the full crate test suite + clippy.**

Run:
```bash
cd ~/Code/muesli
cargo test -p muesli-cli
cargo clippy -p muesli-cli -- -D warnings
```
Expected: PASS, no clippy errors. (`std::future::pending().await` needs no import.)

- [ ] **Step 8: Commit.**
```bash
git add crates/muesli-cli/src/session.rs crates/muesli-cli/src/sync.rs
git commit -m "feat(cli): FileSession bridges an open editor as a 2nd y-sync+awareness peer"
```

---

### Task 3: Daemon control channel — attach/detach by path (muesli-cli)

**Repo/branch:** muesli `feat/cli-list-workspaces`.

**Files:**
- Modify: `crates/muesli-cli/src/sync.rs`
- Test: `crates/muesli-cli/src/sync.rs` tests (path-resolution unit test)

**Interfaces:**
- Consumes: `BridgeCmd`, `EditorBridge` (Tasks 1-2).
- Produces: `pub enum DaemonControl { Attach { path, bridge }, Detach { path } }`; `run` gains `control_rx: mpsc::UnboundedReceiver<DaemonControl>`; `FileHandle` gains `bridge_ctl: mpsc::UnboundedSender<BridgeCmd>`; the CLI `sync()` passes an inert control channel.

**Context:** `run` (sync.rs:72) owns `SyncDaemon { handles: HashMap<PathBuf, FileHandle> }`. `spawn_file` (sync.rs:236) builds each session task. We add a per-file `bridge_ctl` channel created in `spawn_file` (sender on `FileHandle`, receiver moved into the task), and a daemon-wide `control_rx` whose `Attach`/`Detach` resolve `path` → `FileHandle` → send a `BridgeCmd`. Paths from the embedder must be canonicalized to match `handles` keys (the daemon canonicalizes `dir` and discovers canonical file paths).

- [ ] **Step 1: Write a failing test for path canonicalization used by Attach.**

Attach must match the embedder's path against `handles` keys even when the embedder passes a non-canonical path. Add a small pure helper `fn resolve_handle_key(dir: &Path, path: &Path) -> PathBuf` (canonicalize if possible, else join-under-dir) and test it:

```rust
#[test]
fn attach_path_resolves_to_canonical_key() {
    let root = std::env::temp_dir().join(format!("muesli-attach-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("sub")).unwrap();
    std::fs::write(root.join("sub/a.md"), "x").unwrap();
    let root = root.canonicalize().unwrap();
    let canonical = root.join("sub/a.md");
    // A path with a redundant component resolves to the same key.
    let messy = root.join("sub/../sub/a.md");
    assert_eq!(resolve_handle_key(&root, &messy), canonical);
    let _ = std::fs::remove_dir_all(&root);
}
```

- [ ] **Step 2: Run it — expect FAIL (no `resolve_handle_key`).**

Run: `cd ~/Code/muesli && cargo test -p muesli-cli attach_path_resolves`
Expected: FAIL to compile.

- [ ] **Step 3: Add `DaemonControl`, the resolver, the `FileHandle` field, and `control_rx`.**

```rust
/// Out-of-band control of a running daemon by an embedder (the Tauri app).
pub enum DaemonControl {
    /// Attach an editor to the session for `path` (kept live while attached).
    Attach { path: PathBuf, bridge: crate::session::EditorBridge },
    /// Detach any editor from the session for `path`.
    Detach { path: PathBuf },
}

/// Best-effort canonical key for `handles` lookups (handles are keyed by canonical paths).
fn resolve_handle_key(dir: &Path, path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| {
        if path.is_absolute() { path.to_path_buf() } else { dir.join(path) }
    })
}
```
Add to `FileHandle`:
```rust
struct FileHandle {
    fs_tx: mpsc::UnboundedSender<()>,
    stop_tx: watch::Sender<Stop>,
    bridge_ctl: mpsc::UnboundedSender<crate::session::BridgeCmd>,  // NEW
    doc: String,
}
```

- [ ] **Step 4: Create the per-file bridge channel in `spawn_file`.**

Replace the throwaway channel from Task 2 Step 6 with a real one whose sender is stored on the handle:
```rust
fn spawn_file(&mut self, file: PathBuf, doc: String) {
    let (fs_tx, mut fs_rx) = mpsc::unbounded_channel::<()>();
    let (stop_tx, mut stop_rx) = watch::channel(Stop::Run);
    let (bridge_ctl_tx, mut bridge_ctl_rx) = mpsc::unbounded_channel::<crate::session::BridgeCmd>(); // NEW
    …
    self.tasks.spawn(async move {
        let mut session = FileSession::new(ctx);
        loop {
            let permit = …;
            let outcome = session
                .run(&mut fs_rx, &mut stop_rx, &mut bridge_ctl_rx, lazy.then_some(IDLE_TIMEOUT))
                .await;
            …
        }
    });
    self.handles.insert(file, FileHandle { fs_tx, stop_tx, bridge_ctl: bridge_ctl_tx, doc });
}
```

- [ ] **Step 5: Add `control_rx` to `run` and handle it in the select loop.**

Signature:
```rust
pub async fn run(
    dir: PathBuf,
    server: String,
    prefix: Option<String>,
    web: String,
    verbose: bool,
    mut stop_rx: watch::Receiver<bool>,
    status_tx: watch::Sender<DaemonStatus>,
    mut control_rx: mpsc::UnboundedReceiver<DaemonControl>,  // NEW (trailing)
) -> Result<()> {
```
Add an arm to the main `tokio::select!` (sync.rs:186):
```rust
Some(ctl) = control_rx.recv() => {
    match ctl {
        DaemonControl::Attach { path, bridge } => {
            let key = resolve_handle_key(&daemon.dir, &path);
            if let Some(h) = daemon.handles.get(&key) {
                let _ = h.bridge_ctl.send(crate::session::BridgeCmd::Attach(bridge));
                let _ = h.fs_tx.send(()); // wake a lazily-idle session so it reconnects
            } else {
                warn!(path = %key.display(), "attach_editor: no linked file at path");
            }
        }
        DaemonControl::Detach { path } => {
            let key = resolve_handle_key(&daemon.dir, &path);
            if let Some(h) = daemon.handles.get(&key) {
                let _ = h.bridge_ctl.send(crate::session::BridgeCmd::Detach);
            }
        }
    }
    publish(&status_tx, &daemon, DaemonState::Running);
}
```

- [ ] **Step 6: Pass an inert control channel from the CLI `sync()`.**

In `sync()` (sync.rs:59):
```rust
let (status_tx, _status_rx) = watch::channel(DaemonStatus::default());
let (_control_tx, control_rx) = mpsc::unbounded_channel::<DaemonControl>();  // CLI never attaches editors
run(dir, server, prefix, web, true, stop_rx, status_tx, control_rx).await
```

- [ ] **Step 7: Run tests + clippy.**

Run:
```bash
cd ~/Code/muesli
cargo test -p muesli-cli
cargo clippy -p muesli-cli -- -D warnings
cargo build -p muesli-cli   # ensure the bin (muesli sync) still builds
```
Expected: PASS, builds, no clippy errors.

- [ ] **Step 8: Commit.**
```bash
git add crates/muesli-cli/src/sync.rs
git commit -m "feat(cli): daemon control channel to attach/detach an editor by path"
```

---

### Task 4: `DaemonHandle` control wiring + `EditorBridges` state (demo_muesli backend)

**Repo/branch:** demo_muesli `feat/auth-remote-workspaces`.

**Files:**
- Modify: `src-tauri/src/sync_daemon/mod.rs`
- Create: `src-tauri/src/editor_bridge/mod.rs`
- Test: `src-tauri/src/editor_bridge/mod.rs` (`#[cfg(test)]` — channel round-trip)

**Interfaces:**
- Consumes: `muesli_cli::sync::{run, DaemonControl}`, `muesli_cli::session::EditorBridge`.
- Produces: `DaemonHandle` holds an `Option<UnboundedSender<DaemonControl>>` set on `start`; `DaemonHandle::attach_editor(path, bridge)`/`detach_editor(path)`. `EditorBridges` managed state mapping `PathBuf → EditorChannels { to_daemon: UnboundedSender<Vec<u8>> }` plus the daemon→editor forwarder.

**Context:** `DaemonHandle` (sync_daemon/mod.rs:32) spawns `sync::run(...)` on `tauri::async_runtime` and currently passes no control channel. `Running` holds `stop_tx`/`status_rx`/`_task`. We add a `control_tx` to `Running` and a new `start` arg path. `sync::run` now takes a trailing `control_rx` (Task 3) — `start` creates the `mpsc::unbounded_channel::<DaemonControl>()`, keeps the sender on `Running`, passes the receiver to `run`.

The editor↔daemon byte path:
- editor → daemon: the `send_editor_frame` command pushes bytes into `EditorChannels.to_daemon` (the `EditorBridge.inbound` sender end held by the daemon side). So when we build a bridge for Attach, we make `let (to_daemon_tx, inbound_rx) = unbounded_channel();` — `inbound_rx` goes into the `EditorBridge`, `to_daemon_tx` is kept in `EditorChannels`.
- daemon → editor: `let (outbound_tx, mut outbound_rx) = unbounded_channel();` — `outbound_tx` goes into the `EditorBridge`; a forwarder task holds `outbound_rx` and `app.emit("editor://frame", FramePayload { path, bytes })` for each frame, until the channel closes (on detach).

- [ ] **Step 1: Write a failing test for `EditorBridges` registration/removal.**

Create `src-tauri/src/editor_bridge/mod.rs` with the test first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn register_then_take_roundtrips_sender() {
        let bridges = EditorBridges::new();
        let p = PathBuf::from("/tmp/x.md");
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        bridges.register(p.clone(), tx);
        assert!(bridges.sender_for(&p).is_some(), "registered path resolves to a sender");
        bridges.remove(&p);
        assert!(bridges.sender_for(&p).is_none(), "removed path no longer resolves");
    }
}
```

- [ ] **Step 2: Run it — expect FAIL (module/type missing).**

Run:
```bash
cd ~/Code/demo_muesli/src-tauri
DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx cargo test editor_bridge::tests::register_then_take
```
Expected: FAIL (unresolved module — `editor_bridge` not declared until Step 5).

- [ ] **Step 3: Implement `EditorBridges` + the forwarder.**

```rust
//! Tier-2 (Plan 3) editor↔daemon IPC bridge state. Maps each open synced file to the
//! channel that carries editor→daemon y-protocols frames; the daemon→editor direction is
//! pumped by a per-attachment forwarder task that emits `editor://frame` Tauri events.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter as _};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

/// Payload of an `editor://frame` event: which file, and one opaque y-protocols frame.
#[derive(Clone, Serialize)]
pub struct FramePayload {
    pub path: String,
    /// One frame, as a byte array (serde → JS number[]; the TauriProvider feeds it to y-protocols).
    pub frame: Vec<u8>,
}

/// Per-open-file editor channels. Holds the sender that `send_editor_frame` pushes into
/// (the `EditorBridge.inbound` producer end).
struct EditorChannels {
    to_daemon: UnboundedSender<Vec<u8>>,
}

/// Managed Tauri state: the set of currently-attached editors.
pub struct EditorBridges {
    map: Mutex<HashMap<PathBuf, EditorChannels>>,
}

impl EditorBridges {
    pub fn new() -> Self {
        Self { map: Mutex::new(HashMap::new()) }
    }

    /// Record the editor→daemon sender for `path`.
    pub fn register(&self, path: PathBuf, to_daemon: UnboundedSender<Vec<u8>>) {
        self.map.lock().unwrap().insert(path, EditorChannels { to_daemon });
    }

    /// The editor→daemon sender for `path`, if attached.
    pub fn sender_for(&self, path: &Path) -> Option<UnboundedSender<Vec<u8>>> {
        self.map.lock().unwrap().get(path).map(|c| c.to_daemon.clone())
    }

    /// Forget `path` (drops the sender; the daemon side sees its inbound channel close).
    pub fn remove(&self, path: &Path) {
        self.map.lock().unwrap().remove(path);
    }
}

/// Pump daemon→editor frames to the frontend as `editor://frame` events until the channel
/// closes (on detach / session end). Spawned per attachment on the Tauri async runtime.
pub fn spawn_forwarder(app: AppHandle, path: String, mut outbound_rx: UnboundedReceiver<Vec<u8>>) {
    tauri::async_runtime::spawn(async move {
        while let Some(frame) = outbound_rx.recv().await {
            if let Err(e) = app.emit("editor://frame", FramePayload { path: path.clone(), frame }) {
                eprintln!("editor_bridge: emit failed: {e}");
                break;
            }
        }
    });
}
```

- [ ] **Step 4: Build the bridge factory used by Attach.**

Add a helper that wires both directions and returns the `EditorBridge` to hand to the daemon (kept in `editor_bridge/mod.rs`):
```rust
use muesli_cli::session::EditorBridge;

/// Create a fresh editor bridge for `path`: register the editor→daemon sender, spawn the
/// daemon→editor forwarder, and return the muesli-cli-side `EditorBridge` to attach.
pub fn build_bridge(app: &AppHandle, bridges: &EditorBridges, path: &Path) -> EditorBridge {
    let (to_daemon_tx, inbound_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let (outbound_tx, outbound_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    bridges.register(path.to_path_buf(), to_daemon_tx);
    spawn_forwarder(app.clone(), path.to_string_lossy().to_string(), outbound_rx);
    EditorBridge { inbound: inbound_rx, outbound: outbound_tx }
}
```

- [ ] **Step 5: Declare the module + add control plumbing to `DaemonHandle`.**

In `sync_daemon/mod.rs`, add `control_tx` to `Running` and set it in `start`:
```rust
struct Running {
    dir: PathBuf,
    stop_tx: watch::Sender<bool>,
    status_rx: watch::Receiver<DaemonStatus>,
    control_tx: mpsc::UnboundedSender<muesli_cli::sync::DaemonControl>,  // NEW
    _task: tauri::async_runtime::JoinHandle<()>,
}
```
In `start`, create the channel and pass it to `run` (note the new trailing arg):
```rust
let (control_tx, control_rx) = mpsc::unbounded_channel::<muesli_cli::sync::DaemonControl>();
…
let _task = tauri::async_runtime::spawn(async move {
    let _ = sync::run(run_dir, server, None, web, false, stop_rx, status_tx, control_rx).await;
});
*guard = Some(Running { dir, stop_tx, status_rx, control_tx, _task });
```
Add attach/detach methods on `DaemonHandle`:
```rust
/// Attach an editor bridge to the running daemon's session for `path`. No-op if not running.
pub fn attach_editor(&self, path: PathBuf, bridge: muesli_cli::session::EditorBridge) {
    if let Some(r) = self.inner.lock().unwrap().as_ref() {
        let _ = r.control_tx.send(muesli_cli::sync::DaemonControl::Attach { path, bridge });
    }
}
/// Detach any editor from the running daemon's session for `path`. No-op if not running.
pub fn detach_editor(&self, path: PathBuf) {
    if let Some(r) = self.inner.lock().unwrap().as_ref() {
        let _ = r.control_tx.send(muesli_cli::sync::DaemonControl::Detach { path });
    }
}
```
Add `tokio::sync::mpsc` to the `use` block if absent (`use tokio::sync::{mpsc, watch};`).

In `lib.rs`, add `mod editor_bridge;` (next to `mod sync_daemon;`).

- [ ] **Step 6: Run the test + build.**

Run:
```bash
cd ~/Code/demo_muesli/src-tauri
DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx cargo test editor_bridge
DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx cargo build
```
Expected: test PASS; build OK (only the pre-existing `ParakeetPaths` warning).

- [ ] **Step 7: Commit.**
```bash
cd ~/Code/demo_muesli
git add src-tauri/src/editor_bridge/mod.rs src-tauri/src/sync_daemon/mod.rs src-tauri/src/lib.rs
git commit -m "feat: editor-bridge state + daemon control wiring for Tier-2 IPC"
```

---

### Task 5: Tauri commands — attach/detach/send_frame (demo_muesli backend)

**Repo/branch:** demo_muesli `feat/auth-remote-workspaces`.

**Files:**
- Modify: `src-tauri/src/sync_cmd.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `DaemonHandle::{attach_editor, detach_editor}`, `EditorBridges::{build_bridge via module fn, sender_for, remove}`.
- Produces: three Tauri commands — `attach_editor(path)`, `detach_editor(path)`, `send_editor_frame(path, frame)`.

**Context:** `sync_cmd.rs` holds the Plan-2 commands; the pattern is `State<'_, DaemonHandle>` + `map_err(|e| format!("{e:#}"))`. Commands needing the app handle take `app: AppHandle` (see `commands.rs::ensure_model`). `send_editor_frame` carries one y-protocols frame from the JS provider into the daemon via the registered `to_daemon` sender.

- [ ] **Step 1: Add the three commands.**

In `sync_cmd.rs`:
```rust
use tauri::{AppHandle, State};
use std::path::PathBuf;
use crate::editor_bridge::{self, EditorBridges};
use crate::sync_daemon::DaemonHandle;

/// Attach the open editor at `path` to the daemon's replica (Tier-2). Builds the IPC bridge,
/// registers the editor→daemon channel, spawns the daemon→editor forwarder, and tells the
/// daemon to attach. Returns Ok even if the daemon isn't running (the attach is a no-op then).
#[tauri::command]
pub fn attach_editor(
    app: AppHandle,
    path: String,
    daemon: State<'_, DaemonHandle>,
    bridges: State<'_, EditorBridges>,
) -> Result<(), String> {
    let pb = PathBuf::from(&path);
    let bridge = editor_bridge::build_bridge(&app, &bridges, &pb);
    daemon.attach_editor(pb, bridge);
    Ok(())
}

/// Detach the editor at `path`: tell the daemon to drop the bridge and forget our channels.
#[tauri::command]
pub fn detach_editor(
    path: String,
    daemon: State<'_, DaemonHandle>,
    bridges: State<'_, EditorBridges>,
) -> Result<(), String> {
    let pb = PathBuf::from(&path);
    daemon.detach_editor(pb.clone());
    bridges.remove(&pb);
    Ok(())
}

/// Forward one y-protocols frame from the JS provider into the daemon's session for `path`.
#[tauri::command]
pub fn send_editor_frame(
    path: String,
    frame: Vec<u8>,
    bridges: State<'_, EditorBridges>,
) -> Result<(), String> {
    let pb = PathBuf::from(&path);
    match bridges.sender_for(&pb) {
        Some(tx) => tx.send(frame).map_err(|_| "editor bridge closed".to_string()),
        None => Ok(()), // not attached (e.g. local-only file) — drop silently
    }
}
```

- [ ] **Step 2: Register state + commands in `lib.rs`.**

Add the managed state after `.manage(sync_daemon::DaemonHandle::new())`:
```rust
.manage(editor_bridge::EditorBridges::new())
```
Append to `generate_handler!`:
```rust
sync_cmd::attach_editor,
sync_cmd::detach_editor,
sync_cmd::send_editor_frame,
```

- [ ] **Step 3: Build.**

Run:
```bash
cd ~/Code/demo_muesli/src-tauri
DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx cargo build
```
Expected: OK (only the pre-existing warning). No new commands unused (they're in `generate_handler!`).

- [ ] **Step 4: Commit.**
```bash
cd ~/Code/demo_muesli
git add src-tauri/src/sync_cmd.rs src-tauri/src/lib.rs
git commit -m "feat: Tauri commands to attach/detach editor + relay y-protocols frames"
```

---

### Task 6: `TauriProvider` + `createTauriSession` (demo_muesli frontend)

**Repo/branch:** demo_muesli `feat/auth-remote-workspaces`.

**Files:**
- Create: `src/lib/sync/tauri-provider.ts`
- Modify: `src/lib/sync/session.ts` (widen `Session` types so both providers fit)
- Modify: `src/lib/tauri.ts` (invoke wrappers + event helper)
- Modify: `package.json` (add `y-protocols`, `lib0` as direct deps)
- Test: `src/lib/sync/tauri-provider.test.ts` (vitest — frame round-trip with a mocked transport)

**Interfaces:**
- Consumes: `attachEditor`, `detachEditor`, `sendEditorFrame`, `onEditorFrame` (tauri.ts); `y-protocols/sync`, `y-protocols/awareness`, `lib0/encoding`, `lib0/decoding`, `yjs`.
- Produces: `createTauriSession({ path, identity }): Session` (drop-in for `createSession`).

**Context:** `createSession` (session.ts:37) returns `{ ydoc, ytext, provider, awareness, onSynced, onStatus, destroy }` backed by `WebsocketProvider`. The `Session.provider` field is typed `WebsocketProvider`; widen it so a `TauriProvider` also satisfies the interface (EditorPane only calls `yCollab(ytext, awareness, …)` + the `onSynced/onStatus/destroy` methods; it does not touch `provider` directly in the synced path — verify during implementation and, if it does, route through the interface). The `TauriProvider` mirrors `y-websocket`'s message handling exactly: incoming bytes → if first varint is `messageSync(0)` feed `syncProtocol.readSyncMessage`, if `messageAwareness(1)` feed `awarenessProtocol.applyAwarenessUpdate`; outgoing on `doc.on('update')` → `writeUpdate`, on `awareness.on('update')` → `encodeAwarenessUpdate`. Transport = Tauri IPC: send via `sendEditorFrame(path, bytes)`, receive via the `editor://frame` event filtered to this `path`.

- [ ] **Step 1: Add the deps.**

```bash
cd ~/Code/demo_muesli
pnpm add y-protocols lib0
```
(These are already transitively present via yjs/y-websocket; this pins direct imports. Versions resolve to the same instances — no duplicate yjs.)

- [ ] **Step 2: Add tauri.ts wrappers + the frame event helper.**

In `src/lib/tauri.ts`:
```typescript
import { listen } from "@tauri-apps/api/event";

export const attachEditor = (path: string): Promise<void> =>
  invoke("attach_editor", { path });
export const detachEditor = (path: string): Promise<void> =>
  invoke("detach_editor", { path });
export const sendEditorFrame = (path: string, frame: number[]): Promise<void> =>
  invoke("send_editor_frame", { path, frame });

export interface EditorFrame { path: string; frame: number[]; }
/** Subscribe to daemon→editor frames. Returns an unsubscribe fn. */
export function onEditorFrame(cb: (e: EditorFrame) => void): Promise<() => void> {
  return listen<EditorFrame>("editor://frame", (event) => cb(event.payload));
}
```

- [ ] **Step 3: Write the failing vitest for frame round-trip.**

Create `src/lib/sync/tauri-provider.test.ts`. Mock the transport (no real IPC): the test wires two `TauriProvider`s into a shared in-memory bus and asserts a text edit on doc A converges to doc B and that awareness propagates. Use the provider's injectable transport seam (Step 4 exposes `_test` hooks).

```typescript
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { makeTauriProvider } from "./tauri-provider";

// A synchronous in-memory bus standing in for daemon relay: every frame sent by one
// provider is delivered to the other (the daemon would echo edits between peers).
function pair() {
  const peers: Array<(f: Uint8Array) => void> = [];
  const make = (doc: Y.Doc, idx: number) =>
    makeTauriProvider({
      doc,
      path: "/x.md",
      send: (f) => queueMicrotask(() => peers[1 - idx]?.(f)),
      subscribe: (cb) => { peers[idx] = cb; return () => {}; },
      identity: { name: "U", color: "#a882ff", colorLight: "#a882ff33", kind: "human" },
    });
  return make;
}

describe("TauriProvider", () => {
  it("converges text edits across two providers", async () => {
    const make = pair();
    const a = new Y.Doc(); const b = new Y.Doc();
    const pa = make(a, 0); const pb = make(b, 1);
    a.getText("content").insert(0, "hello");
    await new Promise((r) => setTimeout(r, 20));
    expect(b.getText("content").toString()).toBe("hello");
    pa.destroy(); pb.destroy();
  });

  it("propagates awareness state", async () => {
    const make = pair();
    const a = new Y.Doc(); const b = new Y.Doc();
    const pa = make(a, 0); const pb = make(b, 1);
    pa.awareness.setLocalStateField("user", { name: "Ada", color: "#f00" });
    await new Promise((r) => setTimeout(r, 20));
    const states = [...pb.awareness.getStates().values()];
    expect(states.some((s) => s.user?.name === "Ada")).toBe(true);
    pa.destroy(); pb.destroy();
  });
});
```

- [ ] **Step 4: Run it — expect FAIL (no `makeTauriProvider`).**

Run: `cd ~/Code/demo_muesli && pnpm vitest run src/lib/sync/tauri-provider.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 5: Implement `tauri-provider.ts`.**

```typescript
// A drop-in for y-websocket's WebsocketProvider whose transport is Tauri IPC to the
// Rust-owned replica (Plan 3, Tier-2). Mirrors y-websocket's message handling exactly —
// only the bytes go over `invoke`/events instead of a socket. Frames are y-protocols
// wire-compatible with muesli_core::protocol (the server already speaks them).
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates }
  from "y-protocols/awareness";
import { readSyncMessage, writeSyncStep1, writeUpdate, writeSyncStep2 }
  from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { attachEditor, detachEditor, sendEditorFrame, onEditorFrame } from "$lib/tauri";
import type { Session, SyncStatus } from "./session";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

export interface PresenceIdentity {
  name: string; color: string; colorLight: string; kind: "human" | "agent";
}

// Injectable transport so the provider is unit-testable without real IPC.
interface Transport {
  doc: Y.Doc;
  path: string;
  identity: PresenceIdentity;
  send: (frame: Uint8Array) => void;
  subscribe: (cb: (frame: Uint8Array) => void) => () => void;
}

export interface TauriProviderLike {
  doc: Y.Doc;
  awareness: Awareness;
  onSynced(cb: () => void): void;
  onStatus(cb: (s: SyncStatus) => void): void;
  destroy(): void;
}

/** Core provider over an injectable transport (used directly by tests). */
export function makeTauriProvider(t: Transport): TauriProviderLike {
  const { doc, identity } = t;
  const awareness = new Awareness(doc);
  awareness.setLocalStateField("user", {
    name: identity.name, color: identity.color, colorLight: identity.colorLight, kind: identity.kind,
  });

  let synced = false;
  const syncedCbs: Array<() => void> = [];
  const statusCbs: Array<(s: SyncStatus) => void> = [];
  const fireSynced = () => { if (!synced) { synced = true; syncedCbs.forEach((c) => c()); } };

  // ── Outbound: doc updates + awareness updates → frames ─────────────────────
  const onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === provider) return; // don't echo what we just applied
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    writeUpdate(enc, update);
    t.send(encoding.toUint8Array(enc));
  };
  const onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === "remote") return;
    const changed = added.concat(updated, removed);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(enc, encodeAwarenessUpdate(awareness, changed));
    t.send(encoding.toUint8Array(enc));
  };

  // A stable origin token so we can ignore our own applied updates.
  const provider = { doc, awareness } as unknown as TauriProviderLike;

  // ── Inbound: frames → readSyncMessage / applyAwarenessUpdate ───────────────
  const onFrame = (frame: Uint8Array) => {
    const dec = decoding.createDecoder(frame);
    const messageType = decoding.readVarUint(dec);
    if (messageType === MESSAGE_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      const syncMessageType = readSyncMessage(dec, enc, doc, provider);
      // readSyncMessage writes a reply into `enc` for step1; flush it if non-empty.
      if (encoding.length(enc) > 1) t.send(encoding.toUint8Array(enc));
      // First sync round-trip completed → mark synced.
      if (syncMessageType === 1 /* messageYjsSyncStep2 */ || syncMessageType === 0) fireSynced();
    } else if (messageType === MESSAGE_AWARENESS) {
      applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), "remote");
    }
  };

  doc.on("update", onDocUpdate);
  awareness.on("update", onAwarenessUpdate);
  const unsub = t.subscribe(onFrame);

  // Kick off the handshake: send our state vector (step1), exactly like y-websocket on open.
  {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    writeSyncStep1(enc, doc);
    t.send(encoding.toUint8Array(enc));
  }

  return {
    doc,
    awareness,
    onSynced(cb) { if (synced) cb(); else syncedCbs.push(cb); },
    onStatus(cb) { statusCbs.push(cb); cb("connected"); /* IPC has no socket; treat as connected */ },
    destroy() {
      doc.off("update", onDocUpdate);
      awareness.off("update", onAwarenessUpdate);
      removeAwarenessStates(awareness, [doc.clientID], "local");
      unsub();
    },
  };
}

/** Drop-in Session backed by Tauri IPC to the daemon replica. */
export function createTauriSession(opts: { path: string; identity: PresenceIdentity }): Session {
  const { path, identity } = opts;
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");

  let unlistenP: Promise<() => void> | null = null;
  const subscribers: Array<(f: Uint8Array) => void> = [];

  const provider = makeTauriProvider({
    doc: ydoc,
    path,
    identity,
    send: (frame) => { void sendEditorFrame(path, Array.from(frame)); },
    subscribe: (cb) => {
      subscribers.push(cb);
      return () => { const i = subscribers.indexOf(cb); if (i >= 0) subscribers.splice(i, 1); };
    },
  });

  // Bridge the Tauri event stream into the provider's subscribe callback.
  unlistenP = onEditorFrame((e) => {
    if (e.path !== path) return;
    const bytes = Uint8Array.from(e.frame);
    subscribers.forEach((cb) => cb(bytes));
  });
  // Tell the daemon to attach this open file (creates the bridge on the Rust side).
  void attachEditor(path);

  return {
    ydoc,
    ytext,
    // The Session interface is widened (Step 6) so this provider shape type-checks.
    provider: provider as unknown as Session["provider"],
    awareness: provider.awareness as unknown as Session["awareness"],
    onSynced: (cb) => provider.onSynced(cb),
    onStatus: (cb) => provider.onStatus(cb),
    destroy() {
      provider.destroy();
      void detachEditor(path);
      unlistenP?.then((u) => u());
      ydoc.destroy();
    },
  };
}
```

> Implementer note: `readSyncMessage`'s return value constants (`messageYjsSyncStep1=0`, `messageYjsSyncStep2=1`, `messageYjsUpdate=2`) come from `y-protocols/sync`. The `fireSynced()` trigger should match y-websocket's semantics (synced once the first step2 is processed). Verify against the installed `y-protocols` version during implementation and adjust the constant if the package exports a helper. Keep the awareness `origin` sentinel (`"remote"`/`"local"`) consistent so we never echo.

- [ ] **Step 6: Widen the `Session` interface types.**

In `session.ts`, change the strict `WebsocketProvider` types to a structural supertype so both providers fit. Minimal change:
```typescript
// Both providers expose an `awareness` (y-protocols Awareness) and the lifecycle methods
// EditorPane uses; the concrete provider type is intentionally opaque at this seam.
export interface Session {
  ydoc: Y.Doc;
  ytext: Y.Text;
  provider: unknown;
  awareness: import("y-protocols/awareness").Awareness;
  onSynced(cb: () => void): void;
  onStatus(cb: (s: SyncStatus) => void): void;
  destroy(): void;
}
```
Keep `createSession` working: its `provider` (a `WebsocketProvider`) and `awareness` still assign to `unknown`/`Awareness`. (`WebsocketProvider["awareness"]` IS a y-protocols `Awareness`, so the type lines up.)

- [ ] **Step 7: Run the vitest + `pnpm check`.**

Run:
```bash
cd ~/Code/demo_muesli
pnpm vitest run src/lib/sync/tauri-provider.test.ts
pnpm check
```
Expected: tests PASS; `pnpm check` → 0 errors / 0 warnings. Fix any type fallout from the `Session` widening (e.g. an `as` cast where EditorPane reads `provider`).

- [ ] **Step 8: Commit.**
```bash
git add src/lib/sync/tauri-provider.ts src/lib/sync/tauri-provider.test.ts src/lib/sync/session.ts src/lib/tauri.ts package.json pnpm-lock.yaml
git commit -m "feat: TauriProvider — y-protocols sync+awareness over Tauri IPC (drop-in Session)"
```

---

### Task 7: EditorPane integration — attach the provider, drop the poll (demo_muesli frontend)

**Repo/branch:** demo_muesli `feat/auth-remote-workspaces`.

**Files:**
- Modify: `src/lib/EditorPane.svelte`
- Reference (read for identity): `src/lib/auth*.ts` / wherever Plan 1 stored `/api/me` identity; `src/lib/workspaces.svelte.ts`

**Interfaces:**
- Consumes: `createTauriSession`, `createSession`, `daemon.status`, the workspace identity from Plan 1.
- Produces: the open editor uses `TauriProvider` (live cursors) when the daemon is running for a synced file; the Plan-2 1s disk-poll `$effect` is removed.

**Context:** EditorPane currently computes `const useSync = settings.syncEnabled && !daemon.status?.running;` (EditorPane.svelte:82) and, when `useSync`, builds a `createSession` (WebsocketProvider) + `yCollab`. Separately a Plan-2 `$effect` polls disk every 1s while the daemon runs (the block the agent identified at ~lines 233-262). Plan 3: when the daemon IS running for this file, use `createTauriSession` instead (and skip the poll); when the daemon is NOT running but `settings.syncEnabled` (legacy local-server dev mode), keep `createSession`; otherwise no sync.

Identity for presence: cursor color is **derived deterministically from the user-id** (spec §"Presence / identity"). Use the Plan-1 `/api/me` identity (email/sub). If identity isn't readily available in the editor, derive a stable color from the user id string via a small hash → hue; fall back to the existing `#a882ff` for local-only.

- [ ] **Step 1: Add a deterministic color helper (co-located in EditorPane or a small util).**

```typescript
// Stable cursor color from a user id (spec: color derived from user-id).
function colorFromId(id: string): { color: string; colorLight: string } {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  return { color: `hsl(${hue} 70% 60%)`, colorLight: `hsl(${hue} 70% 60% / 0.2)` };
}
```

- [ ] **Step 2: Choose the provider at open-time.**

Replace the `useSync` decision + session construction so that:
```typescript
// Tier-2 (Plan 3): when the daemon owns this workspace, attach the open editor to its
// replica over IPC for live cursors. Legacy per-note websocket sync only when the daemon
// is NOT running (local-server dev mode).
const daemonRunning = !!daemon.status?.running;
const useTauriSync = daemonRunning;                       // synced workspace is open
const useWsSync = !daemonRunning && settings.syncEnabled; // legacy path
```
Where the code currently does `if (useSync) { … createSession … }`, branch:
```typescript
if (useTauriSync || useWsSync) {
  const identity = /* Plan-1 workspace identity, or null for local-only */ getWorkspaceIdentity();
  const { color, colorLight } = identity ? colorFromId(identity.id) : { color: "#a882ff", colorLight: "#a882ff33" };
  session = useTauriSync
    ? createTauriSession({ path, identity: { name: identity?.name ?? "You", color, colorLight, kind: "human" } })
    : createSession({ slug: deriveSlug(relativeToWorkspace(path)), wsBase: settings.wsBase });
  const sess = session;
  // … existing onStatus / readNote / createEditor(yCollab(sess.ytext, sess.awareness, …)) flow unchanged …
}
```
The rest of the synced open flow (status wiring, `readNote` seed, `createEditor` with `yCollab`, the `ready`-gated saver) is provider-agnostic and stays. Verify `import { createTauriSession } from "$lib/sync/tauri-provider";` is added.

- [ ] **Step 3: Remove the Plan-2 1s disk-poll `$effect`.**

Delete the whole `$effect` that polls `readNote(path)` every 1000ms while `daemon.status?.running` (the block the Plan-2 review added; ~EditorPane.svelte:233-262). With the TauriProvider, disk→editor liveness now flows through the daemon's ingest→bridge path (Task 2 disk-ingest arm forwards updates to the editor). Leave the non-synced (plain-disk) open path untouched.

- [ ] **Step 4: Type-check + build the app.**

Run:
```bash
cd ~/Code/demo_muesli
pnpm check
```
Expected: 0 errors / 0 warnings. Resolve identity-accessor details against the actual Plan-1 code (the implementer reads `workspaces.svelte.ts`/auth for the real getter; if no per-editor identity exists yet, use the local-only fallback color and leave a `// TODO(plan3): real identity` only if genuinely unavailable — prefer wiring the real `/api/me` id).

- [ ] **Step 5: Commit.**
```bash
git add src/lib/EditorPane.svelte
git commit -m "feat: open editor attaches to daemon replica (live cursors); drop 1s disk poll"
```

---

### Task 8: StatusBar presence affordance (demo_muesli frontend) — small, optional-but-in-scope

**Repo/branch:** demo_muesli `feat/auth-remote-workspaces`.

**Files:**
- Modify: `src/lib/StatusBar.svelte`

**Interfaces:**
- Consumes: the open session's `awareness` (peer count via `awareness.getStates()`), `daemon.status`.
- Produces: a tiny "N present" indicator when ≥2 peers share the open doc.

**Context:** The StatusBar already shows daemon sync state (Plan 2). Add a minimal co-presence count so live cursors have a textual companion. Keep it cheap: subscribe to the active session's awareness `change` event, show `getStates().size` when > 1. If surfacing the active awareness to StatusBar is awkward (no shared store), expose the current peer count from a tiny runes store updated by EditorPane's session, and read it here. Do not over-build a presence facepile (that's polish beyond Plan 3's bar).

- [ ] **Step 1:** Add a `presence` runes store (`src/lib/sync/presence.svelte.ts`): `{ peers: $state(0) }`, set by EditorPane from `awareness.on("change", () => presence.peers = sess.awareness.getStates().size)` and reset to 0 on destroy/local-only.
- [ ] **Step 2:** In `StatusBar.svelte`, when `daemon.status?.running && presence.peers > 1`, render `{presence.peers} editing` with the existing status styling.
- [ ] **Step 3:** Wire EditorPane to update `presence` in the synced open path (and clear on `destroy`).
- [ ] **Step 4:** `pnpm check` → 0/0. Commit:
```bash
git add src/lib/StatusBar.svelte src/lib/sync/presence.svelte.ts src/lib/EditorPane.svelte
git commit -m "feat: co-presence count in the status bar"
```

---

### Task 9: Integration verification (manual + automated)

**Repo/branch:** both.

**Files:** none (verification only).

**Context:** Plan 2's live verification needed Julian's keychain-authorized session (a fresh test binary hits a per-binary Keychain ACL). Same here for the authenticated two-client cursor test. Do every automatable check; hand Julian the manual round-trip.

- [ ] **Step 1 (automated): full Rust suites + builds, both repos.**
```bash
cd ~/Code/muesli && cargo test -p muesli-cli && cargo clippy -p muesli-cli -- -D warnings && cargo build -p muesli-cli
cd ~/Code/demo_muesli/src-tauri && \
  DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx cargo test && \
  DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx cargo build
```
Expected: all green (only the pre-existing `ParakeetPaths` warning).

- [ ] **Step 2 (automated): frontend.**
```bash
cd ~/Code/demo_muesli && pnpm vitest run && pnpm check
```
Expected: tests pass; check 0/0.

- [ ] **Step 3 (manual, needs Julian's session — document, don't block):**
  1. Start the dev server stack (`cd ~/Code/muesli && docker compose up -d postgres redis dex` + run `muesli-server` in OIDC mode).
  2. Launch demo_muesli, open the cloned workspace (daemon starts), open a note.
  3. In the muesli **web app**, open the same doc. Type in the web app → glyphs appear in demo_muesli **instantly** (no ~1s lag) with a remote cursor; type in demo_muesli → appears in the web app with a cursor.
  4. Confirm the on-disk `.md` still updates (Tier-1 materialize unaffected).
  5. Close the note in demo_muesli → remote cursor disappears in the web app within a moment (detach removes awareness).
  6. Kill the server mid-edit, keep typing in demo_muesli, restart server → edits reconcile (Tier-1 reconnect path, unchanged).

- [ ] **Step 4:** Record the outcome in `.superpowers/sdd/progress.md`; leave the two branches unmerged for Julian.

---

## Self-Review (checklist run against the spec)

- **Spec §"Two tiers, one replica" / line 50-52:** Tier-2 attaches the editor to the daemon's replica via IPC, not a second server connection — Tasks 2-7. ✓
- **Spec §"IPC bridge" line 62:** Tauri commands/events carry y-sync updates + awareness for the open doc — Tasks 4-6. ✓
- **Spec §"TauriProvider" line 66:** drop-in for WebsocketProvider; `yCollab` binds unchanged — Task 6 (same `Session` surface), Task 7 (yCollab call unchanged). ✓
- **Spec line 94:** open doc's JS Y.Doc in lockstep via TauriProvider; disk edits flow to the open editor — Task 2 disk-ingest fan-out + Task 7 poll removal. ✓
- **Spec §"Presence / identity" line 104-105:** awareness `{name,color,kind}`, color from user-id, peers relayed server→Rust→IPC→editor; local-only has no presence — Task 6 (awareness), Task 7 (`colorFromId`, local-only fallback). ✓
- **Spec §"TauriProvider conformance" line 124:** golden round-trip test — Task 6 vitest (two providers converge + awareness). ✓
- **Spec §"Integration" line 125:** two clients converge on disk + mirrored cursors — Task 9 Step 3 (manual, needs Julian). ✓
- **Agent (`kind:"agent"`) downgrade policy line 105:** server-enforced; client just renders edits+presence — no client work needed; `kind` field carried by awareness. ✓ (no task; correctly out of scope)
- **Placeholder scan:** the one deliberate deferral is Task 7's identity getter ("read the actual Plan-1 code") — bounded, with a concrete fallback, not a blank TODO. ✓
- **Type consistency:** `EditorBridge { inbound, outbound }`, `BridgeCmd::{Attach,Detach}`, `DaemonControl::{Attach,Detach}`, `FrameOut { reply, delta, awareness }`, `createTauriSession({path,identity})`, `Session.provider: unknown` — names consistent across tasks. ✓
