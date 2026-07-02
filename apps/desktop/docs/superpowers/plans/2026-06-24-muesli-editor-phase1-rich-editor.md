# Muesli Editor Port — Phase 1: Rich Editor Surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps
> use `- [ ]` checkboxes. Each task ends with an independently testable deliverable + commit.

**Goal:** Replace demo_muesli's basic editor with muesli's richer markdown editing surface —
live-preview (tables, KaTeX math, mermaid, wikilinks, images, callouts, frontmatter, fenced-code
highlighting, task checkboxes), the formatting toolbar, and Markdown/HTML/PDF export — by porting
muesli's actual source and re-wiring its seams. NO comments/suggestions/history/presence/sync
changes (those are Phases 2–3).

**Architecture:** Port muesli `apps/web` source files (same Svelte 5 + CM6 stack) into
`demo_muesli/src/lib`, adapting three kinds of seam: (a) collab references → removed/stubbed,
(b) muesli's `useDocSession()`/router → demo's `editorState` + `tabs`, (c) i18n `t()` → literal
English. The CM editor mount, sync, and autosave from the prior branch stay; only the editing
surface gets richer.

**Tech Stack:** Svelte 5 runes, CodeMirror 6, `marked`, `dompurify`, `katex`, `mermaid`,
`@codemirror/lang-{css,html,javascript}`, `@lezer/common`, DaisyUI, `lucide-svelte`.

## Global Constraints

- Branch `feat/muesli-editor-port` (off `feat/obsidian-editor`). Clean commits — NO
  `Co-Authored-By`/AI trailer. Julian merges.
- Svelte 5 runes only. pnpm. Lucide icons, NEVER emojis in UI chrome (muesli's `✦` agent glyph
  is content, not chrome — N/A in Phase 1).
- Do NOT touch sync/seed/autosave logic in `EditorPane.svelte` except the additive Toolbar mount
  and the `editorState.activeView` wiring described in Task 4. Keep `createEditor`'s `collab?`
  slot intact.
- Reference source (copy from, do NOT modify): `~/Code/muesli/apps/web/src/...`. When a ported
  file imports another ported file, use demo's destination path.
- `cargo` is untouched this phase; the gate is `pnpm test` + `pnpm check` (0 errors) + `pnpm build`.
- Port files verbatim EXCEPT the explicit adaptations each task lists. Match muesli's English
  wording (from `~/Code/muesli/apps/web/src/i18n/en.ts`) when replacing `t()` calls.

## File map (destinations in demo_muesli)

