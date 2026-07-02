// Workspace-wide ESLint flat config: TypeScript + Svelte 5 across apps/,
// packages/, and integrations/, with eslint-config-prettier so formatting is
// Prettier's job alone (run `pnpm format`). Kept deliberately un-type-aware:
// type correctness is enforced by svelte-check/tsc in `pnpm check`; ESLint here
// catches real code smells fast (unused code, unsafe patterns, svelte misuse).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import svelte from "eslint-plugin-svelte";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/",
      "**/dist/",
      "**/build/",
      "**/.svelte-kit/",
      "**/coverage/",
      "**/target/",
      "internal/",
      "dev/",
      "apps/desktop/vendor/",
      "apps/desktop/src-tauri/",
      "apps/web/public/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs["flat/recommended"],
  prettier,
  ...svelte.configs["flat/prettier"],
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    rules: {
      // Best-effort `try { … } catch {}` is an idiom throughout (probes,
      // cleanup paths, storage polls); an empty catch is a decision, not a bug.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // `_`-prefixed = intentionally unused (rest-destructuring, stub params).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          ignoreRestSiblings: true,
        },
      ],
      // The markdown preview pipeline renders sanitized HTML on purpose
      // (DOMPurify in editor-core/render.ts); the blanket rule would flag
      // every {@html} in the preview surfaces.
      "svelte/no-at-html-tags": "off",
      // Audited 2026-07 (all 23 hits): every flagged Map/Set/Date is either
      // built fresh and returned inside $derived.by / a plain helper, updated
      // immutably (`lines = new Map(lines)` in transcript.svelte.ts), or
      // explicitly non-reactive bookkeeping (tabs.svelte.ts flushCallbacks).
      // Reactivity comes from re-deriving/reassigning, never from mutating a
      // collection in place, so SvelteMap/SvelteSet would add proxy overhead
      // without changing behavior. Re-audit before introducing a store that
      // mutates a collection held in $state.
      "svelte/prefer-svelte-reactivity": "off",
      // Our svelte-ignore comments target COMPILER warnings (a11y_*,
      // state_referenced_locally) enforced by svelte-check and the vite
      // build. ESLint doesn't run the compiler's checks, so it would flag
      // every one of them as "unused" — removing them would reintroduce the
      // real warnings in `pnpm check`.
      "svelte/no-unused-svelte-ignore": "off",
    },
  },
);
