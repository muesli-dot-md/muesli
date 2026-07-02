# Obsidian-Style Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps
> use `- [ ]` checkboxes. Each task ends with an independently testable deliverable + commit.

**Goal:** Reshape demo_muesli's chrome to mirror Obsidian (Julian's UI north star): a frameless
title strip with tabs up by the traffic lights + collapse-left/right toggles, a collapsible right
sidebar (home for the Outline now and Phase-2 comments later), an Obsidian-style file-explorer
icon row (new note / new folder / sort / collapse-all), and **auto-reload** of the open vault
(replacing the manual refresh button).

**Architecture:** Frontend-only except Task 4 (a Rust `notify` filesystem watcher). Keep the
existing vault/tabs/sync/editor from the prior phases working; this is a chrome layer plus one
backend watcher. macOS frameless via Tauri's `titleBarStyle: "Overlay"` (native traffic lights
kept).

**Tech Stack:** Tauri 2 (window config + `notify` crate), Svelte 5 runes, DaisyUI, `lucide-svelte`.

## Global Constraints

- Branch `feat/muesli-editor-port`. Clean commits, NO AI-attribution trailer. Julian merges.
- Svelte 5 runes; DaisyUI dark theme; Lucide icons, NEVER emojis.
- KEEP working: vault switcher (top), new-file/new-folder buttons, tabs, sync, editor, command
  palette, transcription. Do not regress them.
- macOS is primary. Frameless = `titleBarStyle: "Overlay"` (keep traffic lights); the top strip
  must be a drag region (`data-tauri-drag-region`) with a left inset (~72px) so content clears the
  traffic lights.
- `cargo` only changes in Task 4; gate elsewhere is `pnpm check` (0 errors) + `pnpm build`.

## File map

- `src-tauri/tauri.conf.json` — window: `titleBarStyle: "Overlay"`, `hiddenTitle: true`, larger
  default size.
- `src/lib/AppShell.svelte` — restructure top bar into the title strip (drag region, traffic-light
  inset, left collapse toggle, TabStrip, right collapse toggle); add `rightSidebarOpen`; render
  `<RightSidebar/>`.
- `src/lib/TabStrip.svelte` — relocate/restyle into the title strip (Obsidian tab look).
- `src/lib/RightSidebar.svelte` — NEW collapsible right panel (tabbed; Outline tenant now).
- `src/lib/OutlineRail.svelte` — NEW outline view from `parseOutline(editorState.currentText)`.
- `src/lib/FileTree.svelte` / sidebar header in `AppShell` — Obsidian explorer icon row; client
  -side sort.
- `src/lib/vault.svelte.ts` — add `sortMode`, `collapseAll()`; sort applied in tree render.
- `src-tauri/src/vault/watch.rs` (NEW) + `src-tauri/Cargo.toml` + `lib.rs` — `notify` watcher
  emitting `vault://changed`; frontend auto-refresh.

---

## Task 1: Frameless title strip — tabs + collapse toggles

**Files:**
- Modify: `src-tauri/tauri.conf.json`, `src/lib/AppShell.svelte`, `src/lib/TabStrip.svelte`

**Interfaces (Produces):** `AppShell` gains `rightSidebarOpen = $state(false)` and a
`toggleRightSidebar` (also registered as a command + a `⌘⌥→`/click). The top strip hosts the tab
bar between the two collapse toggles.

**Steps:**
- [ ] **Window config.** In `src-tauri/tauri.conf.json` window object add `"titleBarStyle":
  "Overlay"` and `"hiddenTitle": true`, and bump default size to `"width": 1200, "height": 800`.
  (Verify the exact Tauri 2 keys against the installed `@tauri-apps/cli` schema; `Overlay` keeps
  the macOS traffic lights floating over the webview. Do NOT use `decorations: false` — that
  removes the traffic lights.)
- [ ] **Top strip in `AppShell.svelte`.** Replace the current top bar with an Obsidian-style title
  strip: a `div` with `data-tauri-drag-region`, height ~38px, `bg-base-200`, `pl-[72px]` (clear the
  traffic lights) `pr-2`, flex row. Contents left→right: a **collapse-left** button (`PanelLeft`
  Lucide, `btn btn-ghost btn-xs btn-square`, toggles `sidebarOpen`), then `<TabStrip />` (flex-1,
  scrollable), then a **collapse-right** button (`PanelRight` Lucide, toggles `rightSidebarOpen`).
  Buttons must NOT be drag regions (they need clicks) — they sit above the drag layer naturally
  since `data-tauri-drag-region` only drags on empty areas; ensure buttons/tabs are interactive
  (Tauri treats child elements with their own handlers as non-drag). Keep the existing
  `showTranscript` swap logic intact.
