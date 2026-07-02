import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Resolve Svelte's browser (client) runtime in component tests so `mount()`
    // is available; jsdom-env test files supply the DOM. Node-env tests import
    // plain TS modules and are unaffected by this condition. Scoped to the test
    // runner via `server.deps`, so the Tauri dev/build config is untouched.
    //
    // katex/@codemirror/@lezer are inlined for the same reason as in
    // apps/web/vite.config.ts: katex pulls a `.css` side-effect import (which
    // Node's ESM loader can't handle), and inlining @codemirror/* routes them
    // through Vite's resolver so `resolve.dedupe` yields a single
    // @codemirror/state copy (else EditorState.create fails its instanceof
    // checks under jsdom).
    server: { deps: { inline: ["svelte", "katex", /@codemirror\//, /@lezer\//] } },
  },
  // The Tauri webview is a browser environment; resolving the `browser`
  // condition here makes `mount()` available to component tests (and matches
  // the runtime the app actually ships).
  resolve: {
    conditions: ["browser"],
    // @codemirror/state (and its view/language peers) MUST resolve to a SINGLE
    // instance. @muesli/editor-core declares these as peerDependencies, so the
    // app supplies the copy; but the workspace can host more than one CM version
    // (the web app pins different ranges). If two copies of @codemirror/state
    // load, an extension built by one isn't recognized by the other's
    // EditorState.create ("Unrecognized extension value… multiple instances of
    // @codemirror/state") and the editor fails to mount (blank document pane).
    // Force one copy — mirrors apps/web/vite.config.ts.
    dedupe: ["@codemirror/state", "@codemirror/view", "@codemirror/language"],
  },
  plugins: [tailwindcss(), sveltekit()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