- `src/lib/markdown/render.ts` — REPLACE demo's trivial renderer with muesli `src/render.ts`.
- `src/lib/markdown/mermaid.ts` — NEW, from muesli `src/mermaid.ts`.
- `src/lib/markdown/docExport.ts` — NEW, from muesli `src/docExport.ts`.
- `src/lib/editor/livePreview/{index,inline,blocks,transform,widgets,languages}.ts` — NEW, from
  muesli `src/livePreview/*`. (Replaces demo's single `src/lib/editor/livePreview.ts`.)
- `src/lib/editor/mdCommands.ts` — NEW, from muesli `src/mdCommands.ts`.
- `src/lib/Toolbar.svelte` — NEW, adapted from muesli `src/Toolbar.svelte`.
- `src/lib/editorState.svelte.ts` — MODIFY: add `activeView` + `selectionEpoch`.
- `src/lib/editor/createEditor.ts` — MODIFY: `codeLanguages: fenceLanguage`; use ported
  `livePreview()`; fire updateListener on selection too.
- `src/lib/editor/theme.ts` — MODIFY: reconcile font-family with prose live-preview.
- `src/lib/EditorPane.svelte` — MODIFY: mount Toolbar; set `editorState.activeView`.
- `src/lib/ReadingView.svelte` — MODIFY: use ported `render.ts` + mermaid + `.prose-muesli`.
- `src/app.css` — MODIFY: add `.cm-live-*` + `.prose-muesli` blocks + `--color-accent`; retire
  `.cm-lp-*`; remap `.reading-view` to `.prose-muesli`.
- DELETE: `src/lib/editor/livePreview.ts` + its `*.test.ts`; demo's old `src/lib/markdown/render.ts`
  body is replaced (path kept).

---

## Task 1: Render / export / mermaid pipeline + dependencies

**Files:**
- Modify: `package.json`
- Create/replace: `src/lib/markdown/render.ts` (replace body), `src/lib/markdown/mermaid.ts`,
  `src/lib/markdown/docExport.ts`
- Modify: `src/app.css` (add `.prose-muesli` block + `--color-accent`), `src/routes/+layout.svelte`
  (global KaTeX CSS import)
- Test: `src/lib/markdown/render.test.ts` (replace demo's existing render test)

**Interfaces (Produces):**
- `render.ts`: `renderMarkdown(src: string): string`, `slugify(s: string): string`,
  `setSanitizer(fn: Sanitizer)`, `PURIFY_CONFIG`, `type Sanitizer`.
- `mermaid.ts`: `renderMermaidDiagrams(root: HTMLElement, isCurrent?: () => boolean): Promise<void>`.
- `docExport.ts`: `buildHtmlExport(title, markdownSrc)`, `downloadMarkdown(slug, text)`,
  `downloadHtml(slug, title, text)`, `printDocument(title, text)`.

**Steps:**
- [ ] **Add deps.** `pnpm add katex@^0.17.0 mermaid@^11.15.0 dompurify@^3.2.0 marked@^15.0.0`
  and `pnpm add -D @types/katex@^0.16.8`. (Pinning `marked@^15` matches muesli's custom-extension
  API exactly; demo's old trivial renderer has nothing to protect.) `dompurify` replaces the use
  of `isomorphic-dompurify` in render — leave `isomorphic-dompurify` installed for now but switch
  imports.
- [ ] **Port `render.ts`.** Copy `~/Code/muesli/apps/web/src/render.ts` to
  `src/lib/markdown/render.ts` VERBATIM (it has no out-of-scope imports). It imports `marked`,
  `katex`, and `DOMPurify from "dompurify"`. Overwrite demo's current 13-line file.
- [ ] **Port `mermaid.ts`.** Copy `~/Code/muesli/apps/web/src/mermaid.ts` to
  `src/lib/markdown/mermaid.ts` VERBATIM (no internal imports; lazy `import("mermaid")`).
- [ ] **Port `docExport.ts`.** Copy `~/Code/muesli/apps/web/src/docExport.ts` to
  `src/lib/markdown/docExport.ts`; change its internal import `from "./render"` →
  `from "$lib/markdown/render"`. Keep the `katex/dist/katex.min.css?raw` import (Vite supports it).
- [ ] **Global KaTeX CSS.** In `src/routes/+layout.svelte` add `import "katex/dist/katex.min.css";`
  (alongside the existing `import "../app.css";`) so math glyphs render app-wide.
- [ ] **`.prose-muesli` CSS + accent token.** Into `src/app.css`: copy muesli `app.css`'s
  `.prose-muesli` block (its headings/p/ul/ol/code/pre/blockquote/a/table/hr, `.katex-display`,
  `.katex-error`, `a.wikilink`, `.callout`/`.callout-important`, `.frontmatter*`,
  `.mermaid-block*`) — found around muesli `app.css` lines ~325–391. Also add the `--color-accent`
  custom property muesli defines (~line 36, `oklch(52% 0.11 200)`) into demo's `@plugin
  "daisyui/theme"` block (add `--color-accent: oklch(52% 0.11 200);`) so wikilink color resolves.
- [ ] **Test** `src/lib/markdown/render.test.ts` (REPLACE the existing one):
```ts
import { describe, it, expect } from "vitest";
import { renderMarkdown, slugify } from "$lib/markdown/render";

describe("renderMarkdown", () => {
  it("renders a heading", () => {
    expect(renderMarkdown("# Hello")).toContain("<h1");
  });
  it("sanitizes script tags", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).not.toContain("<script");
  });
  it("renders ==highlight== as a mark", () => {
    expect(renderMarkdown("==hi==")).toContain("<mark");
  });
  it("renders a [[wikilink]] as an anchor", () => {
    const html = renderMarkdown("[[My Note]]");
    expect(html).toContain("wikilink");
    expect(html.toLowerCase()).toContain("my-note");
  });
  it("renders a GitHub callout into an alert block", () => {
    expect(renderMarkdown("> [!NOTE]\n> hi")).toContain("callout");
  });
  it("renders inline math via katex", () => {
    expect(renderMarkdown("$x^2$")).toContain("katex");
  });
  it("returns a string and never throws on bad input", () => {
    expect(typeof renderMarkdown("> [!\n$$\\bad")).toBe("string");
  });
  it("empty input → empty-ish string", () => {
    expect(renderMarkdown("")).toBe("");
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("My Note")).toBe("my-note");
  });
});
```
- [ ] Run `pnpm test src/lib/markdown/render.test.ts` → PASS. Then `pnpm check` (0 errors) +
  `pnpm build`. (If marked's types complain about the extension API, ensure `marked@^15` resolved:
  `pnpm why marked`.)
- [ ] Commit: `feat(editor): port muesli render/export/mermaid pipeline (math, mermaid, callouts, wikilinks)`.

---

## Task 2: Pure live-preview transforms + markdown commands + fenced languages

**Files:**
- Modify: `package.json`
- Create: `src/lib/editor/livePreview/transform.ts`, `src/lib/editor/livePreview/languages.ts`,
  `src/lib/editor/mdCommands.ts`
- Test: `src/lib/editor/mdCommands.test.ts`, `src/lib/editor/livePreview/transform.test.ts`

**Interfaces:**
- Consumes: `slugify` from `$lib/markdown/render` (Task 1).
- Produces (per the port manifest): `transform.ts` exports the pure range helpers + types
  (`Range16`, `LiveSpan`, `LiveBlock`, `collectInlineSpans`, `collectBlocks`, `collectImages`,
  `parseTableMarkdown`, `frontmatterRange`, `findWikilinks`, `findHighlights`, `findInlineMath`,
  `findMathBlocks`, `checkboxToggle`, `rangesTouch`, `selectionTouches`, `spanRevealed`,
  `hiddenRanges`); `languages.ts` exports `fenceLanguage(info: string): Language | null`;
  `mdCommands.ts` exports `toggleInlineMark`, `activeInlineMarks`, `setBlockStyle`,
  `currentBlockStyle`, `toggleList`, `currentListKind`, `insertLink`, `insertWikilink`,
  `insertBlockSnippet`, `insertInlineSnippet`, `tableSkeleton`, `isProbablyUrl`, `parseOutline`,
  `SNIPPETS`, `SNIPPET_CURSOR`, and types `InlineMark`, `BlockStyle`, `ListKind`, `OutlineItem`.

**Steps:**
- [ ] **Add deps.** `pnpm add @codemirror/lang-css@^6.3.1 @codemirror/lang-html@^6.4.11
  @codemirror/lang-javascript@^6.2.5 @lezer/common@^1.5.2`.
- [ ] **Port `languages.ts`.** Copy `~/Code/muesli/apps/web/src/livePreview/languages.ts` to
  `src/lib/editor/livePreview/languages.ts` VERBATIM (no internal imports).
- [ ] **Port `transform.ts`.** Copy `~/Code/muesli/apps/web/src/livePreview/transform.ts` to
  `src/lib/editor/livePreview/transform.ts`; change its internal import of `slugify` from
  `"../render.ts"` (or `"../render"`) → `"$lib/markdown/render"`. No other edits.
- [ ] **Port `mdCommands.ts`.** Copy `~/Code/muesli/apps/web/src/mdCommands.ts` to
  `src/lib/editor/mdCommands.ts`; change its internal import `from "./livePreview/transform.ts"`
  (or `.../transform`) → `from "$lib/editor/livePreview/transform"`. No other edits.
- [ ] **Tests** `src/lib/editor/mdCommands.test.ts` (use `EditorState` to drive pure commands):
```ts
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  setBlockStyle, currentBlockStyle, toggleList, currentListKind,
  isProbablyUrl, parseOutline, tableSkeleton,
} from "$lib/editor/mdCommands";

