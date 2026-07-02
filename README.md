# muesli

**Google Docs for Markdown files.** Real-time multiplayer editing where the plain `.md` in your
storage stays canonical, AI agents are first-class collaborators, and the whole thing is
self-hostable.

The live document is a text CRDT (`yrs`/Yjs) over the raw markdown source; it is continuously
materialized to a plain `.md`, and external edits to that file (your editor, your agent, git) are
ingested back as text diffs. Nothing is ever converted — the file stays a markdown file.

## Layout

- `crates/muesli-core` — shared document engine: text CRDT, materialization, out-of-band ingest,
  wire protocol.
- `crates/muesli-server` — sync server: y-websocket protocol, single-owner Doc Rooms (axum/tokio).
- `crates/muesli-cli` — the `muesli` local agent: a sync bridge between a `.md` on disk and a
  server room. Never touches git.
- `apps/web` — the web editor: Vite + Svelte 5 + daisyUI, CodeMirror 6, live cursors, markdown
  preview.
- `apps/desktop` — the Tauri + Svelte local-first desktop app over a folder of `.md` files: the
  full editor surface (live cursors, comments, suggestions, history, link graph) plus on-device
  speech-to-text dictation (Parakeet ONNX, runs locally).
- `packages/editor-core` — shared TypeScript editor library (markdown render, tables, Mermaid,
  CRDT collaboration decorations) consumed by both `apps/web` and `apps/desktop`.
- `packages/workspace-setup` — shared first-login onboarding flow machine (unit-tested here,
  rendered by both apps).
- `integrations/vscode` — Muesli Presence: live cursors + participants inside VS Code for
  muesli-linked files (presence only; content syncs via `muesli open`).
- `shared/` — cross-app design tokens (`palette.css`).
- `dev/` — local dev fixtures: the two Dex OIDC issuer configs for docker compose (copy each
  `config.example.yaml` to `config.yaml` next to it).

## Develop

```sh
cp dev/dex/config.example.yaml dev/dex/config.yaml     # local OIDC issuer configs
cp dev/dex2/config.example.yaml dev/dex2/config.yaml   # (compose mounts these; edits stay local)
docker compose up -d                # postgres, redis, dex, dex2, minio, gitea
cp .env.example .env                # then uncomment the dev blocks you want (OIDC, Redis, S3…)
cargo run -p muesli-server          # reads .env; sync server on ws://localhost:8787
pnpm install
pnpm dev:web                        # web app on http://localhost:5173
```

The server loads `./.env` at startup (real environment variables win). Without
`DATABASE_URL` it runs volatile (in-memory, loud warning). With it, every edit
lands in an append-only per-document log with periodic snapshots — rooms hydrate on first
connect, so documents survive restarts and the log doubles as edit history.

Open http://localhost:5173 in two windows and type — live cursors, instant sync. Pick a document
via the URL hash: `http://localhost:5173/#my-doc`.

### Code quality

Formatting is Prettier (TS/Svelte/CSS, `.prettierrc`) and rustfmt; linting is ESLint
(flat config in `eslint.config.mjs`, with per-rule rationale for every deviation from the
recommended sets) and clippy with warnings denied. CI enforces all of it on every PR —
run locally with:

```sh
pnpm format     # prettier --write across the repo
pnpm lint       # eslint over apps/, packages/, integrations/
pnpm check      # svelte-check + tsc in every package that has one
pnpm test       # every vitest suite in the workspace
cargo fmt --all && cargo clippy --workspace --all-targets   # rust (repeat with
                # --manifest-path apps/desktop/src-tauri/Cargo.toml for the tauri crate)
```

### Auth

Muesli is a pure OIDC relying party — it has no auth of its own. Without `OIDC_ISSUER` the
server runs in **open mode** (every connection is an anonymous editor; the local-solo
exception). To run multi-user auth locally, uncomment the `OIDC_*` block in `.env` and use the
dev Dex issuer from compose (`docker compose up -d dex`, login `dev@muesli.md` / `password`):
signing in creates a `User` + personal Workspace; documents you open are yours; the **Share**
button mints role-scoped guest links (viewer / commenter / editor) that anyone can use without
an account — viewer connections can read and see cursors, but their writes are rejected
server-side. Sessions live in Redis (`REDIS_URL`) or in-memory without it.

