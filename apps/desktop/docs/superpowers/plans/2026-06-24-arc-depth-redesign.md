# Arc-Style Depth Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps
> use `- [ ]` checkboxes. Each task ends with an independently testable deliverable + commit.

**Goal:** Reskin the editor with Arc browser's elevation/layering aesthetic — a tinted floor, a
floating editor card, lifted active items, and layered top tabs — as **two themes (`arc-light`
default-via-system + `arc-dark`)** with a **light/dark/system toggle defaulting to system**.

**Architecture:** Pure frontend (CSS/theme + layout + a small theme store). Concrete values are
from the Arc UI analysis (embedded below). The "raised = lighter surface" rule holds in both
modes: floor = `base-200`, floating card = `base-100`, lifted active = custom `--lift`.

**Tech Stack:** Svelte 5 runes, Tailwind v4 + DaisyUI v5 (`@plugin "daisyui/theme"`), `lucide-svelte`.

## Global Constraints

- Branch `feat/muesli-editor-port`. Clean commits, NO AI-attribution trailer. Julian merges.
- Svelte 5 runes; Lucide icons, NEVER emojis.
- Keep working: vault/tree/tabs/editor/sync/palette/transcription + the frameless title strip
  (titleBarStyle Overlay) and the right sidebar/outline from prior phases. This is a reskin, not
  a rewire — don't break behavior.
- **Surface rule (DaisyUI gotcha):** the window/body/floor = `base-200` (darker tint); the
  floating editor card = `base-100` (lighter). Do NOT put base-100 on the body. Shadow/lift/inset
  are plain custom properties defined per theme.
- Gate: `pnpm check` (0 errors) + `pnpm build`. (Visual result is manual smoke.)

## Concrete tokens (from Arc analysis — use verbatim)

**`src/app.css` — replace the single `muesli` theme with two arc themes:**
```css
@plugin "daisyui/theme" {
  name: "arc-light";
  default: true;
  color-scheme: light;
  --color-base-100: oklch(0.985 0.006 285); /* L1 floating card */
  --color-base-200: oklch(0.925 0.022 285); /* L0 floor / window bg */
  --color-base-300: oklch(0.88  0.020 285); /* borders / recessed tab track */
  --color-base-content: oklch(0.24 0.030 285);
  --color-primary: oklch(0.62 0.19 285);
  --color-primary-content: oklch(0.98 0.01 285);
  --color-neutral: oklch(0.31 0.035 285);
  --color-neutral-content: oklch(0.98 0.01 285);
  --radius-selector: 0.5rem;  /* 8px pills/active rows/tabs */
  --radius-field:    0.5rem;
  --radius-box:      0.75rem; /* 12px cards/panes */
}
@plugin "daisyui/theme" {
  name: "arc-dark";
  color-scheme: dark;
  --color-base-100: oklch(0.245 0.025 285); /* card (lighter than floor) */
  --color-base-200: oklch(0.19  0.022 285); /* floor / near-black tint */
  --color-base-300: oklch(0.30  0.030 285);
  --color-base-content: oklch(0.94 0.012 285);
  --color-primary: oklch(0.70 0.17 285);
  --color-primary-content: oklch(0.16 0.02 285);
  --color-neutral: oklch(0.34 0.038 285);
  --color-neutral-content: oklch(0.95 0.01 285);
  --radius-selector: 0.5rem;
  --radius-field:    0.5rem;
  --radius-box:      0.75rem;
}
```
**Custom (non-DaisyUI) tokens** — define under each theme via a `[data-theme="arc-light"]` /
`[data-theme="arc-dark"]` selector block in `app.css` (DaisyUI theme blocks only take its own
vars), or `:root`-scoped with theme overrides:
```css
[data-theme="arc-light"] {
  --lift: oklch(1 0 0);
  --overlay: oklch(1 0 0);
  --arc-border: oklch(0.88 0.02 285);
  --text-muted: oklch(0.52 0.025 285);
  --inset-card: 8px;
  --shadow-card: 0 1px 2px rgba(30,27,46,.04), 0 8px 24px rgba(30,27,46,.08), 0 0 0 1px rgba(30,27,46,.04);
  --shadow-lift: 0 1px 2px rgba(30,27,46,.06), 0 2px 8px rgba(30,27,46,.10), 0 0 0 1px rgba(30,27,46,.04);
  --shadow-hover: 0 1px 3px rgba(30,27,46,.06);
  --shadow-overlay: 0 12px 48px rgba(30,27,46,.22), 0 0 0 1px rgba(30,27,46,.06);
}
[data-theme="arc-dark"] {
  --lift: oklch(0.31 0.035 285);
  --overlay: oklch(0.34 0.038 285);
  --arc-border: oklch(0.30 0.03 285);
  --text-muted: oklch(0.66 0.03 285);
  --inset-card: 8px;
  --shadow-card: 0 1px 2px rgba(0,0,0,.30), 0 8px 24px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.05), 0 0 0 1px rgba(255,255,255,.04);
  --shadow-lift: 0 2px 8px rgba(0,0,0,.40), inset 0 1px 0 rgba(255,255,255,.06), 0 0 0 1px rgba(255,255,255,.05);
  --shadow-hover: inset 0 1px 0 rgba(255,255,255,.04);
  --shadow-overlay: 0 16px 56px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06), 0 0 0 1px rgba(255,255,255,.08);
}
```

