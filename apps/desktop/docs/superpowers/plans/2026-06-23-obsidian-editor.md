# Obsidian-style Editor + Muesli Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps
> use `- [ ]` checkboxes. Each task ends with an independently testable deliverable + commit.

**Goal:** Turn demo_muesli into an Obsidian-like markdown editor — vault file browser (left) +
CodeMirror editor (right) — with notes live-synced to a muesli-server, clean DaisyUI/Lucide UI,
preserving the transcription feature.

**Architecture:** Rust `vault` module owns the filesystem (a vault = a folder). Frontend
(Svelte 5 + CM6 + Yjs) owns editing + sync: per-note `Y.Doc`/`Y.Text("content")` bound via
`yCollab` to a `WebsocketProvider` at `ws://localhost:8787/ws/<slug>`; disk is the vault of
record, Y.Doc is the live authority, autosave to disk on debounce, graceful offline. UI is an
Obsidian-like shell on a custom DaisyUI dark theme.

**Tech Stack:** Tauri 2, SvelteKit (adapter-static SPA), Svelte 5 runes, Tailwind v4
(`@tailwindcss/vite`), DaisyUI v5, `lucide-svelte`, CodeMirror 6, `yjs`/`y-websocket`/
`y-codemirror.next`, `tauri-plugin-dialog`, `trash`/`notify` (Rust).

## Global Constraints

- Branch `feat/obsidian-editor` (off `build/mvp`). Clean commits — NO `Co-Authored-By`/AI
  trailer. Julian merges.
- **Preserve transcription**: commands `check_permissions`, `ensure_model`, `start_capture`,
  `stop_capture`, `reveal_output` and events `transcript://partial|final` stay wired and
  working. Existing audio/STT/output Rust modules change only additively.
- Svelte 5 runes only (`$state`/`$derived`/`$props`/`$effect`, `onclick=`). pnpm. Package
  manager commands use `pnpm`.
- YText root name MUST be `"content"`. WS URL default `ws://localhost:8787/ws`, configurable.
- Slug derivation MUST match muesli-cli `slug_from_rel_path` (see Task 7).
- Dark theme default; Lucide icons, NEVER emojis, in all new UI.
- After any task touching Rust that links ScreenCaptureKit, tests need
  `DYLD_FALLBACK_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx`.
- Reference implementation to read (do NOT modify): `~/Code/muesli/apps/web/src/{session.svelte.ts,identity.ts,Editor.svelte}`, slug at `~/Code/muesli/crates/muesli-cli/src/sync.rs`.

---

## Task 1: UI foundation — Tailwind4 + DaisyUI5 + Lucide + layout shell + Obsidian theme; isolate transcription

**Files:**
- Create: `src/app.css`, `src/routes/+layout.svelte`, `src/lib/TranscriptView.svelte`, `src/lib/AppShell.svelte`
- Modify: `vite.config.js`, `src/routes/+page.svelte`, `package.json`
- Keep: `src/lib/{events.ts,transcript.svelte.ts,types.ts,TranscriptLane.svelte}` unchanged

**Interfaces:**
- Produces: `AppShell.svelte` — the top-level editor shell with named regions (sidebar slot,
  main slot, status-bar slot) used by later tasks. For Task 1 it renders a static three-pane
  skeleton (left sidebar placeholder, main area placeholder, bottom status bar) + a button/route
  to open `TranscriptView`. `TranscriptView.svelte` — the existing transcription UI, extracted
  verbatim (markup + scoped styles + the onMount logic from current `+page.svelte`).

