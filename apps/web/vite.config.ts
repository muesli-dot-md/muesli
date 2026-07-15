/// <reference types="vitest/config" />
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
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
    // "svelte" is inlined so component tests resolve Svelte's browser (client)
    // runtime — `mount()` — with jsdom-env test files supplying the DOM; plain
    // node-env module tests are unaffected. Mirrors apps/desktop/vite.config.js.
    server: {
      deps: {
        inline: ["svelte", "katex", /@codemirror\//, /@lezer\//],
      },
    },
  },
  plugins: [svelte(), tailwindcss()],
  resolve: {
    // TEST-ONLY (vitest runs Vite in mode "test"): the `browser` condition
    // makes the node-based test runner resolve Svelte's client runtime so
    // `mount()` exists in component tests. It must NOT apply to dev/build:
    // `resolve.conditions` REPLACES Vite's default client conditions there,
    // which was measured to grow the prod entry chunk by ~12 KB (esm-env's
    // dev fallback plus svelte dev internals, turning the compile-time DEV
    // flag into a runtime NODE_ENV check). Scoped this way, `vite build`
    // output is byte-identical to a config without this block.
    ...(mode === "test" ? { conditions: ["browser"] } : {}),
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
}));