---

## Task 1: Arc themes + system-default theme toggle

**Files:**
- Modify: `src/app.css` (replace `muesli` theme block with `arc-light` + `arc-dark` + custom token blocks)
- Create: `src/lib/theme.svelte.ts` (theme store), `src/lib/ThemeToggle.svelte` (control)
- Modify: `src/routes/+layout.svelte` (apply initial theme on mount) or `AppShell.svelte`

**Interfaces:**
- `theme.svelte.ts`: singleton `theme` with `$state mode: 'light'|'dark'|'system'` (default
  `'system'`, persisted to `localStorage` key `muesli:theme`). It resolves the effective theme
  (`system` → `matchMedia('(prefers-color-scheme: dark)')`), sets
  `document.documentElement.dataset.theme = 'arc-light'|'arc-dark'`, and installs a `matchMedia`
  `change` listener so `system` flips live. Methods: `setMode(m)`, and an `init()` that applies +
  subscribes (call once on mount). Guard `typeof document`/`localStorage` for SSR/test.
- `ThemeToggle.svelte`: a 3-segment control (Lucide `Sun`/`Moon`/`Monitor`) bound to
  `theme.mode`, calling `theme.setMode`.

**Steps:**
- [ ] Replace the `muesli` `@plugin "daisyui/theme"` block in `src/app.css` with the `arc-light`
  (default) + `arc-dark` blocks above, and add the two `[data-theme="arc-*"]` custom-token blocks.
  Set `html, body { background: var(--color-base-200); }` (the floor).
- [ ] Implement `theme.svelte.ts` per the interface (default system; live OS follow; persisted).
- [ ] Implement `ThemeToggle.svelte`.
- [ ] Call `theme.init()` on mount (in `+layout.svelte` `onMount`, or `AppShell` onMount). Place
  `<ThemeToggle/>` somewhere sensible (e.g. the sidebar footer / vault header area).
- [ ] vitest for the pure resolution logic if extracted (`resolveTheme(mode, prefersDark) ->
  'arc-light'|'arc-dark'`): system+prefersDark→arc-dark, system+!dark→arc-light, light→arc-light,
  dark→arc-dark.
- [ ] `pnpm test` + `pnpm check` (0 errors) + `pnpm build`. Manual: app respects OS appearance,
  toggling light/dark/system works and persists, system flips when OS changes.
- [ ] Commit: `feat(theme): Arc light/dark themes with system-default toggle`.

---

## Task 2: Shell depth — floating editor card on a tinted floor

**Files:** Modify `src/lib/AppShell.svelte`, `src/app.css`

**Steps:**
- [ ] Make the window/root the **floor**: the outer container uses `bg-base-200` (it already may);
  ensure the body floor shows. The title strip + sidebar + status bar sit on the floor
  (`bg-base-200`, no card).
- [ ] Make the **editor region a floating card**: wrap `<main>` (the TabStrip+EditorPane area, or
  just EditorPane — see Task 4 for tab/card seam) in a container with `background:
  var(--color-base-100)`, `border-radius: var(--radius-box)`, `box-shadow: var(--shadow-card)`,
  and margin `0 var(--inset-card) var(--inset-card) 0` (inset on top/right/bottom; hugs the
  sidebar on the left per the analysis — `--inset-card-sidebar: 0`). The 8px of visible floor
  around the card is the effect.
- [ ] Sidebar: flat on the floor (`bg-base-200`), `--sidebar-pad: 8px` inner padding; remove any
  card/border that fights the floor look (a hairline right divider is fine or omit since the card
  floats).
- [ ] Right sidebar (outline) + status bar: keep on the floor or as their own subtle surfaces;
  ensure they read as floor-level, not competing cards. (Right sidebar can be flat on floor.)
- [ ] `pnpm check` + `pnpm build`. Manual: editor visibly floats as a rounded card with floor
  tint around it; sidebar sits on the floor.
- [ ] Commit: `feat(ui): floating editor card on a tinted floor (Arc depth)`.

