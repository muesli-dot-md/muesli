import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],

  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**"],
    // katex pulls a `.css` side-effect import (which Node's ESM loader can't
    // handle), and inlining @codemirror/* routes them through Vite's resolver
    // so `resolve.dedupe` yields a single @codemirror/state copy (else
    // EditorState.create fails its instanceof checks under jsdom).
    server: { deps: { inline: ["katex", /@codemirror\//, /@lezer\//] } },
  },

  resolve: {
    // The Tauri webview is a browser environment.
    conditions: ["browser"],
    // @codemirror/state (and its view/language peers) MUST resolve to a SINGLE
    // instance. @muesli/editor-core declares these as peerDependencies, so the
    // app supplies the copy; but the workspace can host more than one CM version
    // (the web app pins different ranges). If two copies of @codemirror/state
    // load, an extension built by one isn't recognized by the other's
    // EditorState.create ("Unrecognized extension value… multiple instances of
    // @codemirror/state") and the editor fails to mount (blank document pane).
    // react/react-dom deduped for the same reason (hooks across duplicated
    // copies throw). Mirrors apps/web/vite.config.ts.
    dedupe: ["@codemirror/state", "@codemirror/view", "@codemirror/language", "react", "react-dom"],
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  build: {
    // tauri.conf.json frontendDist is "../build" (SvelteKit's old output dir);
    // keep the same dir so src-tauri stays untouched.
    outDir: "build",
    emptyOutDir: true,
  },

  // Vite options tailored for Tauri development and only applied in
  // `tauri dev` or `tauri build`:
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
});