function stateWith(doc: string, anchor = 0, head = anchor) {
  return EditorState.create({ doc, selection: { anchor, head } });
}

describe("mdCommands", () => {
  it("setBlockStyle h1 prefixes the line", () => {
    const s = stateWith("hello", 1);
    const tr = setBlockStyle(s, "h1");
    const next = s.update(tr).state;
    expect(next.doc.toString()).toBe("# hello");
    expect(currentBlockStyle(next)).toBe("h1");
  });
  it("toggleList bullet adds a marker", () => {
    const s = stateWith("item", 1);
    const next = s.update(toggleList(s, "bullet")).state;
    expect(next.doc.toString().startsWith("- ")).toBe(true);
    expect(currentListKind(next)).toBe("bullet");
  });
  it("isProbablyUrl recognises a url", () => {
    expect(isProbablyUrl("https://x.com")).toBe(true);
    expect(isProbablyUrl("just text")).toBe(false);
  });
  it("parseOutline extracts headings in order", () => {
    const items = parseOutline("# A\n\n## B\n\ntext\n# C");
    expect(items.map((i) => i.text)).toEqual(["A", "B", "C"]);
    expect(items.map((i) => i.level)).toEqual([1, 2, 1]);
  });
  it("tableSkeleton produces a GFM table", () => {
    expect(tableSkeleton(2, 1)).toContain("| --- |");
  });
});
```
  (If muesli ships `mdCommands.test.ts`/`transform.test.ts` under `apps/web`, also copy those,
  fixing import paths — they are higher-fidelity than the above. Keep the above as a floor.)
- [ ] **Test** `src/lib/editor/livePreview/transform.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseTableMarkdown, frontmatterRange } from "$lib/editor/livePreview/transform";