- [ ] **`rightSidebarOpen` + command.** Add `let rightSidebarOpen = $state(false);` and register a
  "Toggle right sidebar" command (hotkey `⌘⌥→`) + wire the keymap callback if trivial; the toggle
  button flips it.
- [ ] **TabStrip restyle.** In `TabStrip.svelte` make tabs Obsidian-like: rounded-top, active tab
  `bg-base-100` (matches editor), inactive `bg-base-200 text-base-content/60`, `×` on hover, a `+`
  new-tab button at the end (opens a new untitled note via the existing new-note path or a no-op if
  none). Keep the dirty dot.
- [ ] **Gate:** `pnpm check` (0 errors) + `pnpm build`. Manual smoke (document in report): window
  has no title bar background, traffic lights float top-left, tabs sit in the strip and don't
  underlap the lights, the strip is draggable on empty space, both collapse toggles work.
- [ ] Commit: `feat(shell): frameless title strip with tabs and collapse toggles (Obsidian-style)`.

---

## Task 2: Collapsible right sidebar with Outline

**Files:**
- Create: `src/lib/RightSidebar.svelte`, `src/lib/OutlineRail.svelte`
- Modify: `src/lib/AppShell.svelte`

**Interfaces:**
- Consumes: `rightSidebarOpen` (Task 1); `parseOutline` from `$lib/editor/mdCommands` (Phase 1);
  `editorState.currentText`; `editorState.activeView` (to scroll on click).
- Produces: `RightSidebar.svelte` — a `w-64 shrink-0 bg-base-200 border-l` panel shown when
  `rightSidebarOpen`, with a tab header (just "Outline" now; reserve slots for Comments/History in
  Phase 2). `OutlineRail.svelte` — headings list.

**Steps:**
- [ ] **`OutlineRail.svelte`.** `const items = $derived(parseOutline(editorState.currentText));`
  render each as an indented row (indent by `item.level`), click → scroll the editor to that
  heading: if `editorState.activeView`, dispatch a selection/scrollIntoView to the heading's
  position (use `item`'s offset if `parseOutline` provides one; if it provides line/charpos, map to
  a CM position and `view.dispatch({ selection: { anchor: pos }, effects:
  EditorView.scrollIntoView(pos, { y: "start" }) })` + `view.focus()`). If `parseOutline`'s item
  shape lacks a position, READ the ported `mdCommands.ts` `OutlineItem` type and use whatever
  offset field it has; if none, compute the heading offset by scanning `editorState.currentText`
  for the heading text. Empty state: "No headings".
- [ ] **`RightSidebar.svelte`.** Header row with a single active "Outline" tab (DaisyUI `tabs
  tabs-xs`), body renders `<OutlineRail/>`. `w-64 shrink-0 overflow-y-auto`.
- [ ] **Mount in `AppShell.svelte`.** In the body flex row, after `<main>`, render `{#if
  rightSidebarOpen}<RightSidebar/>{/if}`.
- [ ] **Gate:** `pnpm check` + `pnpm build`. Manual smoke: open a note with headings → right
  sidebar (toggle top-right) shows the outline; clicking a heading scrolls the editor.
- [ ] Commit: `feat(shell): collapsible right sidebar with document outline`.

---

## Task 3: Obsidian-style file-explorer icon row + sort + collapse-all

**Files:**
- Modify: `src/lib/AppShell.svelte` (sidebar header), `src/lib/vault.svelte.ts`,
  `src/lib/FileTree.svelte` (apply sort)

**Interfaces:**
- Produces: `vault.sortMode: 'name-asc' | 'name-desc'` (`$state`, default `'name-asc'`),
  `vault.collapseAll()` (clears `expandedPaths`), and a `sortTree(node, mode)` helper applied at
  render so folders stay first and files/folders order by name per mode.

**Steps:**
- [ ] **vault store.** Add `sortMode = $state<'name-asc'|'name-desc'>('name-asc')` and
  `collapseAll() { this.expandedPaths = new Set(); }` and a `cycleSort()` that flips asc/desc.
- [ ] **Sort in FileTree.** The Rust tree is already folders-first name-asc. To support desc,
  sort children client-side in `FileTree`/`TreeNode` before rendering: a pure
  `sortNodes(children, mode)` — folders first always, then by `name.localeCompare` (reversed for
  desc). Add a vitest for `sortNodes` (folders-first preserved; asc vs desc order).