**Steps:**
- [ ] Install: `pnpm add -D tailwindcss @tailwindcss/vite daisyui` and `pnpm add lucide-svelte`.
- [ ] `vite.config.js`: add `import tailwindcss from "@tailwindcss/vite"` and put `tailwindcss()` first in `plugins` (before `sveltekit()`).
- [ ] Create `src/app.css` with Tailwind + DaisyUI + a custom Obsidian-ish dark theme as default:
  ```css
  @import "tailwindcss";
  @plugin "daisyui" { themes: muesli --default; }
  @plugin "daisyui/theme" {
    name: "muesli";
    default: true;
    color-scheme: dark;
    --color-base-100: #1e1e1e;   /* editor bg */
    --color-base-200: #262626;   /* sidebar bg */
    --color-base-300: #2d2d2d;   /* hover/active rows, borders */
    --color-base-content: #dcddde;
    --color-primary: #a882ff;    /* Obsidian accent */
    --color-primary-content: #ffffff;
    --radius-box: 0.4rem;
    --radius-field: 0.3rem;
  }
  html, body { height: 100%; margin: 0; }
  ```
  (If the exact `@plugin "daisyui/theme"` block errors on the installed DaisyUI version, fall
  back to DaisyUI's documented theme syntax for that version — the named tokens above are the
  contract; the wrapper syntax may differ. Verify `pnpm build` passes.)
- [ ] Create `src/routes/+layout.svelte`:
  ```svelte
  <script lang="ts">
    import "../app.css";
    let { children } = $props();
  </script>
  {@render children()}
  ```
- [ ] Extract the entire current transcription UI from `src/routes/+page.svelte` into
  `src/lib/TranscriptView.svelte` (move markup, `<style>`, and the script logic that calls
  `check_permissions`/`ensure_model`/`start_capture`/`stop_capture`/`reveal_output` and uses the
  transcript store/events). It must remain functionally identical.
- [ ] Create `src/lib/AppShell.svelte`: a flex layout — left `<aside class="w-64 shrink-0 bg-base-200 ...">` (placeholder text "Files"), main `<main class="flex-1 ...">`, bottom status bar `<footer class="...border-t border-base-300 text-xs text-base-content/60">`. Use a Lucide icon (e.g. `PanelLeft`) in a `btn btn-ghost btn-sm btn-square` as a sidebar-toggle placeholder. Provide a temporary button in the main area to toggle showing `TranscriptView` (so transcription stays reachable this task).
- [ ] Rewrite `src/routes/+page.svelte` to render `<AppShell />`.
- [ ] Run `pnpm check` and `pnpm build`; both must pass.
- [ ] Manually confirm (note in report): app boots to the shell, dark Obsidian-ish theme, and the transcription view still mounts and its buttons call the Tauri commands. (Logic preserved; live capture is a manual smoke item.)
- [ ] Commit: `feat(ui): Tailwind4 + DaisyUI + Lucide foundation, app shell, isolate transcription view`.

---

## Task 2: Rust `vault` filesystem module + dialog plugin

**Files:**
- Create: `src-tauri/src/vault/mod.rs`, `src-tauri/src/vault/tree.rs`
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/src/commands.rs` (or a new `vault_commands.rs`), `src-tauri/capabilities/default.json`, `package.json`

**Interfaces (Produces — exact Rust signatures, all `#[tauri::command]`, return `Result<_, String>`):**
- `read_vault_tree(root: String) -> Result<VaultNode, String>` where
  ```rust
  #[derive(serde::Serialize)]
  #[serde(rename_all = "camelCase")]
  pub struct VaultNode { pub name: String, pub path: String, pub is_dir: bool, pub children: Option<Vec<VaultNode>> }
  ```
  Recursive. Folders first then files, each alphabetical (case-insensitive). Only `.md` files
  and directories included; skip dotfiles/dot-dirs (`.git`, `.obsidian`, `.muesli`, `.trash`).
  `path` is absolute. Root node `is_dir: true`.
- `read_note(path: String) -> Result<String, String>` — UTF-8 file contents.
- `write_note(path: String, contents: String) -> Result<(), String>` — overwrite/create, creating parent dirs.
- `create_note(dir: String, name: String) -> Result<String, String>` — creates `<dir>/<name>.md` (append `.md` if missing), de-duplicating (`Untitled`, `Untitled 1`…) if exists; returns final absolute path. Empty file.
- `create_folder(dir: String, name: String) -> Result<String, String>` — de-duplicated; returns path.
- `rename_path(path: String, new_name: String) -> Result<String, String>` — rename within same parent (preserve `.md` extension for files); returns new path. Error if target exists.
- `move_path(src: String, dest_dir: String) -> Result<String, String>` — move into dest dir; returns new path.
- `delete_path(path: String) -> Result<(), String>` — move to OS trash via the `trash` crate.