describe("transform", () => {
  it("parseTableMarkdown parses headers + rows", () => {
    const t = parseTableMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(t).not.toBeNull();
    expect(t!.headers).toEqual(["a", "b"]);
    expect(t!.rows[0]).toEqual(["1", "2"]);
  });
  it("frontmatterRange finds leading YAML block", () => {
    const r = frontmatterRange("---\ntitle: x\n---\nbody");
    expect(r).not.toBeNull();
    expect(r!.from).toBe(0);
  });
  it("frontmatterRange null when no frontmatter", () => {
    expect(frontmatterRange("# just a heading")).toBeNull();
  });
});
```
  (Adjust property names — `headers`/`rows`/`from` — to the actual `ParsedTable`/`Range16` shapes
  if they differ; read the ported `transform.ts` types and match them.)
- [ ] Run `pnpm test` (the two new files) → PASS; `pnpm check` (0 errors) + `pnpm build`.
- [ ] Commit: `feat(editor): port live-preview transforms, markdown commands, fenced languages`.

---

## Task 3: Live-preview CodeMirror bundle + editor wiring

**Files:**
- Create: `src/lib/editor/livePreview/widgets.ts`, `src/lib/editor/livePreview/inline.ts`,
  `src/lib/editor/livePreview/blocks.ts`, `src/lib/editor/livePreview/index.ts`
- Modify: `src/lib/editor/createEditor.ts`, `src/lib/editor/theme.ts`, `src/app.css`
- Delete: `src/lib/editor/livePreview.ts` and its `*.test.ts` (if present)

**Interfaces:**
- Consumes: `transform.ts`, `widgets.ts`, `render.ts`, `mermaid.ts`, `languages.ts`.
- Produces: `livePreview/index.ts` exports `livePreview(): Extension[]` and re-exports
  `fenceLanguage`.

**Steps:**
- [ ] **Port `widgets.ts`.** Copy `~/Code/muesli/apps/web/src/livePreview/widgets.ts` to
  `src/lib/editor/livePreview/widgets.ts`. Edits: change `from "../mermaid"` →
  `from "$lib/markdown/mermaid"`; `from "../render"` → `from "$lib/markdown/render"`; `from
  "./transform"` stays relative (`"./transform"`). REMOVE the i18n import
  (`import { t } from "../i18n/index.svelte"`) and replace its single use
  `t("editor.toggleTask")` with the literal `"Toggle task"`. Keep
  `import "katex/dist/katex.min.css";`.
- [ ] **Port `inline.ts`.** Copy to `src/lib/editor/livePreview/inline.ts` VERBATIM (its imports
  `./transform`, `./widgets` are relative and resolve in the new dir).
- [ ] **Port `blocks.ts`.** Copy to `src/lib/editor/livePreview/blocks.ts` VERBATIM (relative
  imports resolve).
- [ ] **Port `index.ts`.** Copy `~/Code/muesli/apps/web/src/livePreview/index.ts` to
  `src/lib/editor/livePreview/index.ts`. Edit: REMOVE the `import { gotoDoc } from
  "../route.svelte"` and, in the mousedown handler, change the `data-live-doc` (wikilink) branch
  from `gotoDoc(...)` to a no-op that does nothing (Phase 1 has no doc router) — leave the
  `data-live-href` external-link `window.open(...)` branch intact, and keep the checkbox-toggle
  branch. Add a short comment: `// wikilink navigation lands in a later phase`.
- [ ] **Wire `createEditor.ts`.** Change `markdown({ base: markdownLanguage })` →
  `markdown({ base: markdownLanguage, codeLanguages: fenceLanguage })` (import `fenceLanguage` from
  `$lib/editor/livePreview`). Replace the import + call of the OLD `./livePreview`
  (`livePreview()` returning a single `Extension`) with the new bundle from
  `$lib/editor/livePreview` (`livePreview()` returns `Extension[]` — spread it into the extensions
  array). Keep the `collab?: Extension` slot, `lineWrapping`, `history()`, keymaps, theme, and the
  `updateListener` onChange. (Selection wiring is added in Task 4.)