---

## Task 3: Sidebar active-file lift + hover

**Files:** Modify `src/lib/TreeNode.svelte`, `src/app.css`

**Steps:**
- [ ] Replace TreeNode row states with the Arc treatment:
  - inactive: `background: transparent; color: var(--text-muted); box-shadow: none;`
  - hover (non-active): `background: color-mix(in oklch, var(--color-base-content) 6%, transparent); color: var(--color-base-content);`
  - active (file === activePath): `background: var(--lift); color: var(--color-base-content); box-shadow: var(--shadow-lift);` radius `var(--radius-selector)`.
  Use a small transition (`.12s`). Keep the chevron/icons. (Replace the current `bg-primary/15`
  active style.)
- [ ] Folder rows use the same flat/hover treatment (folders aren't "active"); keep expand chevron.
- [ ] `pnpm check` + `pnpm build`. Manual: active file is a lifted shadowed pill; others flat;
  hover is a soft tint.
- [ ] Commit: `feat(ui): Arc lifted active-file treatment in the file tree`.

---

## Task 4: Layered top tabs fused to the card

**Files:** Modify `src/lib/TabStrip.svelte`, `src/lib/AppShell.svelte` (tab/card seam), `src/app.css`

**Steps:**
- [ ] Tab bar = a **recessed track on the floor**: container `background: var(--color-base-200);
  display:flex; align-items:flex-end; gap:4px; padding:6px 6px 0;`.
- [ ] Inactive tabs: `background: transparent; color: var(--text-muted); border-radius:
  var(--radius-field) var(--radius-field) 0 0;` hover → `background: color-mix(in oklch,
  var(--color-base-content) 5%, transparent); color: var(--color-base-content);`.
- [ ] Active tab: raised to the **card surface** — `background: var(--color-base-100); color:
  var(--color-base-content); z-index:2;` top-only radius; a top-only soft shadow (e.g. `0 -1px 2px
  rgba(.,.,.,.04), 0 -6px 16px rgba(.,.,.,.06)`); and a `::after` bridge (`position:absolute;
  left:0;right:0;bottom:-2px;height:3px;background:var(--color-base-100)`) so it fuses with the
  editor card below (seam vanishes). Keep the `×` close + dirty dot + `+` new-tab.
- [ ] Ensure the editor card's top-left corner meets the active tab cleanly: the card under the
  tabs uses `border-radius: 0 var(--radius-box) var(--radius-box) var(--radius-box)` (square the
  top-left where the active tab connects) OR keep full radius and let the active-tab bridge cover
  the seam — pick whichever reads cleanest; the active tab must look continuous with the pane.
- [ ] `pnpm check` + `pnpm build`. Manual: active tab looks lifted and connected to the editor
  card; inactive tabs recessed into the floor track; traffic-light inset preserved.
- [ ] Commit: `feat(ui): Arc layered top tabs fused to the editor card`.

---

## Task 5: Overlays + surface polish

**Files:** Modify `src/lib/{CommandPalette,QuickSwitcher,VaultPicker}.svelte`, `src/lib/FileTree.svelte` (context menu), `src/lib/RightSidebar.svelte`, `src/app.css`, reading-view/prose styles

**Steps:**
- [ ] Make modals/popovers read as **L2 overlays**: surface `var(--overlay)`, `box-shadow:
  var(--shadow-overlay)`, `border-radius: var(--radius-overlay, 0.875rem)`. Apply to CommandPalette,
  QuickSwitcher, VaultPicker modal boxes, and the FileTree context menu.
- [ ] Reading view / `.prose-muesli` + `.cm-content` sit on the **card** (`base-100`); confirm
  contrast against the new palette (muted code/table backgrounds use `base-200`/`base-300`).
- [ ] Right sidebar/outline + status bar: confirm they read as floor-level and don't clash.
- [ ] Sweep for now-wrong hardcoded colors referencing the old `muesli` theme (e.g. any `#1e1e1e`
  / `bg-base-300` active states that should be `--lift`); fix to the new tokens.
- [ ] `pnpm check` + `pnpm build`. Manual: palettes/menus float as overlays; both themes coherent;
  no leftover dark-only hardcoded surfaces.
- [ ] Commit: `feat(ui): Arc overlay treatment for palettes/menus + surface polish`.

---

## Final (Arc redesign)
- [ ] Whole-phase review (most capable model): both themes coherent, system toggle correct, depth
  reads in light AND dark, no contrast/legibility regressions, no behavior regressions.
- [ ] ONE fix subagent for Critical/Important findings.
- [ ] Note remaining shell item: auto-reload watcher (deferred shell Task 4) still pending.
