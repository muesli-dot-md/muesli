// Workspace-wide ESLint flat config: TypeScript + React across apps/,
// packages/, and integrations/, with eslint-config-prettier so formatting is
// Prettier's job alone (run `pnpm format`). Kept deliberately un-type-aware:
// type correctness is enforced by tsc in `pnpm check`; ESLint here catches
// real code smells fast (unused code, unsafe patterns).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/",
      "**/dist/",
      "**/build/",
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
  // rules-of-hooks: error; exhaustive-deps: warn (intentional omissions carry
  // an eslint-disable comment with the why, matching the deviations rule below).
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  prettier,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
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
    },
  },
);
