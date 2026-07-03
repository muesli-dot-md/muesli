// @muesli/editor-core — shared rendering & editor core for the muesli web and
// desktop apps. Pure markdown rendering (render/mermaid/docExport), collab
// offset math (offsets), and the CodeMirror collaboration decorations
// (annotations) plus an opt-in baseTheme (annotationsTheme).
//
// This package ships TS source directly; each consuming app's Vite/svelte-check
// transpiles it (no build step). CodeMirror is a peer dependency so each app
// resolves it to its own already-installed (and deduped) copy — shipping a
// third copy would reintroduce the "multiple instances of @codemirror/state"
// crash.

export * from "./render";
export * from "./mermaid";
export * from "./tableModel";
export * from "./tableInteraction";
export * from "./zoom";
export * from "./scrollPastEnd";
export * from "./offsets";
export * from "./docExport";
export * from "./annotations";
export * from "./annotationsTheme";
