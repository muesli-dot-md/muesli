# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

Muesli is "Google Docs for Markdown files": a Rust sync server + Svelte web app +
Tauri desktop app + CLI. The live document is a text CRDT (yrs/Yjs) over raw
markdown; it is continuously materialized to a plain `.md` in a storage backend,
and external edits to that file are ingested back as text diffs. The `.md` file
stays canonical — nothing is ever converted.

## Repo map

- `crates/muesli-core` — shared engine: CRDT, materialization, ingest, wire protocol
- `crates/muesli-server` — sync server (axum, y-websocket, Postgres, MCP façade at `POST /mcp`)
- `crates/muesli-cli` — the `muesli` binary: file/folder sync bridge, device-code login, MCP stdio proxy
- `apps/web` — web editor (Vite + Svelte 5 + daisyUI + CodeMirror 6)
- `apps/desktop` — Tauri 2 + SvelteKit desktop app; its Rust crate `apps/desktop/src-tauri` is **outside** the cargo workspace
- `packages/editor-core` — shared editor library (render, tables, mermaid, annotations, mdCommands)
- `packages/workspace-setup` — shared onboarding/creation-wizard flow machine
- `integrations/vscode` — presence-only VS Code extension
- `internal/` — gitignored design docs and ADRs. **Read these**: they are the
  richest source of intent (data model, sync protocol, MCP surface). Never cite
  them in public-facing text.
- `docs/` — gitignored here; public docs live in the `muesli-dot-md/docs` repo
  (docs.muesli.md). When you change user-facing behavior (commands, flags, env
  vars, endpoints, UI flows), update the corresponding page there in the same PR-sized change.

## Commits

- Style: `<type>(<scope>): summary` — types seen in history: feat, fix, chore,
  docs, style, refactor, ci. Body explains *why*, wrapped ~72 columns.
- **Never add AI attribution**: no `Co-Authored-By` trailers naming an AI tool,
  no session links, no "Generated with …" lines, nothing of the sort — in
  commits, PR bodies, or code comments.
- No emoji anywhere: commits, code, docs, UI copy (the wordmark is the brand mark).
- Don't push, tag, or create releases unless explicitly asked. CLI releases are
  cut by tagging `cli-v<version>` (must match `[workspace.package].version`).

## Build, test, verify

Everything below must be green before you consider a change done:

```sh
pnpm install
pnpm test           # all vitest suites (editor-core, workspace-setup, web, desktop)
pnpm check          # svelte-check + tsc in every package
pnpm lint           # eslint (flat config: eslint.config.mjs)
pnpm format:check   # prettier (printWidth 100, svelte plugin)
cargo test --workspace
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings
```

The desktop Rust crate is checked separately (it is not in the workspace):

```sh
cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
```

Headless integration scripts (plain Node 22 type-stripping, no build step) live in
`apps/web/scripts/`; the fast ones are `md-commands-test.mjs`, `live-preview-test.mjs`,
`render-test.mjs`. The `*-e2e.mjs` scripts need `docker compose up -d` and spawn their
own server on ports 8790+ — never against the dev server.

CI enforces all of the above (`.github/workflows/ci.yml`: lint, rust-lint,
frontend, server, desktop-build).

## Conventions and gotchas

- **Comment culture**: comments state constraints, invariants, and *why* — not
  what the next line does. Match the density and voice of the file you're in.
  Never leave comments that narrate your change ("now we also handle X").
- **ESLint deviations are documented**: every rule turned off in
  `eslint.config.mjs` carries its rationale inline. If you disable something new,
  write the why next to it.
- **Svelte 5 runes** everywhere (`$state`, `$derived`, `$props`, `$effect`).
  Collections are rebuilt/reassigned, not mutated in place — see the
  `prefer-svelte-reactivity` note in the eslint config before "fixing" that.
- **Web/desktop duplication**: `livePreview/` is intentionally duplicated between
  `apps/web/src` and `apps/desktop/src/lib/editor` (mostly identical files). If
  you touch one, mirror the other, or extract into `packages/editor-core` like
  mdCommands was. Shared code in editor-core uses self-referencing subpath
  imports (`@muesli/editor-core/...`), never relative imports with `.ts`
  extensions — the headless node scripts depend on it.
- **i18n**: the web app has six locales (`apps/web/src/i18n/{en,de,es,fr,it,pt}.ts`).
  A new UI string means a key in **all six** (English fallback exists, but keys
  are added everywhere in this repo). The desktop app is not localized; its
  copy lives in components / `packages/workspace-setup/src/copy.ts`.
- **Server env loading**: the server loads `./.env` from its cwd via dotenvy
  (parent dirs too). Spawning a server in tests/scripts: set `cwd` outside the
  repo and pass explicit env, or the repo `.env` leaks in. E2e scripts use
  scratch databases (`muesli_<name>_e2e`, recreated per run) — copy that pattern
  (see `apps/web/scripts/search-e2e.mjs`), never share the dev database.
- **Dev stack**: compose services on non-default ports (postgres 5433, redis
  6380, dex 5556/5558, minio 9000, gitea 3300); dev server on 127.0.0.1:8787;
  web on 5173 (strictPort). Don't kill or restart the user's dev server or
  containers without asking.
- **Auth invariants**: 403/404/410 collapse to one "not found or access denied"
  message (no existence oracle); agent tokens are refused by account endpoints
  (an agent must never mint itself keys); gated agent actions
  (`MUESLI_AGENT_GATED_ACTIONS`) stay off by default. Preserve these walls.
- **Secrets**: never commit `.env`, `muesli.json`, `gitea.json`,
  `apps/desktop/.updater-key*`, or anything resembling a credential. Secrets are
  hashed or encrypted at rest server-side; keep Debug impls redacting (see
  `MsAuth`).
- **MCP parity**: new user-facing REST surface should get a bridged MCP tool in
  `crates/muesli-server/src/mcp.rs` (the bridge calls the real handler — parity
  by construction) and a row in the docs tool reference.

## When unsure

Prefer reading `internal/design/*.md` and existing tests over guessing. If a
change touches product behavior with no design note and no test, say so instead
of inventing semantics.
