/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],

  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    // Legacy Svelte-era tests stay on disk as porting reference until the
    // Stage-2 integration phase deletes the Svelte sources. Excluded here
    // because they import `.svelte` components / `.svelte.ts` rune modules
    // that no longer compile without the Svelte plugin. Pure-TS module tests
    // (appGate, presence, mentions, prefsSyncCore, API clients, …) keep
    // running.
    exclude: [
      "**/node_modules/**",
      "src/SettingsPage.test.ts",
      "src/settings/ProfileSection.test.ts",
      "src/settings/ColorBubbleRow.svelte.test.ts",
      "src/settings/settingsNav.test.ts",
    ],
    // katex pulls a `.css` side-effect import (which Node's ESM loader can't
    // handle), and inlining @codemirror/* routes them through Vite's resolver
    // so `resolve.dedupe` yields a single @codemirror/state copy (else
    // EditorState.create fails its instanceof checks under jsdom).
    server: { deps: { inline: ["katex", /@codemirror\//, /@lezer\//] } },
  },

  resolve: {
    // @codemirror/state (and its view/language peers) MUST resolve to a SINGLE
    // instance. The workspace installs more than one CM version; if two copies
    // load, an extension built by one isn't recognized by the other's
    // EditorState.create ("Unrecognized extension value… multiple instances of
    // @codemirror/state"), and the editor fails to mount entirely (blank
    // document pane). react/react-dom deduped for the same reason (hooks
    // across duplicated copies throw); yjs because a Y.Doc built by one copy
    // isn't instanceof the other's. Mirrors apps/desktop/vite.config.ts.
    dedupe: [
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/language",
      "react",
      "react-dom",
      "yjs",
    ],
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  build: {
    // Served in production by muesli-server (MUESLI_WEB_DIR → ServeDir with
    // index.html fallback); the Dockerfile copies this dir. Vite's default,
    // made explicit so nobody "cleans it up" into a breakage.
    outDir: "dist",
    emptyOutDir: true,
  },

  // The server's credentialed CORS allows exactly MUESLI_WEB_ORIGIN (default :5173).
  // If vite silently hops to another port, every authenticated fetch breaks while the
  // editor ws still connects — maddening to debug. Fail loudly instead.
  server: { port: 5173, strictPort: true },
});