**Steps:**
- [ ] `Cargo.toml`: add `tauri-plugin-dialog = "2"` and `trash = "5"`. (Keep existing deps.)
- [ ] `package.json`: `pnpm add @tauri-apps/plugin-dialog`.
- [ ] `lib.rs`: add `mod vault;`, `.plugin(tauri_plugin_dialog::init())`, and register all 8 commands above in `invoke_handler![...]` alongside the existing ones.
- [ ] `capabilities/default.json`: add `"dialog:default"` to permissions. (FS done via our commands, no fs-plugin scope needed.)
- [ ] Implement `vault/tree.rs::build_tree(root: &Path) -> io::Result<VaultNode>` (recursive, sorting + filtering as specified) and the command wrappers in `vault/mod.rs`. Map `io::Error`/`trash::Error` to `String` via `.map_err(|e| e.to_string())`.
- [ ] **Tests** (`#[cfg(test)]` in `vault/tree.rs` + `vault/mod.rs`, use `tempfile`):
  - tree: given `a.md`, `z.md`, `sub/b.md`, `.hidden/x.md`, a non-`.md` `note.txt` → tree lists `sub` (dir) before `a.md` before `z.md`; `note.txt` and `.hidden` excluded; `sub` has child `b.md`.
  - create_note dedups: two `create_note(dir,"Untitled")` → `Untitled.md` then `Untitled 1.md`.
  - rename_path keeps `.md`: rename `a.md`→`b` yields `b.md`.
  - write_note then read_note round-trips contents; write creates parent dirs.
  - move_path moves file into subdir.
- [ ] Run: `cd src-tauri && DYLD_FALLBACK_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx cargo test vault` → PASS. Confirm full `cargo test` still green.
- [ ] Commit: `feat(vault): Rust filesystem module (tree/CRUD/trash) + dialog plugin`.

---

## Task 3: Recent-vaults registry + vault store + picker modal

**Files:**
- Create: `src-tauri/src/vault/recent.rs`, `src/lib/vault.svelte.ts`, `src/lib/VaultPicker.svelte`, `src/lib/tauri.ts` (typed invoke wrappers)
- Modify: `src-tauri/src/vault/mod.rs` (+ register), `src-tauri/src/lib.rs`, `src/lib/AppShell.svelte`

**Interfaces:**
- Rust commands: `list_recent_vaults() -> Result<Vec<RecentVault>, String>`, `add_recent_vault(path: String) -> Result<Vec<RecentVault>, String>` (dedupe by path, move to front, cap 10, derive `name` = final path component, set `lastOpened` epoch ms via `std::time::SystemTime`), `set_last_vault(path: String)`, `get_last_vault() -> Result<Option<String>, String>`. Registry persisted as JSON at `app_config_dir()/recent-vaults.json` (use the `tauri::Manager` app handle / `app.path().app_config_dir()`).
  ```rust
  #[derive(Serialize, Deserialize, Clone)]
  #[serde(rename_all = "camelCase")]
  pub struct RecentVault { pub name: String, pub path: String, pub last_opened: u64 }
  ```
- `src/lib/tauri.ts`: typed wrappers around `invoke` for every vault command + a `pickFolder()` using `@tauri-apps/plugin-dialog` `open({ directory: true })`. Export TS `VaultNode`/`RecentVault` types mirroring the Rust structs (camelCase).
- `src/lib/vault.svelte.ts`: a runes store `vault` with `$state` fields `{ root: string | null, tree: VaultNode | null, recents: RecentVault[] }` and methods `openVault(path)` (calls `read_vault_tree` + `add_recent_vault` + `set_last_vault`, updates state), `refresh()` (re-read tree), `loadRecents()`. Export a singleton.

