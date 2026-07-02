# demo_muesli → Obsidian-style Markdown Editor with Muesli Sync — Design

> Status: authored autonomously (Julian asleep, explicit overnight delegation). Decisions
> marked **[assumption]** were made without a live answer and are safe to revise on waking.

## Goal

Turn the demo_muesli transcription prototype into an Obsidian-like markdown editor: a
left-hand **file browser** over a selectable **vault** (folder of `.md` files), a right-hand
**editor/preview** pane, with the vault's notes **live-synced to a running muesli-server**.
Clean UI built on **DaisyUI** + **Tailwind v4** + **Lucide** icons (no emojis). Preserve the
existing live-transcription feature.

## Context & constraints

- App: Tauri 2 + SvelteKit (adapter-static SPA, `ssr=false`) + Svelte 5 runes + pnpm. Single
  route today (`src/routes/+page.svelte`) holding the transcription UI. No editor lib, no
  CSS framework yet.
- The real product `~/Code/muesli` already ships this stack (Svelte 5 + CodeMirror 6 + Yjs).
  Its sync server is a **standard y-websocket** server. We mirror its web client exactly so
  the prototype is wire-compatible.
- **Transcription must keep working.** Its store/events code is UI-agnostic; we move its
  markup into a component and surface it as a command/panel that writes into the vault.

## Architecture

Three layers, each behind a clear seam:

1. **Vault filesystem (Rust/Tauri).** A vault is just a directory. A `vault` Rust module
   exposes commands: read the tree, read/write a note, create note/folder, rename, move,
   delete-to-trash. Folder picking uses `tauri-plugin-dialog`. A recent-vaults registry
   (JSON in `app_config_dir()`) remembers opened vaults and the last one. **[assumption]**
   We do file I/O via our own Rust commands (not `tauri-plugin-fs`) to avoid per-folder
   capability-scope friction for arbitrary user-picked directories.

2. **Editor + sync (frontend, CodeMirror 6 + Yjs).** Each open note = one `Y.Doc` with a
   single `Y.Text` root named **`"content"`** (must match muesli-core `TEXT_ROOT`), bound to
   a `CodeMirror 6` `EditorView` via `yCollab`. A `WebsocketProvider` connects to
   `ws://<host>/ws/<slug>`. **Disk is the vault of record; the Y.Doc is the live editing
   authority while a note is open.** On connect+sync: if the room text is empty, seed it from
   the disk file; otherwise the room wins and we write it to disk. Edits autosave to disk on a
   debounce. If the server is unreachable the editor still works fully (local Y.Doc; provider
   retries silently) — sync is a graceful enhancement, surfaced by a status indicator.

3. **UI shell (Svelte 5 + DaisyUI).** Obsidian-like chrome: collapsible left sidebar (file
   tree + vault header), tab strip, editor pane, bottom status bar; a command palette
   (`Cmd+P`) and quick switcher (`Cmd+O`) as shared fuzzy modals; a context menu on tree
   rows. Custom DaisyUI dark theme tuned to Obsidian's quiet, low-contrast palette
   (accent `#a882ff`, `base-100 #1e1e1e`, `base-200 #262626`, muted text). Dark default.

### Slug convention (sync compatibility)

Replicate muesli-cli `slug_from_rel_path`: take the note's **vault-root-relative** path, join
path components with `-`, strip a trailing `.md`, lowercase, replace runs of non-alphanumeric
with `-`, trim hyphens; empty → `untitled`. So `sub/Deep Note.md` → `sub-deep-note`. This makes
the prototype open the same server room as `muesli sync ./vault`, note-for-note.

### Sync settings

- WS base URL is configurable (default `ws://localhost:8787/ws`), stored per app config.
  **[assumption]** Open mode (no auth) — the server runs locally with no OIDC.
- One provider+doc per open note; torn down on note close/switch (`provider.destroy()`,
  `ydoc.destroy()`).

## Feature scope

**MVP (build tonight):**
1. Tailwind4 + DaisyUI5 + Lucide foundation; global stylesheet; Obsidian-ish dark theme;
   `+layout.svelte`. Transcription view moved into a component, still functional.
2. Tauri `dialog` + custom Rust `vault` commands (tree/read/write/create/rename/move/trash)
   + recent-vaults registry.
3. Vault picker modal (recent list + Open folder + Create vault) and vault open/switch;
   remembers last vault and reopens it.
4. Recursive file-tree sidebar: folders-first, collapse/expand, active-file highlight,
   context menu (new note/folder, rename inline, delete), new-note/new-folder header buttons.
5. Tab strip + editor host (open note in tab, switch, close, dirty indicator).
6. CodeMirror 6 markdown editor with disk autosave (debounced) and Source editing.
7. Muesli sync: `yjs` + `y-websocket` + `y-codemirror.next`; per-note provider; disk-seed on
   empty room; autosave; connection-status indicator in status bar; graceful offline.
8. Command palette (`Cmd+P`) + quick switcher (`Cmd+O`) via a shared fuzzy-modal + command
   registry; commands self-register.
9. Reading view toggle (`Cmd+E`, markdown→sanitized HTML) + status-bar word/char count.
10. Obsidian-style **Live Preview** CM6 extension (decoration-based syntax hiding with
    cursor-reveal + atomic ranges). Highest-risk, highest-value; ordered last so the editor is
    solid first. If blocked, ship Source + Reading view (Cmd+E) and defer Live Preview.
11. Transcription surfaced as a command ("Start meeting transcription") that runs the existing
    capture and writes/streams the transcript into a note inside the active vault.

**Deferred (not tonight):** global full-text search, outline/backlinks panels, wikilink
autocomplete/graph, split panes, frameless custom title bar, multi-window, true bidirectional
file-canonical ingest (muesli-core embedding), settings UI beyond a minimal sync-URL field,
filesystem watcher for external edits (tree refreshes on focus + manual refresh instead).

## Error handling

- Vault commands return typed errors; UI shows a toast/inline message, never crashes.
- Missing/locked vault dir → fall back to vault picker.
- Sync provider errors/disconnects → status shows "offline", editing continues locally,
  provider auto-retries.
- Disk write failures → surfaced, note kept dirty so the user can retry.
- Transcription permission denial path unchanged from current behavior.

## Testing

- Rust `vault` module: unit tests over a tempdir (tree shape, create/rename/move/trash,
  slug edge cases if slug lives in Rust). Keep existing audio/STT tests green.
- Frontend (vitest): slug derivation, command registry/fuzzy match, tree model
  transforms, tab store, transcript store (existing) — pure logic, no DOM.
- Manual smoke (documented in plan): open/switch vault, CRUD in tree, edit+autosave,
  two-window sync against a local muesli-server, transcription still records.

## Preserve / don't break

- All five transcription commands (`check_permissions`, `ensure_model`, `start_capture`,
  `stop_capture`, `reveal_output`) and `transcript://partial|final` events stay wired.
- Existing audio/STT/markdown Rust modules untouched except additive.
- Branch `feat/obsidian-editor` off `build/mvp`; Julian merges. Clean commits, no AI
  attribution trailer.