- [ ] **Explorer icon row.** Restyle the sidebar header (`AppShell.svelte`) to match Obsidian: keep
  the vault name + switcher (`ChevronsUpDown`) at the very top (UNCHANGED — Julian likes it), and
  BELOW it a compact icon row with `btn btn-ghost btn-xs btn-square` buttons in this order:
  **new note** (`SquarePen`), **new folder** (`FolderPlus`), **sort** (`ArrowUpDown`, calls
  `vault.cycleSort()`; tooltip shows current mode), **collapse all** (`ChevronsDownUp`, calls
  `vault.collapseAll()`). Use Lucide names that exist in `lucide-svelte`; tooltips via `title`.
- [ ] **Drop the refresh button from the row** (auto-reload replaces it in Task 4). Keep a
  "Refresh tree" command in the palette as a fallback until Task 4 lands.
- [ ] **Gate:** `pnpm test` (incl. `sortNodes` test) + `pnpm check` + `pnpm build`. Manual smoke:
  new note/folder still work; sort toggles A→Z / Z→A; collapse-all collapses every folder.
- [ ] Commit: `feat(shell): Obsidian-style explorer icon row with sort and collapse-all`.

---

## Task 4: Auto-reload the open vault (Rust `notify` watcher)

**Files:**
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/src/vault/mod.rs`
- Create: `src-tauri/src/vault/watch.rs`
- Modify: `src/lib/vault.svelte.ts` (listen + debounced refresh), `src/lib/AppShell.svelte` (start
  watcher on vault open), remove the palette "Refresh tree" fallback if desired

**Interfaces:**
- Produces (Rust commands): `watch_vault(app: AppHandle, path: String) -> Result<(), String>`
  (start/replace a recursive watcher on `path`; on any fs event, debounce ~300ms and emit a Tauri
  event `vault://changed`), `unwatch_vault() -> Result<(), String>`. The watcher handle lives in
  managed state (e.g. a `Mutex<Option<RecommendedWatcher>>`).
- Frontend: `vault.svelte.ts` starts a single `listen('vault://changed', …)` that calls a debounced
  `this.refresh()`. `AppShell`/`vault.openVault` calls `watch_vault(path)` after opening.

**Steps:**
- [ ] **Cargo.** Add `notify = "6"` to `src-tauri/Cargo.toml`.
- [ ] **`watch.rs`.** Implement a `notify::RecommendedWatcher` stored in
  `tauri::State<Mutex<Option<RecommendedWatcher>>>`. `watch_vault` creates a watcher with a closure
  that, on any `Ok(event)`, calls `app.emit("vault://changed", ())` (debounce in the frontend, or a
  simple 300ms coalesce in Rust). Watch the path recursively. Replacing: drop the old watcher first.
  `unwatch_vault` sets the state to `None`. Map errors to `String`. Register the managed state in
  `lib.rs` (`.manage(Mutex::new(None::<RecommendedWatcher>))`) and the two commands in
  `generate_handler!`.
- [ ] **Rust test** (`#[cfg(test)]`): a thin test that constructing the watcher over a tempdir and
  writing a file triggers the callback (or, if testing the watcher async is flaky, unit-test the
  debounce/coalesce helper if you factor one). Keep existing `cargo test` green (run with the
  `DYLD_FALLBACK_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx` env).
- [ ] **Frontend wiring.** In `vault.svelte.ts`, after `openVault` sets the new root, call
  `watch_vault(path)` (typed wrapper in `tauri.ts`), and ensure a single module-level
  `listen('vault://changed', () => debouncedRefresh())` is installed once (debounce ~250ms; call
  `this.refresh()` preserving `expandedPaths`). On vault switch, the new `watch_vault` replaces the
  old watcher.
- [ ] **Remove the manual refresh** path entirely now (the palette "Refresh tree" command can stay
  as a harmless manual trigger, or be removed — your call; the icon button is already gone).
- [ ] **Gate:** `cargo test` (with DYLD env) green; `pnpm check` + `pnpm build`. Manual smoke
  (document): with a vault open, create/delete/rename a file OUTSIDE the app (Finder/terminal) →
  the tree updates within ~0.5s without any manual refresh.
- [ ] Commit: `feat(vault): auto-reload the open vault via a notify filesystem watcher`.

---

## Final (Obsidian shell)
- [ ] Whole-phase review (most capable model): frameless chrome doesn't break interactivity (drag
  vs click), no regression to vault/tabs/sync/editor/transcription, watcher has no leak/duplicate
  listener, right sidebar coexists with the editor layout.
- [ ] ONE fix subagent for any Critical/Important findings.
- [ ] Summarize; note Phase 2 (collab) will add Comments/History tabs into the right sidebar.