**Steps:**
- [ ] Implement `recent.rs` + register the 4 commands; persist/load JSON (create dir if missing; tolerate missing/corrupt file → empty list).
- [ ] Rust test: add_recent_vault dedups + caps + front-orders (use a temp config dir by constructing paths directly in a unit test of the pure list-transform fn `upsert_recent(list, path, now) -> Vec<RecentVault>`; keep file I/O thin around it).
- [ ] Implement `tauri.ts` wrappers + `vault.svelte.ts` store.
- [ ] Implement `VaultPicker.svelte` (DaisyUI `modal modal-open`): title, recent-vault list (each row: `Folder` Lucide icon + name + muted path, click → `vault.openVault(path)` + close), an "Open folder…" button (`pickFolder()` → openVault), a "Create vault…" button (`pickFolder()` to choose parent, then prompt name via an inline input, `create_folder` then openVault). Icons via Lucide, no emojis.
- [ ] `AppShell.svelte`: on mount, `vault.loadRecents()` + `get_last_vault()`; if a last vault exists, `openVault` it; else show `VaultPicker`. Add a vault-name header in the sidebar with a switch button (`ChevronsUpDown` icon) that reopens the picker.
- [ ] `pnpm check` + `pnpm build` pass. Frontend vitest for any pure logic added (e.g. a `dedupeRecents` helper if mirrored in TS — optional).
- [ ] Commit: `feat(vault): recent-vaults registry + vault store + picker modal`.

---

## Task 4: File-tree sidebar (recursive, context menu, inline rename, create/delete)

**Files:**
- Create: `src/lib/FileTree.svelte`, `src/lib/TreeNode.svelte`, `src/lib/contextMenu.svelte.ts` (or inline)
- Modify: `src/lib/AppShell.svelte`, `src/lib/vault.svelte.ts` (add CRUD passthroughs + an `activePath` field + an `openNote` callback hook)

**Interfaces:**
- `FileTree.svelte` props: `{ tree: VaultNode, activePath: string | null, onOpen: (path: string) => void }`. Renders `TreeNode` recursively.
- `TreeNode.svelte`: one row. Folders: `ChevronRight` (rotate when open) + `Folder`/`FolderOpen` icon + name; click toggles a local `$state` `expanded`. Files: `FileText` icon + name; click → `onOpen(path)`. Active file row → `bg-primary/15 text-base-content`. Hover → `bg-base-300`. Right-click → context menu.
- Context menu actions (DaisyUI `menu` in a positioned popover): file → Rename, Delete; folder → New note, New folder, Rename, Delete. Rename = inline `input input-xs` replacing the label (Enter commits via `rename_path`, Esc cancels). Delete = `delete_path` (confirm via small DaisyUI modal). New note/folder = `create_note`/`create_folder` then `vault.refresh()` and (for note) `onOpen`.
- Sidebar header buttons (in `AppShell`): `FilePlus` (new note at vault root or selected folder), `FolderPlus` (new folder), `RefreshCw` (refresh tree).

**Steps:**
- [ ] Implement `TreeNode.svelte` + `FileTree.svelte`; folder expand state persists in-memory per session (a `Set<string>` of expanded paths in the vault store is fine).
- [ ] Implement context menu (right-click → set `$state` `{x,y,node}`; a fixed-position `menu` rendered at cursor; click-away closes). Inline rename + delete-confirm modal.
- [ ] Wire header create/refresh buttons.
- [ ] After any mutation, call `vault.refresh()` and keep expansion state.
- [ ] `pnpm check` + `pnpm build` pass. Add a vitest for a pure helper if extracted (e.g. `sortNodes`); otherwise note manual verification (create/rename/delete/open reflect on disk + tree).
- [ ] Commit: `feat(ui): recursive file-tree sidebar with context menu, inline rename, CRUD`.

---

## Task 5: Tab store + tab strip + editor-pane host + status bar