Workspaces are manageable over REST (ADR 0011): `GET /api/workspaces` lists yours,
`POST /api/workspaces/{id}/invites {email, role}` adds an existing user immediately or leaves an
invite that is claimed on their first login, and admins can rename the workspace and manage
member roles (the last admin can never be demoted or removed). Admins can also delete a
workspace (`DELETE /api/workspaces/{id}`, or Settings → General → Danger Zone with a typed-name
confirmation) — this permanently removes every document, comment, and suggestion in it.

*First-login onboarding — manual checklist* (the flow machine, trigger matrix, and
copy keys are unit-tested in `packages/workspace-setup` / `apps/web` / `apps/desktop`;
walk this once per release that touches onboarding):

- [ ] Fresh OIDC user (web, zero workspaces): onboarding shows once; Screen 3's
      "Create your first workspace" opens the creation wizard; abandoning that wizard
      does NOT bring onboarding back (stamped at wizard-open).
- [ ] Invited user (web, already a member): Screen 3 reads "You're already in
      *{workspace}*" and the button jumps there.
- [ ] Skip from each of the three screens — button and Escape: closes, stamps, never
      returns; reloading shows nothing.
- [ ] Open mode (no `OIDC_ISSUER`): shows once per browser (localStorage
      `muesli:onboarded`), skip/finish both stamp it.
- [ ] Desktop first launch: the local-vs-server fork — "Work locally" opens the
      workspace picker; "Connect to a server" opens the sign-in dialog (server shown +
      Change…), then the device-code login and the create-workspace wizard.
- [ ] Second login (web) / second launch (desktop): nothing shows.
- [ ] Web-then-desktop with the same server account: the desktop shows nothing (the
      server flag silences the local one) — and desktop-finish while logged in stamps
      the server flag so the web shows nothing afterwards either.

## The wedge: make any markdown file multiplayer

