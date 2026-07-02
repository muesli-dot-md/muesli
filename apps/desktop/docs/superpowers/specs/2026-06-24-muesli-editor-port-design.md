# Porting muesli's Web Editor Functionality into demo_muesli — Design

> Status: brainstormed & approved by Julian 2026-06-24 (build all three phases;
> app points at a separately-run muesli-server via a dev script). Branch
> `feat/muesli-editor-port` off `feat/obsidian-editor`.

## Goal

Bring the **full markdown-editor functionality of muesli's web app**
(`~/Code/muesli/apps/web`) into the demo_muesli desktop app: the rich editing
surface, the formatting top bar, presence, **comments / suggestions / history**,
and live sync — while keeping demo_muesli's **local file-vault** model. Fold the
existing **meeting recording** into the CRDT editor as a toggle.

## Context & key facts (from investigation)

- muesli's web app is the **same stack** as demo_muesli (Svelte 5 runes + CodeMirror 6
  + DaisyUI/Tailwind v4), so most of it is **portable as actual source**, not a
  reimplement.
- The document **text is pure-CRDT** (rides the y-websocket we already connect
  to): sync, presence, live-preview, toolbar, export.
- **Comments, suggestions, and history are a parallel REST API** on the same
  origin (`http://<host>/api/documents/<slug>/…`) backed by **Postgres**. They
  work in the server's **open mode** (no OIDC) with **anonymous authorship**; the
  only new dependency is a Postgres container. Ranges are addressed in **UTF-8
  byte offsets** (server) vs UTF-16 (CM/Yjs) — muesli's `offsets.ts` conversion
  must be carried over verbatim at the REST boundary.
- **Sharing / named identity / workspaces require the full OIDC+Redis stack** and
  a second user — **out of scope** for this single-user local app.
- muesli's collab store already **degrades gracefully**: with the server/Postgres
  absent it shows collab as "unavailable" rather than failing. So the desktop app
  is a fully working local editor with the server off; collab lights up when it's
  on.
- demo_muesli is a **local file vault** (files on disk, file-tree sidebar, tabs,
  per-note `Y.Doc`/`Y.Text("content")` at `ws://localhost:8787/ws/<slug>`, slug =
  `deriveSlug(relPath)`). muesli's web app is a **Drive-style cloud app**
  (documents = Postgres rows, Home dashboard, folders, workspaces). We keep **our**
  model and drop muesli's Drive/account/workspace layers.

## Architecture

Keep demo_muesli's vault + tabs + sync. Graft muesli's editor and collab chrome
onto a note opened from the vault. The note's `ws://…/ws/<slug>` sync connection
and the collab REST calls to `…/api/documents/<slug>/…` address the **same doc**
(connecting to `/ws/<slug>` auto-creates the server's `documents` row), so
comments/suggestions/history attach with no extra identity and anonymous
authorship.

**Server runtime (approved):** the desktop app connects to a **separately-run**
`muesli-server`. We ship a one-command dev script that brings up the local
Postgres container and runs the server in open mode. The app never bundles or
spawns the server. Collab features are gated on reachability and degrade to
"unavailable" when it's off.

**Port-and-adapt, don't reimplement:** copy muesli's actual source files and
re-wire their seams (identity, document-open-from-vault, REST base URL) to
demo_muesli. This keeps the code battle-tested and close to muesli for later
fold-back.

### What we PORT vs DROP vs ADAPT

**Port (largely as-is):**
- `livePreview/` bundle: `index.ts`, `inline.ts`, `blocks.ts`, `transform.ts`,
  `widgets.ts`, `languages.ts` (tables, KaTeX math, mermaid, wikilinks, images,
  callouts, frontmatter, fenced-code highlighting, task checkboxes).
- `Toolbar.svelte` + `mdCommands.ts` (block/inline/list commands, insert
  snippets, outline parse).
- `render.ts` (marked + DOMPurify + KaTeX) + `docExport.ts` (Markdown / HTML /
  PDF) + `mermaid.ts`.
- `annotations.ts` (CM6 comment/suggestion/flash decoration StateFields +
  click handler), `offsets.ts` (byte↔UTF-16), `collabStore.svelte.ts`,
  `collabApi.ts`.
- `Sidebar.svelte`, `CommentsPanel.svelte`, `SuggestionsPanel.svelte`,
  `HistoryPanel.svelte`, `OutlineRail.svelte`, `ContextMenu.svelte`,
  `ThemeModeControl.svelte`, `time.ts`.

**Adapt (re-wire seams):**
- `Editor.svelte` → mount inside our `EditorPane`/tab host; keep our sync session
  (`src/lib/sync/session.ts`) but compose muesli's extension stack (livePreview +
  collab decorations + comment click + yCollab) instead of our simpler editor.