**Files:**
- Create: `src/lib/tabs.svelte.ts`, `src/lib/TabStrip.svelte`, `src/lib/EditorPane.svelte`, `src/lib/StatusBar.svelte`
- Modify: `src/lib/AppShell.svelte` (wire tree `onOpen` → `tabs.open`; render TabStrip + EditorPane + StatusBar)

**Interfaces:**
- `tabs.svelte.ts`: runes store `tabs` with `$state` `{ open: Tab[], activeId: string | null }`, `Tab = { id: string; path: string; name: string; dirty: boolean }` (id = path). Methods: `open(path, name)` (focus if already open else push + activate), `close(id)` (also triggers a flush-save hook — provided by Editor in Task 6 via a registered callback map), `activate(id)`, `setDirty(id, bool)`, `active(): Tab | null`.
- `TabStrip.svelte`: row of tabs; active = `bg-base-100`, inactive = `bg-base-200 text-base-content/60`; dirty → a dot before the name; `X` (Lucide) on hover closes. `+` button optional.
- `EditorPane.svelte`: given the active tab, host area where Task 6 mounts CodeMirror. For Task 5 it just shows the note name + a placeholder; reads nothing yet.
- `StatusBar.svelte`: right-aligned `flex gap-3 text-xs`; placeholders for word count + sync status (filled in later tasks). Props for `wordCount?`, `syncStatus?`.

**Steps:**
- [ ] Implement the store + components; wire `FileTree onOpen` → `tabs.open`.
- [ ] vitest for `tabs.svelte.ts`: open dedupes + activates; close removes + reselects neighbor; setDirty toggles. (Pure store logic — instantiate the store factory in the test.)
- [ ] `pnpm check`/`build`/`vitest` pass.
- [ ] Commit: `feat(ui): tab store, tab strip, editor-pane host, status bar`.

---

## Task 6: CodeMirror 6 markdown editor with disk autosave (local, no sync yet)

**Files:**
- Create: `src/lib/editor/createEditor.ts`, `src/lib/editor/theme.ts`
- Modify: `src/lib/EditorPane.svelte`, `src/lib/tabs.svelte.ts` (register flush-save callbacks), `package.json`

**Interfaces:**
- Install: `pnpm add codemirror @codemirror/state @codemirror/view @codemirror/commands @codemirror/language @codemirror/lang-markdown`.
- `createEditor.ts`: `createEditor(opts: { parent: HTMLElement; doc: string; onChange: (text: string) => void }) => EditorView`. Extensions: `markdown({ base: markdownLanguage })`, `EditorView.lineWrapping`, `history()`, `keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab])`, the custom `theme.ts` (Obsidian-ish: transparent bg inheriting base-100, comfortable font-size 16/line-height 1.6, readable max-width column centered, muted syntax), and an `EditorView.updateListener` calling `onChange(view.state.doc.toString())` on `docChanged`.
- `theme.ts`: `EditorView.theme({...}, { dark: true })` matching the DaisyUI tokens (use CSS vars where possible).