- [ ] **Reconcile `theme.ts`.** In `muesliTheme`, REMOVE the `.cm-scroller { font-family:
  monospace }` rule (the live-preview line classes drive monospace on code/table/frontmatter
  lines). Keep the structural rules: centered ~700px `.cm-content`, caret/selection colors,
  hidden gutters, base background. The prose font for `.cm-content` comes from the `.cm-live-*`
  CSS block (next step).
- [ ] **`.cm-live-*` CSS.** Into `src/app.css`: copy muesli `app.css`'s live-preview decoration
  block (the `.cm-editor .cm-content` prose font rule + every `.cm-live-*` class and the
  `.cm-live-widget.*` block-widget styles) — muesli `app.css` ~lines 158–245. REMOVE demo's old
  `.cm-lp-*` classes (they paired with the deleted `editor/livePreview.ts`).
- [ ] **Delete** `src/lib/editor/livePreview.ts` and its test file
  (`src/lib/editor/livePreview.test.ts` if it exists). `git rm` them.
- [ ] Verify nothing still imports the old `./livePreview` single-extension symbol: `grep -rn
  "editor/livePreview'" src` and fix any stragglers (should only be `createEditor.ts`).
- [ ] **Test/gate.** The CM widgets are DOM/viewport — manual smoke. The pure parts are covered by
  Task 2. Gate: `pnpm check` (0 errors) + `pnpm build` MUST pass. Document the manual smoke in the
  report: open a note containing a table, `$$x^2$$`, a ```mermaid fence, `[[Wiki]]`, `==hi==`,
  `- [ ] task`, an image — each renders in live preview and reveals raw markdown when the cursor
  enters its line.
- [ ] Commit: `feat(editor): port muesli live-preview CodeMirror bundle (tables, math, mermaid, wikilinks)`.

---

## Task 4: Formatting toolbar + EditorPane/ReadingView integration

**Files:**
- Create: `src/lib/Toolbar.svelte`
- Modify: `src/lib/editorState.svelte.ts`, `src/lib/editor/createEditor.ts`,
  `src/lib/EditorPane.svelte`, `src/lib/ReadingView.svelte`, `src/app.css`

**Interfaces:**
- Consumes: `mdCommands.ts`, `docExport.ts`, `render.ts`, `mermaid.ts`; `editorState.activeView`.
- Produces: `Toolbar.svelte` (a component reading the active view from `editorState`); reading
  view now renders rich markdown.

**Steps:**
- [ ] **Extend `editorState.svelte.ts`.** Add two reactive fields to the store:
  `activeView: EditorView | null = $state(null)` (import `EditorView` from `@codemirror/view`) and
  `selectionEpoch = $state(0)`. (These let the Toolbar derive active marks reactively without
  reaching into `EditorPane`'s effect closure.)
- [ ] **Selection signal in `createEditor.ts`.** Change the `updateListener` so it fires on
  selection too and bumps the epoch: replace the existing `updateListener.of((u) => { if
  (u.docChanged) onChange(...) })` with one that calls `onChange` on `u.docChanged` AND calls a new
  optional `opts.onSelection?.()` when `u.docChanged || u.selectionSet`. Add `onSelection?: () =>
  void` to `createEditor`'s opts type. (Keep everything else.)
- [ ] **Wire view + selection in `EditorPane.svelte`.** Where the `EditorView` is created (both the
  sync and local-only branches), after `view = createEditor({...})` set
  `editorState.activeView = view`, and pass `onSelection: () => { editorState.selectionEpoch++; }`
  into `createEditor`. In the `$effect` cleanup AND in the read-mode early-return path, set
  `editorState.activeView = null` (so the Toolbar disables when no editor is mounted). Do NOT alter
  the sync/seed/autosave logic.
- [ ] **Port + adapt `Toolbar.svelte`.** Copy `~/Code/muesli/apps/web/src/Toolbar.svelte` to
  `src/lib/Toolbar.svelte`, then adapt:
  - **Icons:** rewrite the 24 `import X from "@lucide/svelte/icons/<name>"` lines to demo's style:
    `import { Undo2, Redo2, Bold, Italic, Strikethrough, Code, Link, List, ListOrdered, ListChecks, Table, Image, Minus, SquareFunction, Heading1, Heading2, Heading3, Quote, ChevronDown, Download, FileDown, Plus } from "lucide-svelte";` (map each muesli kebab icon to its PascalCase `lucide-svelte` export; pick the closest existing Lucide name where muesli's differs).
  - **i18n:** replace every `t('<key>')` with the literal English string from
    `~/Code/muesli/apps/web/src/i18n/en.ts` (look up each key's value; ~62 calls — titles/labels).
  - **Session seam:** remove `useDocSession()`/`collab`. The component reads the active editor from
    `editorState.activeView` (import the `editorState` store). Derive:
    `const view = $derived(editorState.activeView);`
    `const _epoch = $derived(editorState.selectionEpoch);` (touch it so derivations recompute)
    `const canEdit = $derived(view !== null);`
    `const activeMarks = $derived(view ? activeInlineMarks(view.state) : new Set());`
    `const blockStyle = $derived(view ? currentBlockStyle(view.state) : "normal");`
    `const listKind = $derived(view ? currentListKind(view.state) : null);`
    Each command button dispatches onto the view, e.g.
    `function applyMark(m){ if(!view) return; view.dispatch(toggleInlineMark(view.state, m)); view.focus(); }` (same pattern for block/list/link/insert).
  - **Undo/redo:** replace the `yUndoManagerKeymap` calls with `@codemirror/commands` `undo`/`redo`:
    `import { undo, redo } from "@codemirror/commands";` and `onclick={() => view && undo(view)}` /
    `redo(view)`. (Sync-aware undo is a Phase-2 refinement; CM history covers local editing now.)
  - **REMOVE the Comment button** (`requestComposer`) and the **Editing/Suggesting mode dropdown**
    (both collab — Phase 2). Keep style dropdown, bold/italic/strike/inline-code, link popover,
    checklist/bullet/numbered, the Insert menu (table/image/hr/code/math/mermaid/callout/wikilink),
    and Download/Export-HTML/Export-PDF.
  - **Export seam:** the export buttons call `downloadMarkdown(slug, text)` /
    `downloadHtml(slug, title, text)` / `printDocument(title, text)` from
    `$lib/markdown/docExport`. Source `text` from `editorState.currentText` and `slug`/`title` from
    the active tab: `import { tabs } from "$lib/tabs.svelte";` →
    `const title = $derived(tabs.active()?.name ?? "untitled");` and a `slug = title` is fine.
  - The component takes NO required props now (reads stores). If muesli's `{ title }` prop is
    referenced, replace with the derived `title` above.
- [ ] **Mount Toolbar in `EditorPane.svelte`.** Render `<Toolbar />` directly above the
  `cm-host` div (only in edit mode, not read mode). It needs no props.
- [ ] **Rich `ReadingView.svelte`.** It already calls `renderMarkdown(editorState.currentText)`;
  ensure the import resolves to the ported `$lib/markdown/render`. Wrap the output container in
  `class="prose-muesli reading-view"`. After `{@html ...}` renders, run mermaid: in an `$effect`
  that depends on `editorState.currentText`, call `renderMermaidDiagrams(containerEl)` (bind the
  container with `bind:this`). Import `renderMermaidDiagrams` from `$lib/markdown/mermaid`.
- [ ] **CSS.** Ensure `.reading-view` content inherits `.prose-muesli` (either keep both classes on
  the wrapper as above, or in `src/app.css` make `.reading-view` reuse the prose rules). Remove now
  -dead `.reading-view` heading/list rules that duplicate `.prose-muesli`.
- [ ] **Gate.** `pnpm test` (all prior tests still green) + `pnpm check` (0 errors) + `pnpm build`.
  Manual smoke (document in report): toolbar bold/italic/heading/list/insert-table/insert-math all
  modify the open note; Export .md downloads a file; reading view (⌘E) shows math/mermaid/tables.
- [ ] Commit: `feat(editor): port formatting toolbar + rich reading view, wire to active editor`.

---

## Final (Phase 1)
- [ ] Whole-phase code review (most capable model) against this plan + the Phase-1 sections of the
  design spec.
- [ ] Dispatch ONE fix subagent for any Critical/Important findings.
- [ ] Confirm the prior branch's features still work (vault, tree, tabs, sync, command palette,
  reading view, transcription) — no regressions from the editor swap.
- [ ] Leave branch for Julian; summarize what shipped + manual-smoke results; note Phase 2/3 next.