Install the CLI (macOS arm64/x64, Linux x64/arm64; Windows zip on the
[releases page](https://github.com/muesli-dot-md/muesli/releases)):

```sh
curl -fsSL https://muesli.md/install.sh | sh    # or: brew install muesli-dot-md/tap/muesli
```

Releases are cut by tagging `cli-v<version>` (see `.github/workflows/cli-release.yml`;
the tag must match the `[workspace.package]` version). Or build from source:

```sh
cargo build -p muesli-cli
./target/debug/muesli open ./CLAUDE.md
```

Prints a share link. Edits in the web app land in the file (atomic writes, ~500ms debounce);
edits to the file from any editor, agent, or script are diffed and merged live into the room.
The bridge survives server restarts (reconnect with backoff; offline disk edits are merged on
reconnect as one change).

Against an auth-enabled server:

```sh
muesli login              # OIDC device-code flow → delegated agent token in the OS keychain
muesli open ./notes.md    # connects with the token; you own the document
muesli share ./notes.md --role viewer
muesli status             # who you are + linked files
muesli unlink ./notes.md  # forget the link; the file is never touched
muesli logout
```

## Sync a folder

Drive-desktop-style folder sync (Phase 5, ADR 0014):

```sh
muesli sync ./notes --prefix team   # every *.md under ./notes is linked + live-synced
```

Doc ids derive from the dir-relative path (`sub/deep.md` → `sub-deep`, slugified, the
optional `--prefix` prepended); files already linked keep their existing doc id. Hidden
dirs, `node_modules`, and `target` are skipped. The tree is watched live: a new `.md`
auto-links within seconds; a deleted file stops its session and moves the server doc to
the trash (a reversible soft-delete — restoring it re-materializes the file); a rename
with identical content re-binds to the same
doc id (ADR 0009). Up to 64 concurrent connections — larger trees use lazy sessions that
idle-disconnect and reconnect on change. Ctrl-C shuts down cleanly, flushing any pending
remote edits to disk first. `muesli status` lists every link with its last-synced time;
the index lives in SQLite (`index.db`), with a generated `links.json` mirror kept for the
VS Code extension.

```sh
node apps/web/scripts/sync-daemon-e2e.mjs   # folder-daemon e2e (starts its own server)
```

## Desktop app

`apps/desktop` is a **Tauri + SvelteKit** local-first editor over a folder of `.md` files. It
embeds the `muesli sync` engine in-process (so a folder stays live-synced) and reuses the web
editor's collaboration surfaces — live cursors, comments, suggestions, history, mentions,
notifications, and the graph view — over the same rooms. A local folder becomes collaborative by
**cloning** a cloud workspace into it or **promoting** a local-only folder to one; login is the same
OIDC device flow as the CLI (token in the OS keychain, never exposed to the webview).

It also ships **on-device speech-to-text dictation** (macOS): a local Parakeet ONNX model
transcribes your mic (and optionally system audio) into a markdown meeting transcript or straight
into the current note — fully local, no audio leaves the machine.

```sh
cd apps/desktop && pnpm tauri dev           # run the desktop app in dev (needs the Rust/Tauri toolchain)
```

## Deploy

One image = server + built web app, behind Traefik with Let's Encrypt:

```sh
cp .env.example .env   # set MUESLI_DOMAIN, ACME_EMAIL, POSTGRES_PASSWORD, OIDC_*
docker compose -f docker-compose.prod.yml up -d --build
```

Tests:

```sh
cargo test --workspace
pnpm --filter @muesli/web test:convergence       # needs the server running
node apps/web/scripts/auth-e2e.mjs <room>        # needs dex + server in OIDC mode
node apps/web/scripts/mcp-e2e.mjs                # MCP façade + stdio proxy (starts its own server)
node apps/web/scripts/workspace-s3-e2e.mjs       # workspaces + S3 backend (starts its own server)
node apps/web/scripts/gdrive-e2e.mjs             # Google Drive backend vs a mock Google (starts its own server)
node apps/web/scripts/enterprise-e2e.mjs         # audit log + per-workspace SSO (starts its own server)
```

## Storage backends

The Canonical File can live in a pluggable Storage Backend (ADR 0013); the CRDT stays the live
authority and the backend holds its materialized `.md`.

**Local filesystem** — the `muesli` CLI above *is* the local-FS bridge: `muesli open ./notes.md`
materializes the room into the file and ingests your editor's changes instantly (native watch).

**S3-compatible (MinIO, AWS S3, R2)** — per-workspace connections, attached per document. Secrets
never leave the server environment (`MUESLI_S3_ACCESS_KEY` / `MUESLI_S3_SECRET_KEY`, see
`.env.example`); dev MinIO comes from compose (`docker compose up -d minio minio-init`, bucket
`muesli-dev`, console on http://localhost:9001). The flow, as a workspace admin:

```sh
# 1. connect a bucket to your workspace (admin)
curl -b "$COOKIES" -X POST localhost:8787/api/workspaces/$WS/storage \
  -H 'content-type: application/json' \
  -d '{"kind":"s3","endpoint":"http://localhost:9000","bucket":"muesli-dev"}'
# → {"storage_conn_id":"…"}

# 2. attach a document (editor); rel_path defaults to "<slug>.md".
#    This materializes the current text to the bucket immediately.
curl -b "$COOKIES" -X POST localhost:8787/api/documents/my-doc/storage \
  -H 'content-type: application/json' \
  -d '{"storage_conn_id":"…","rel_path":"notes/my-doc.md"}'
```

From then on every edit is written to the object ~500ms after the typing burst ends
(`documents.content_hash` records the sha256 of the last write). Out-of-band changes — anything
that rewrites the object directly — are **polled** every `MUESLI_STORAGE_POLL_SECS` (default 20;
`MUESLI_S3_POLL_SECS` still works), hash-guarded against Muesli's own writes, and merged into the
live room as a text diff with history origin `ingest`. The polling latency is expected S3 behavior
(ADR 0013), not a defect; local-FS sync via the CLI stays instant.

**Git repo (GitHub, Gitea, Forgejo)** — `kind: "github"`: a workspace's repo holds the documents
via the Contents API, which is wire-compatible across all three forges. Every materialization is a
commit (`muesli: create <path>` / `muesli: update <path>`) on the configured branch; out-of-band
commits are polled and ingested exactly like S3, and competing commits are handled with the API's
sha compare-and-swap (one retry — and git history always retains both sides). The token never
leaves the server environment (`MUESLI_GITHUB_TOKEN`, see `.env.example`); the connection holds
only `{api_base, owner, repo, branch, prefix?}`. `api_base` is `https://api.github.com` for GitHub
or `https://<host>/api/v1` for Gitea/Forgejo. Dev Gitea comes from compose
(`docker compose up -d gitea`, http://localhost:3300, admin `muesli` / `muesli-dev-secret`):

```sh
# 1. connect a repo+branch to your workspace (admin); the branch is probed (bad config → 502)
curl -b "$COOKIES" -X POST localhost:8787/api/workspaces/$WS/storage \
  -H 'content-type: application/json' \
  -d '{"kind":"github","api_base":"http://localhost:3300/api/v1","owner":"muesli","repo":"notes","branch":"main","prefix":"docs"}'
# → {"storage_conn_id":"…"}

# 2. attach a document (editor) — same call as S3; the first commit lands immediately
curl -b "$COOKIES" -X POST localhost:8787/api/documents/my-doc/storage \
  -H 'content-type: application/json' \
  -d '{"storage_conn_id":"…","rel_path":"my-doc.md"}'
```

**Google Drive** — `kind: "gdrive"`: documents live on the **user's own Drive**, so the user bears
their own storage cost (an ADR 0013 launch requirement). Unlike S3/GitHub there is no config to
POST — the connection is born from a per-workspace **OAuth dance**:

```
GET /api/workspaces/{id}/storage/google/start    (workspace admin, browser session)
  → 302 to Google's consent screen (scope drive.file, access_type=offline, prompt=consent)
  → Google redirects to /auth/storage/google/callback?code&state
  → Muesli exchanges the code, finds-or-creates a "Muesli" folder in the user's Drive
    (which doubles as the connection probe), stores the connection, and bounces back
    to the web app with ?storage=connected
```

Attaching documents then works exactly like the other kinds (`POST /api/documents/{slug}/storage`).
Files live **flat** in the Muesli folder — the Drive file name is the `rel_path` with `/` replaced
by `∕` (U+2215), since Drive has no real paths. The scope is **`drive.file` only**: Muesli can
touch the files it created, never the rest of the Drive. The per-user refresh token lives in the
connection row (it cannot be a server env secret) and is redacted from the workspace API; access
tokens are cached in memory and refreshed transparently on expiry. Out-of-band Drive edits are
polled and ingested like every other backend (latency expected per ADR 0013).

Server setup: the OAuth web client comes from `MUESLI_GOOGLE_CLIENT_ID`/`SECRET`,
`MUESLI_GOOGLE_CLIENT_FILE`, or an implicit `./muesli.json` (see `.env.example`). **For local
testing the redirect URI `http://localhost:8787/auth/storage/google/callback` must be registered
on the client in the Google Cloud Console** — without it Google refuses the consent screen.
`apps/web/scripts/gdrive-e2e.mjs` runs the entire dance against a mock Google (no registration
needed); `apps/web/scripts/gdrive-real.mjs` walks you through the real thing once the redirect
URI is registered.

**SharePoint (Microsoft 365)** — `kind: "sharepoint"`: a workspace's documents live in a
SharePoint document library the customer owns, reached **app-only** through Microsoft Graph
with the `Sites.Selected` permission — a tenant admin grants the app write access to exactly
one site, the pattern corporate IT will approve. Connect is form + probe like S3 (no OAuth
redirect): the wizard walks app identity → admin grant → site + library picker → probe.

*Registering the Entra app* (once per deployment): in [Entra admin center](https://entra.microsoft.com)
→ App registrations → New registration. For the **hosted instance** register a
**multi-tenant** app ("Accounts in any organizational directory"); for **self-hosting**
inside one organization a **single-tenant** app is enough. No redirect URI is needed (this
is a daemon app). Under *API permissions* add **Microsoft Graph → Application →
`Sites.Selected`**. Then create a credential: a **client secret** (Certificates & secrets →
New client secret), and/or a **certificate** (upload the public cert; keep the private key).
A workspace may also bring its **own** Entra app through the wizard's "use your own Entra
app" path — those credentials are stored encrypted per workspace (requires
`MUESLI_SECRET_KEY`) and the operator's app is never consented to.

*Server env*:

```sh
MUESLI_MS_CLIENT_ID=…            # the app's Application (client) ID
MUESLI_MS_CLIENT_SECRET=…        # secret auth; OR:
MUESLI_MS_CLIENT_CERT_FILE=…     # PEM file containing certificate + unencrypted private key
                                 # (cert wins when both are set)
# sovereign clouds (US Gov / 21Vianet China) — defaults shown:
MUESLI_MS_LOGIN_BASE=https://login.microsoftonline.com    # .us / partner.microsoftonline.cn
MUESLI_MS_GRAPH_BASE=https://graph.microsoft.com/v1.0     # .us / microsoftgraph.chinacloudapi.cn
```

With neither credential set, the wizard's SharePoint path requires the bring-your-own-app
route (`GET /api/storage/sharepoint/setup` reports `configured: false`).

*The one-time tenant-admin grant* (the wizard shows both snippets pre-filled):

1. Admin consent (admits the app to the tenant):
   `https://login.microsoftonline.com/{tenant}/adminconsent?client_id={client_id}`
2. Site grant (scopes it to exactly one site) — Graph, run as an admin (e.g. Graph Explorer):

   ```
   POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
   { "roles": ["write"],
     "grantedToIdentities": [ { "application": { "id": "{client_id}", "displayName": "Muesli" } } ] }
   ```

   or PnP PowerShell:

   ```
   Grant-PnPAzureADAppSitePermission -AppId {client_id} -DisplayName Muesli -Site {site_url} -Permissions Write
   ```

Files are written at their normal `rel_path` inside the chosen library (optionally under a
prefix). Materialize/poll behave exactly like S3; writes over 4 MB automatically use Graph
upload sessions. Graph 429 throttling surfaces on the workspace's storage-health line and
retries on the next poll tick.

*Manual test checklist* (mocked-Graph tests cover the logic; run this against a real M365
tenant when one is available):

- [ ] Register the app (multi-tenant), add `Sites.Selected`, create a secret AND upload a certificate.
- [ ] Set `MUESLI_MS_CLIENT_ID` + `MUESLI_MS_CLIENT_SECRET`; run the wizard end-to-end on the
      web app: consent URL works, both grant snippets work, "Find libraries" lists the site's
      libraries with the default preselected, probe passes, docs materialize into the library.
- [ ] Switch the server to `MUESLI_MS_CLIENT_CERT_FILE` and reconnect — the certificate path mints tokens.
- [ ] Repeat the wizard on the desktop app.
- [ ] Bring-your-own-app path: connect a workspace with a second app's credentials; verify
      `credentials: "workspace"` in Settings → Connections and that the row's config is redacted.
- [ ] Settings → Connections: connect SharePoint on a grandfathered (unbound) workspace.
- [ ] Revoke the site grant (`DELETE /sites/{site-id}/permissions/{id}`); verify editing still
      works, the health line turns unhealthy with the Graph error, and re-granting recovers on
      the next poll.
- [ ] Enter a wrong site URL / a tenant without consent — the wizard surfaces the AADSTS/grant
      hints from the spec's error table.

*Security note — shared app on multi-customer deployments*: when the server's env-configured
Entra app (`MUESLI_MS_CLIENT_ID`) is multi-tenant and the deployment serves multiple unrelated
customers, ANY workspace admin can attach ANY site that ANY tenant has granted to that app — the
server has no way to verify the connecting admin actually belongs to the target tenant. On
multi-customer ("hosted") deployments, do not configure a shared `MUESLI_MS_*` env app; leave it
unset so every workspace must bring its own Entra app via the wizard. A tenant↔workspace binding
mechanism that would make a shared app safe is tracked as follow-up work.

## Link graph

Muesli indexes cross-document links (ADR 0015): wikilinks (`[[Target]]`, `[[Target|label]]`,
`[[Target#Heading]]`) and relative markdown links (`[x](./other.md)`) — never inside code
fences or spans. Extraction rides the room-persistence seam (debounced ~2s, lazily backfilling
older docs); unresolved targets are kept and re-resolve the moment a matching document is
created. The **Graph** button in the web app opens an Obsidian-style force-directed universe
view (nodes sized by degree, dashed ghost nodes for unresolved targets, click to navigate),
and the Comments sidebar shows **Linked mentions** (backlinks) for the open document.
REST: `GET /api/graph` → `{nodes, edges, unresolved}` (scoped to what the caller can see)
and `GET /api/documents/{slug}/links` → `{outgoing, incoming}`.

## Agents (MCP)

The server exposes an MCP façade at `POST /mcp` (ADR 0008) with **52 tools — full parity with
the user-facing REST surface**. The core document tools: `list_documents`, `read_document`,
`get_history`, `create_document`, `edit_document` (mode `direct` | `suggest`, anchored by
`anchor_text` / byte `range` / `replace_all`, one change set per call), `add_comment`,
`reply_comment`, `list_comments`, `list_suggestions`, and the gated `resolve_comment` /
`accept_suggestion` / `reject_suggestion` / `accept_change_set` / `reject_change_set`.

The rest of the surface is **bridged onto the real REST handlers** — each tool invokes the
handler function with the request's own auth/state, so role checks, token scopes, audit
entries, and storage side effects are the REST ones by construction and cannot drift:
document lifecycle (`update_document`, `trash_document`, `restore_document`, the gated
`purge_document`, `search`), `reopen_comment`, folders, sharing (`create_share_link`,
`list_document_members`), the link graph (`get_graph`, `get_document_links`), notifications
(an agent token reads the **agent identity's own** inbox, never its owner's), workspaces
(list/create/get/rename, the gated `delete_workspace`, invites, member roles, audit), and
storage connections (s3/github; Drive and SharePoint bind via browser OAuth and stay out of
MCP). Account tools (`get_me`, `mint_api_token`, …) inherit the session wall: delegated agent
tokens are refused — an agent can never mint itself keys.

Auth is `Authorization: Bearer mua_…` (mint one with `muesli login`); an open-mode server
needs none. Any MCP client connects through the stdio proxy:

```json
{ "mcpServers": { "muesli": { "command": "muesli", "args": ["mcp"] } } }
```

Two policies (env, ADR 0007/0008): `MUESLI_AGENT_DIRECT` (default `auto`) downgrades agent
`direct` edits to suggestions while a human is co-present in the document, so live humans
review agent changes instead of colliding with them. `MUESLI_AGENT_GATED_ACTIONS` (default
off) keeps agents from approving work (accepting suggestions, resolving comments) or
destroying it (`purge_document`, `delete_workspace`) until the operator explicitly enables
it; every gated attempt is audited.

## Enterprise

Phase 5 adds the two enterprise primitives (ADR 0012 "Multi-issuer / per-Workspace IdP";
migration 0007): an **audit log** and **per-workspace SSO**.

**Audit log** — security-relevant events land in an append-only `audit_log` table, written
fire-and-forget (a failed insert is a loud warning, never a failed request): web + CLI logins,
agent tokens minted, share links created, document creation, invites created/claimed/revoked,
member role changes/removals, workspace renames, storage connections + document attachments,
suggestion accepts/rejects and comment resolves (REST and MCP — agent actors are flagged by the
actor's `kind`), SSO config changes, SSO-driven memberships, and every gated MCP action
(allowed or denied). Admins read it via
`GET /api/workspaces/{id}/audit?limit=50&before_id=` (newest-first, paged like history) or the
**Audit** section of the workspace settings panel.

**Per-workspace SSO** — beyond the env-configured primary `OIDC_ISSUER`, each workspace can
bring its own IdP:

```sh
curl -b "$COOKIES" -X PUT localhost:8787/api/workspaces/$WS/sso \
  -H 'content-type: application/json' \
  -d '{"issuer":"http://localhost:5558/dex","client_id":"muesli",
       "client_secret":"muesli-dev-secret","email_domains":["corpdomain.example"]}'
```

The issuer is probed (OIDC discovery) before anything is stored — a typo'd issuer fails the PUT
with 502, never a later login. Sign-in then has two doors: `GET /auth/login` (primary, as
before) and `GET /auth/login/select?email=you@corp.example`, which maps the email domain to the
workspace that claims it and runs the code+PKCE dance against *that* issuer (the login state
records the issuer, so the callback validates against the right client; the web app's
"Use organization SSO" button is this flow, with a toast on unknown domains). A user who signs
in through workspace W's IdP is **automatically a member of W** (role `member`) — that is the
point of bringing your own IdP — and still gets a personal workspace. Users are keyed by
(issuer, subject), so identities never collide across issuers; `muesli login` (CLI device-code
flow) also picks its verifying issuer by the token's `iss` claim. `DELETE
/api/workspaces/{id}/sso` removes the IdP.

**Plaintext-secret caveat (prototype):** the SSO `client_secret` is stored as plaintext jsonb in
`workspaces.sso` — the same posture as the per-user Google Drive refresh tokens — and is
redacted from every API response (`has_client_secret: true`). Encrypt at rest before offering
this to real enterprise tenants.

Dev second issuer: `docker compose up -d dex2` (issuer `http://localhost:5558/dex`, login
`corp@corpdomain.example` / `password`). The whole feature is driven end to end by:

```sh
node apps/web/scripts/enterprise-e2e.mjs   # audit + multi-issuer SSO (starts its own server)
```

## License

Muesli is free software licensed under the [GNU AGPL v3.0](LICENSE): use it,
self-host it, and modify it freely — if you offer a modified Muesli to others
over a network, you must share your changes under the same license.

Contributions require signing the [Contributor License Agreement](CLA.md)
(a bot walks you through it on your first PR). The CLA lets the project also
offer commercial licenses to organizations that can't adopt the AGPL — that's
what funds full-time development. For commercial licensing, contact
[info@muesli.md](mailto:info@muesli.md).