**Steps:**
- [ ] `EditorPane.svelte`: on active tab change, `read_note(path)`, mount a fresh `EditorView` into a `<div>` (in `$effect` keyed on `activeId`; destroy the previous view). `onChange` → mark tab dirty + debounce (500ms) `write_note(path, text)` then clear dirty. Register a synchronous flush in `tabs.close` so closing a dirty tab saves first.
- [ ] Reading external file: if the active tab path changes, tear down + rebuild (don't reuse doc across notes).
- [ ] vitest for the debounce/save helper if extracted as a pure fn (`makeDebouncedSaver`); DOM-mount of CM is a manual smoke item.
- [ ] `pnpm check`/`build` pass. Manual: open a note, type, see file update on disk within ~0.5s; switch notes preserves/saves.
- [ ] Commit: `feat(editor): CodeMirror 6 markdown editor with debounced disk autosave`.

---

## Task 7: Muesli sync — Yjs + y-websocket + yCollab, per-note, graceful offline

**Files:**
- Create: `src/lib/sync/session.ts`, `src/lib/sync/slug.ts`, `src/lib/sync/slug.test.ts`, `src/lib/settings.svelte.ts`
- Modify: `src/lib/editor/createEditor.ts` (accept optional yCollab extension), `src/lib/EditorPane.svelte`, `src/lib/StatusBar.svelte`, `package.json`

**Interfaces:**
- Install: `pnpm add yjs y-websocket y-codemirror.next`.
- `slug.ts`: `deriveSlug(relPath: string): string` replicating muesli-cli `slug_from_rel_path`
  (read `~/Code/muesli/crates/muesli-cli/src/sync.rs` for exact rules): split on `/`, join with
  `-`, strip trailing `.md`, lowercase, replace runs of non-`[a-z0-9]` with `-`, trim leading/
  trailing `-`, empty → `untitled`. Compute relPath = note path relative to the vault root.
- `slug.test.ts`: `sub/Deep Note.md → sub-deep-note`, `a.md → a`, `Meeting Notes.md → meeting-notes`, `` → `untitled`, leading/trailing punctuation trimmed.
- `session.ts`: `createSession(opts: { slug: string; wsBase: string }) => { ydoc, ytext, provider, awareness, onSynced(cb), destroy() }`. Mirror `~/Code/muesli/apps/web/src/session.svelte.ts`: `new Y.Doc()`, `ydoc.getText("content")`, `new WebsocketProvider(wsBase, slug, ydoc)`, set an awareness `user` field (name "You", a color). `onSynced` wraps `provider.once('synced', ...)`. `destroy()` calls `provider.destroy()` + `ydoc.destroy()`.
- `settings.svelte.ts`: runes store with `$state` `{ wsBase: string, syncEnabled: boolean }`, default `ws://localhost:8787/ws`, `syncEnabled: true`; persisted to `localStorage`.
- `createEditor.ts`: add optional `collab?: Extension` to opts; include it in the extension list when present. When collab is used, the doc binding comes from yCollab — pass the seeded ytext string as the initial `doc`.

**Sync wiring in `EditorPane.svelte` (the important part):**
- When opening a note and `settings.syncEnabled`:
  1. Compute `slug = deriveSlug(relativeTo(vault.root, path))`.
  2. `const session = createSession({ slug, wsBase: settings.wsBase })`.
  3. Read disk contents `const disk = await read_note(path)`.
  4. Build the editor with `collab: yCollab(session.ytext, session.awareness, { undoManager: new Y.UndoManager(session.ytext) })` and initial `doc: session.ytext.toString()`.
  5. `session.onSynced(() => { if (session.ytext.length === 0 && disk.length > 0) session.ytext.insert(0, disk); })` — seed an empty room from disk; otherwise the room (server) content already populated the editor via yCollab.
  6. autosave: on yCollab/editor change, debounce `write_note(path, session.ytext.toString())` so disk tracks the live doc.
  7. On tab close / note switch: flush save, then `session.destroy()`.
- Connection status: subscribe to `provider.on('status', ({status}) => ...)` and `provider.on('sync', ...)`; reflect `connected | connecting | offline` into `StatusBar` (Lucide `Wifi`/`WifiOff`/`RefreshCw`). If `!syncEnabled`, skip the session entirely and use the local editor from Task 6 (disk only).
- Graceful offline: provider failing to connect must NOT block editing — yCollab binds to the local Y.Doc regardless; status simply shows offline.

**Steps:**
- [ ] Implement `slug.ts` + passing `slug.test.ts` (vitest).
- [ ] Implement `session.ts` + `settings.svelte.ts`.
- [ ] Refactor `EditorPane.svelte` to the sync-aware flow above, keeping the no-sync path (Task 6) when `syncEnabled` is false.
- [ ] Status indicator in `StatusBar`.
- [ ] `pnpm check`/`build`/`vitest` pass.
- [ ] Manual smoke (document in report; requires `cargo run -p muesli-server` in `~/Code/muesli`): open the same note in two app windows (or one window + muesli web app) → edits propagate; kill the server → editing continues, status flips to offline; restart → reconnects. Seed-on-empty leaves no duplicated text.
- [ ] Commit: `feat(sync): per-note Yjs/y-websocket muesli sync with disk seed + offline fallback`.

---

## Task 8: Command registry + command palette (Cmd+P) + quick switcher (Cmd+O)

**Files:**
- Create: `src/lib/commands/registry.svelte.ts`, `src/lib/commands/fuzzy.ts`, `src/lib/commands/fuzzy.test.ts`, `src/lib/CommandPalette.svelte`, `src/lib/QuickSwitcher.svelte`, `src/lib/keymap.ts`
- Modify: `src/lib/AppShell.svelte`

**Interfaces:**
- `registry.svelte.ts`: `Command = { id: string; title: string; hotkey?: string; run: () => void }`; `commands` store with `register(cmd)`, `all(): Command[]`. Core commands registered from `AppShell` onMount: New note, New folder, Open/switch vault, Toggle left sidebar, Toggle reading view (Task 9), Start meeting transcription (Task 11). Each shows its hotkey.
- `fuzzy.ts`: `fuzzyFilter<T>(items: T[], query: string, key: (t)=>string): T[]` — subsequence match + simple score (contiguous + start-of-word bonus), sorted. `fuzzy.test.ts`: `"nn"` matches "New note" before "Antenna"; empty query returns all in order.
- `CommandPalette.svelte`: DaisyUI `modal` near top-center; `input` + arrow-navigable list of fuzzy-filtered commands; Enter runs, Esc closes.
- `QuickSwitcher.svelte`: same modal pattern over a flattened list of all `.md` files in the vault tree (path-relative names); Enter → `tabs.open`.
- `keymap.ts`: a `window` keydown handler mounted in `AppShell` — `Cmd/Ctrl+P` → palette, `Cmd/Ctrl+O` → switcher, `Cmd/Ctrl+N` → new note, `Esc` closes open modal. Respect platform (metaKey on mac).

**Steps:**
- [ ] Implement registry + fuzzy (+ test) + both modals + keymap; wire into `AppShell`.
- [ ] `pnpm check`/`build`/`vitest` pass.
- [ ] Commit: `feat(ui): command palette + quick switcher with fuzzy search and hotkeys`.

---

## Task 9: Reading view (Cmd+E) + word/char count in status bar

**Files:**
- Create: `src/lib/ReadingView.svelte`, `src/lib/markdown/render.ts`
- Modify: `src/lib/EditorPane.svelte`, `src/lib/StatusBar.svelte`, `src/lib/tabs.svelte.ts` (per-tab `mode: 'edit'|'read'`), `package.json`

**Interfaces:**
- Install: `pnpm add marked dompurify`.
- `render.ts`: `renderMarkdown(src: string): string` → `DOMPurify.sanitize(marked.parse(src))`. Style the output with Tailwind `prose`-like rules (hand-rolled CSS classes in `app.css` under a `.reading-view` scope; DaisyUI has no prose — add minimal heading/list/code styles).
- Per-tab `mode`; `Cmd+E` toggles the active tab between edit and read. `ReadingView.svelte` renders `renderMarkdown(currentText)` read-only.
- Word/char count: derive from the active editor text; show in `StatusBar` (e.g. `123 words · 456 chars`).

**Steps:**
- [ ] Implement render + ReadingView + mode toggle + count; add `Cmd+E` to keymap.
- [ ] vitest: `renderMarkdown` strips a `<script>` (sanitized) and renders `# H` → `<h1>`.
- [ ] `pnpm check`/`build`/`vitest` pass.
- [ ] Commit: `feat(editor): reading view toggle (Cmd+E) + status-bar word/char count`.

---

## Task 10: Obsidian-style Live Preview (CM6 decoration extension)

**Files:**
- Create: `src/lib/editor/livePreview.ts`
- Modify: `src/lib/editor/createEditor.ts` (include livePreview when in live-preview mode), `src/lib/EditorPane.svelte` (default editor mode = live preview; source mode optional)

**Interfaces:**
- `livePreview.ts`: export `livePreview(): Extension` — a `ViewPlugin` building a `DecorationSet` over the visible viewport from the markdown Lezer tree (`syntaxTree`), rebuilt on `docChanged`/`selectionSet`/`viewportChanged`. Technique (per the research report + `kenforthewin/atomic-editor`):
  - `Decoration.replace({})` over syntax marker ranges (`HeaderMark`, `EmphasisMark`, `StrongEmphasisMark`, `CodeMark`, link/`[[`/`]]` brackets) to HIDE them — but SKIP hiding on any line the cursor/selection intersects (cursor-reveal at line granularity).
  - `Decoration.line`/`Decoration.mark` to STYLE content (heading sizes, bold/italic, inline code) via CSS classes in `app.css`.
  - Provide `EditorView.atomicRanges` from the replace decorations so the cursor skips hidden tokens.
  - Clickable task checkboxes (`- [ ]`/`- [x]`) via a small mousedown handler dispatching a doc change (nice-to-have; include if straightforward).
- `createEditor.ts`: when `mode === 'live'`, add `livePreview()`; `mode === 'source'` omits it. Default mode = live.

**Steps:**
- [ ] Implement `livePreview.ts`. Keep it viewport-scoped for performance.
- [ ] vitest (logic-only where possible): a helper that, given a parsed token list + cursor line, returns which marker ranges to hide — assert markers on the cursor line are NOT hidden, others ARE.
- [ ] `pnpm check`/`build` pass. Manual: `**bold**` renders bold and the `**` vanish until the cursor enters that line; headings size up; cursor can't get stuck in hidden marks.
- [ ] **Fallback:** if Live Preview proves unstable within reason, ship Source + Reading view (Task 9) as the editing experience, commit what's stable, and record the deferral in the report + ledger. Do NOT block the branch on this task.
- [ ] Commit: `feat(editor): Obsidian-style live-preview markdown decorations`.

---

## Task 11: Transcription as a vault command (write transcript into the active vault)

**Files:**
- Modify: `src-tauri/src/commands.rs` (`start_capture` accepts optional `vault_dir`), `src/lib/commands/registry.svelte.ts` (register "Start/Stop meeting transcription"), `src/lib/AppShell.svelte` (host `TranscriptView` in a panel/modal), `src/lib/TranscriptView.svelte` (open the resulting note in a tab)

**Interfaces:**
- `start_capture(vault_dir: Option<String>)`: when provided, write the meeting markdown into
  `<vault_dir>/<meeting-name>.md` instead of `~/Documents/muesli-transcripts/`. Keep the default
  when absent (back-compat). Return the note path (unchanged shape).
- Commands "Start meeting transcription" (calls `start_capture` with `vault.root`) and "Stop"
  registered in the palette. On start, open the meeting note as a tab so the user watches it
  fill (re-read on `transcript://final`, or open after stop). `TranscriptView` remains available
  as a side panel for the live You/Them lanes.

**Steps:**
- [ ] Rust: thread an optional `vault_dir` into the existing `MarkdownSink::create_in` call site; default unchanged. Keep all existing tests green (`cargo test`, with the DYLD env).
- [ ] Frontend: register the commands; open the meeting note in a tab; ensure the tree refresh shows the new note.
- [ ] `pnpm check`/`build` + `cargo test` pass.
- [ ] Manual: run transcription with a vault open → a `meeting-*.md` appears in the vault tree and opens in a tab; existing transcription behavior intact.
- [ ] Commit: `feat(transcription): write meeting transcript into the active vault + palette commands`.

---

## Final

- [ ] Whole-branch code review (most capable model) against this plan + the spec.
- [ ] Dispatch ONE fix subagent for any Critical/Important findings.
- [ ] Update `~/.claude/.../memory/project_muesli_transcription.md` with the editor+sync outcome.
- [ ] Leave branch `feat/obsidian-editor` for Julian to merge. Summarize what shipped, what was
      deferred (esp. if Live Preview fell back), and the manual smoke results.