- `identity.ts` → derive `httpBase` from our `settings.wsBase`
  (`ws→http`, strip `/ws`); provide an **anonymous local identity** (muesli's
  food-word name + color palette) for awareness + comment authorship.
- Document title / rename → use the **vault filename** (our tree rename), not
  muesli's `/api/documents` title.
- Top bar (`DocApp.svelte` header) → adapt into our shell's top bar: presence
  avatars, sync-status dot, record toggle (Phase 3), export. Drop the
  Share/Account/Home/Workspace controls.

**Drop (out of scope):** `Home.svelte`, `WorkspacePanel.svelte`,
`SettingsPage.svelte` + `settings/`, `AccountMenu.svelte`, `route.svelte.ts`
(hash router), `workspaceApi.ts`/`accountApi.ts` sharing+workspace+storage paths,
sharing UI, `GraphView.svelte` (defer), `SearchPalette.svelte` server-doc search
(defer; our vault search is separate/deferred). `App.svelte` router shell — we
keep our `AppShell`.

## Phase decomposition (each its own spec → plan → build, in order)

### Phase 1 — Rich editor surface (frontend-only, no backend)
Replace demo_muesli's basic editor (Tasks 6/10 of the prior branch) with muesli's
`livePreview/` bundle + `Toolbar` + `mdCommands` + `render`/`docExport`/`mermaid`.
Editing stays disk-autosave + sync as today; this strictly upgrades the editing
experience (tables, math, mermaid, wikilinks, callouts, export). Independently
shippable. Outline rail optional within this phase.

### Phase 2 — Collaboration layer (needs local muesli-server + Postgres)
- Presence: awareness identity + avatar row in the top bar + remote cursors
  (yCollab already gives cursors; add the avatar UI + identity).
- Comments: `collabStore` + `collabApi` + `annotations` + `Sidebar` +
  `CommentsPanel`, wired to `…/api/documents/<slug>/…` with `offsets.ts`
  conversion; reachability-gated with graceful "unavailable".
- Suggestions: Editing/Suggesting mode toggle + draft composer + change-set
  review (`SuggestionsPanel`), `/suggestions` REST.
- History: versions tab + read-only time-travel snapshot modal (`HistoryPanel`,
  `/history` + `/text?seq=`).
- Dev stack: a script (e.g. `scripts/dev-server.sh`) that runs
  `docker compose up -d postgres` in `~/Code/muesli` and `cargo run -p
  muesli-server` with `DATABASE_URL` set (open mode). Document the workflow.

