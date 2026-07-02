/// <reference types="vitest/config" />
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // katex ships a `.css` side-effect import (pulled in by livePreview widgets).
    // Inlining it routes the import through Vite's transform instead of Node's
    // ESM loader, which would otherwise choke on the `.css` extension.
    // The @codemirror/* packages are inlined too so they go through Vite's
    // resolver (which honours `resolve.dedupe`); otherwise the test loads two
    // copies of @codemirror/state and EditorState.create fails its instanceof
    // checks ("multiple instances of @codemirror/state").
    server: {
      deps: {
        inline: ["katex", /@codemirror\//, /@lezer\//],
      },
    },
  },
  plugins: [svelte(), tailwindcss()],
  resolve: {
    // @codemirror/state (and its view/language peers) MUST resolve to a SINGLE
    // instance. The workspace installs both 6.6.0 and 6.7.0; if two copies load,
    // an extension built by one isn't recognized by the other's EditorState.create
    // ("Unrecognized extension value… multiple instances of @codemirror/state"),
    // and the editor fails to mount entirely (blank document pane). Force one copy.
    dedupe: ["@codemirror/state", "@codemirror/view", "@codemirror/language"],
  },
  // The server's credentialed CORS allows exactly MUESLI_WEB_ORIGIN (default :5173).
  // If vite silently hops to another port, every authenticated fetch breaks while the
  // editor ws still connects — maddening to debug. Fail loudly instead.
  server: { port: 5173, strictPort: true },
});