### Phase 1.5 — Obsidian-style shell (added 2026-06-24 from Julian's screenshots)
Reshape the app chrome to mirror Obsidian (Julian's UI north star), built AFTER Phase 1
and BEFORE Phase 2 (so the right sidebar exists to hold Phase 2's comments/history).
Decisions (approved): **frameless window** with a macOS **overlay title bar** (native
traffic lights kept) so the **tab bar sits up in the title strip** like Obsidian; **no left
ribbon** for now (revisit when there are real views to host).
- **Top bar (three zones):** far-left **collapse-left-sidebar** toggle next to the traffic
  lights; the **tab bar** in the title strip (tabs + `×` close + `+` new); far-right
  **collapse-right-sidebar** toggle.
- **Right sidebar (new, collapsible):** the home for Phase 2 collab panels (comments,
  history) — seed it now with the **Outline** (headings via `parseOutline`, ported in
  Phase 1) as a useful first tenant + reserved tabs for collab.
- **File-explorer header icons (Obsidian layout + glyphs):** a compact row under the vault
  header — **new note**, **new folder**, **sort** (name asc/desc / modified), **collapse
  all**. Match Obsidian's icon choices and placement.
- **KEEP** (Julian likes them): the **top vault switcher**, and the **new-file/new-folder**
  buttons.
- **Auto-reload** the open vault via a Rust **`notify`** filesystem watcher emitting change
  events to the frontend; **remove the manual refresh button** (it should self-refresh).
- **Status bar** aligned to Obsidian's bottom-right look (backlinks placeholder / word +
  char count / sync indicator — we already have words/chars/sync).
- Out of scope here: the left ribbon, plugin views, split panes.

### Phase 1.6 — Arc-style depth/elevation redesign (added 2026-06-24 from Julian's Arc screenshot)
Reskin the shell with Arc browser's **elevation/layering** aesthetic. Decisions (approved):
**build BOTH a light and a dark "arc" theme with a toggle** (light/dark/system).
- **Elevation model:** L0 = tinted window background (floor); L1 = floating panes + lifted
  active items (raised, with soft shadow + radius). In dark mode, raised = *lighter* surface;
  in light mode, raised = white card on a pale tinted (lavender/periwinkle) floor.
- **Editor pane (right):** a rounded card inset from the window edges with a soft shadow —
  "the browser pane" floating above the floor.
- **File explorer (left):** flat on the tinted floor; the **active file lifts** into a rounded
  shadowed pill (L1); inactive items flat/muted; hover = subtle translucent overlay.
- **Tabs:** stay on TOP (not left). Layered/floating: **active tab raised & connected** to the
  editor card below it; **inactive tabs recessed** on the floor. Keep `×` close + `+` new.
- **Theme toggle:** light / dark / system, **defaulting to system** (follows the OS appearance
  via `prefers-color-scheme`; updates live when the OS flips). Persisted (extend the existing
  settings store). Both light and dark are "arc" depth themes.
- Concrete values (radii, shadow tokens, tint palette, DaisyUI token mapping for both themes)
  come from a dedicated Arc-UI analysis (in progress).

### Phase 3 — Meeting recording in the CRDT editor
Reuse the existing audio pipeline (mic with macOS AEC + ScreenCaptureKit system
audio + on-device Parakeet + VAD). Change the **output**: finalized transcript
lines insert into the **live `ytext`** of the target note (speaker-attributed
"**You** — MM:SS" blocks appended at the end), so the transcript streams into the
editor, syncs, and is immediately editable/commentable.
- **Top-bar record toggle** → transcribe into the currently open note.
- **"Start meeting note" command** → create a fresh timestamped note, open it,
  start recording.
- Partials shown in an optional collapsible live-lanes panel (You/Them); only
  finals enter the doc.
- Retire the Rust file-sink path for the in-editor flow (no editor-vs-file write
  conflict; the CRDT is the single authority). The Rust side emits finalized
  segments to the frontend (existing `transcript://final` events carry source +
  text + timestamps); the frontend formats and inserts into `ytext`.

## Data flow

1. Open a vault note → tab → sync session (`Y.Doc`/`ytext("content")` +
   `WebsocketProvider` at `ws://…/ws/<slug>`), editor mounts muesli's extension
   stack.
2. Collab store computes `httpBase` from `wsBase`, polls/refreshes comments +
   suggestions + history for `<slug>`, pushes decorations into the editor; user
   actions POST to the REST API (anonymous, open mode). Byte/UTF-16 conversion at
   the boundary.
3. Recording on → Rust captures + transcribes → emits finals → frontend inserts
   formatted lines into `ytext` → syncs + autosaves to disk like any edit.

## Error handling & degradation

- Server/Postgres unreachable → collab panels show "unavailable"; editing + sync
  (when ws reachable) + local autosave keep working. No crashes.
- REST 401/403 → "sign in" affordance is suppressed (open mode has no auth);
  treat as unavailable rather than prompting login.
- 409 conflict on suggestion accept → surfaced on the change-set card (muesli's
  existing behavior).
- Recording with no note open → the "Start meeting note" command creates one;
  the bare toggle is disabled until a note is open.

## Testing

- Phase 1: port muesli's pure-logic units where present (`transform.ts`,
  `mdCommands.ts`, `render.ts` sanitize) as vitest; manual smoke of the live
  surface (tables/math/mermaid/wikilinks render; export produces files).
- Phase 2: unit-test `offsets.ts` byte↔UTF-16 round-trips and the collab store's
  pure reducers; manual smoke against the local server (add/resolve a comment;
  submit/accept a suggestion; open a history snapshot; two windows show presence).
- Phase 3: unit-test the transcript-line→markdown formatting + ytext-insert
  helper (pure); manual smoke (record into a note, lines stream in, editable;
  "Start meeting note" creates + records; partials panel toggles).

## Constraints / preserve

- Branch `feat/muesli-editor-port` off `feat/obsidian-editor`; Julian merges;
  clean commits, no AI-attribution trailer.
- Keep the vault, file-tree, tabs, command palette, and sync from the prior
  branch working. Keep the transcription audio pipeline (mic AEC, ScreenCaptureKit,
  Parakeet, VAD) intact — only its output target changes.
- Svelte 5 runes; DaisyUI dark theme; Lucide icons, never emojis (muesli uses a
  couple of glyphs like ✦ for agents — keep those as intentional content, not UI
  chrome emojis).
- YText root name stays `"content"`; slug stays `deriveSlug` (muesli-compatible).
