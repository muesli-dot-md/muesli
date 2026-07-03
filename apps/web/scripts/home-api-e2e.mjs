// Home-screen data layer e2e: drives the EXACT functions the rebuilt Drive-style
// home uses (src/workspaceApi.ts folders/trash/rename/move/text/share additions,
// imported directly — node 22 strips types) against a live muesli-server.
//
// Starts its OWN server on :8791 with its OWN database (e2e convention: 8790+ so
// the dev server on :8787 is never disturbed; the dev server shares the compose
// postgres, so a private DB keeps its poll loop away from this run's documents).
// Auth is a delegated agent token (dex password grant → /api/cli/login), same as
// folders-e2e.mjs — no browser redirect, no extra dex redirectURI.
//
//   1. createFolder root + nested; duplicate sibling → 409; bad name → 400
//   2. doc over ws → updateDocument title + folder_id; listDocuments returns the
//      folders array and the doc's folder_id/title; title:null clears to slug
//   3. updateFolder rename + move; cycle → 409
//   4. getDocumentText returns the live markdown; createShareLink mints ?share=
//   5. trashDocument → out of the default listing, in trashed=true; restoreDocument
//   6. trashFolder cascades over the subtree; restoreFolder undoes it
//   7. purgeDocument → gone from live AND trash listings
// Usage: node home-api-e2e.mjs   (run `cargo build --workspace` first; dex +
// postgres + redis from docker-compose must be up)
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";
import { createWorkspaceApi, WorkspaceApiError } from "../src/workspaceApi.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const SERVER_BIN = join(repoRoot, "target", "debug", "muesli-server");
const SERVER = "http://localhost:8791";
const WS_URL = "ws://localhost:8791/ws";
const DEX = "http://localhost:5556/dex";
const run = Date.now();
const slug = `home-api-e2e-${run}`;

let serverProc = null;
let provider = null;
const cleanup = () => {
  provider?.destroy();
  if (serverProc && serverProc.exitCode === null) serverProc.kill("SIGKILL");
};
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  cleanup();
  process.exit(1);
};
const ok = (msg) => console.log(`OK: ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => fail("global timeout"), 120_000).unref();

// --- prerequisites: port free, private database ------------------------------------
try {
  await fetch(`${SERVER}/healthz`);
  fail("something is already listening on :8791 — stop it first");
} catch {}
const TEST_DB = "muesli_home_api_e2e";
try {
  execFileSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-U", "muesli", "-d", "muesli", "-v", "ON_ERROR_STOP=1", "-c", `create database ${TEST_DB}`],
    { cwd: repoRoot, stdio: "pipe" },
  );
} catch (e) {
  if (!`${e.stderr}`.includes("already exists")) fail(`creating ${TEST_DB} failed: ${e.stderr}`);
}
ok(`port 8791 free, test database ${TEST_DB} ready`);

// --- server (OIDC mode, no storage backend — storage paths are folders-e2e's job) ---
serverProc = spawn(SERVER_BIN, [], {
  env: {
    ...process.env,
    DATABASE_URL: `postgres://muesli:muesli@localhost:5433/${TEST_DB}`,
    REDIS_URL: "redis://localhost:6380",
    OIDC_ISSUER: DEX,
    OIDC_CLIENT_ID: "muesli",
    OIDC_CLIENT_SECRET: "muesli-dev-secret",
    MUESLI_PUBLIC_URL: SERVER,
    MUESLI_WEB_ORIGIN: "http://localhost:5173",
    MUESLI_LISTEN: "127.0.0.1:8791",
    RUST_LOG: "muesli_server=info",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
{
  let stderrTail = "";
  serverProc.stderr.on("data", (c) => (stderrTail = (stderrTail + c.toString()).slice(-4000)));
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await sleep(100);
    if (serverProc.exitCode !== null) fail(`server exited ${serverProc.exitCode}: ${stderrTail}`);
    try {
      up = (await fetch(`${SERVER}/healthz`)).ok;
    } catch {}
  }
  if (!up) fail(`server did not come up: ${stderrTail}`);
}
ok("server up on :8791 (OIDC mode)");

// --- delegated agent token (dex password grant → /api/cli/login) ---------------------
let token;
{
  const res = await fetch(`${DEX}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "muesli-cli",
      scope: "openid email profile",
      username: "dev@muesli.md",
      password: "password",
    }),
  });
  const body = await res.json();
  if (!body.id_token) fail(`dex password grant returned no id_token: ${JSON.stringify(body)}`);
  const login = await fetch(`${SERVER}/api/cli/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id_token: body.id_token, label: "home-api-e2e" }),
  });
  if (!login.ok) fail(`/api/cli/login → ${login.status} ${await login.text()}`);
  ({ token } = await login.json());
  if (!token?.startsWith("mua_")) fail(`expected a mua_ token, got ${token}`);
  ok("minted delegated agent token");
}

// The EXACT api object Home.svelte builds, with a Bearer-injecting fetch.
const api = createWorkspaceApi({
  httpBase: SERVER,
  fetchFn: (input, init = {}) =>
    fetch(input, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
    }),
});

async function expectStatus(promise, status, label) {
  try {
    await promise;
  } catch (e) {
    if (!(e instanceof WorkspaceApiError) || e.status !== status) {
      fail(`${label}: expected ${status}, got ${e instanceof WorkspaceApiError ? e.status : e}`);
    }
    ok(`${label} → ${status}`);
    return;
  }
  fail(`${label}: expected ${status}, got success`);
}

// --- 1. folders: create + nest, duplicate → 409, bad name → 400 -----------------------
const nameA = `home-a-${run}`;
const nameB = `home-b-${run}`;
const folderA = await api.createFolder(nameA);
if (folderA.parent_id !== null) fail(`folder A should be root: ${JSON.stringify(folderA)}`);
const folderB = await api.createFolder(nameB, folderA.id);
if (folderB.parent_id !== folderA.id) fail(`folder B parent wrong: ${JSON.stringify(folderB)}`);
await expectStatus(api.createFolder(nameB.toUpperCase(), folderA.id), 409, "duplicate sibling");
await expectStatus(api.createFolder("a/b"), 400, "slash in folder name");
ok("createFolder: root + nested");

// --- 2. a doc over ws, then rename + move via updateDocument --------------------------
{
  class BearerWS extends WebSocket {
    constructor(url, protocols) {
      super(url, protocols, { headers: { authorization: `Bearer ${token}` } });
    }
  }
  const ydoc = new Y.Doc();
  provider = new WebsocketProvider(WS_URL, slug, ydoc, {
    WebSocketPolyfill: BearerWS,
    disableBc: true, // same-process clients must not bypass the server over BroadcastChannel
  });
  await new Promise((resolve) => provider.on("sync", (s) => s && resolve()));
  ydoc.getText("content").insert(0, `# Home E2E\n\nhello from the home screen e2e.\n`);
  await sleep(800);
}
const TITLE = `Home E2E ${run}`;
{
  const r = await api.updateDocument(slug, { title: TITLE, folder_id: folderB.id });
  if (r.title !== TITLE || r.folder_id !== folderB.id) {
    fail(`updateDocument echo wrong: ${JSON.stringify(r)}`);
  }
  const list = await api.listDocuments();
  const d = list.documents.find((d) => d.slug === slug);
  if (!d) fail("doc missing from listing");
  if (d.title !== TITLE || d.folder_id !== folderB.id) {
    fail(`listing should carry title + folder_id: ${JSON.stringify(d)}`);
  }
  const fs = list.folders ?? [];
  if (!fs.some((f) => f.id === folderA.id) || !fs.some((f) => f.id === folderB.id)) {
    fail(`listing should include both folders: ${JSON.stringify(fs)}`);
  }
  // title: null clears back to the slug fallback
  const cleared = await api.updateDocument(slug, { title: null });
  if (cleared.title !== null) fail(`clearing title should echo null: ${JSON.stringify(cleared)}`);
  await api.updateDocument(slug, { title: TITLE });
  ok("updateDocument: title + folder placement (and title clear) reflected in listing");
}

// --- 3. updateFolder: rename + move; cycle → 409 ---------------------------------------
{
  const renamed = await api.updateFolder(folderB.id, { name: `${nameB}-renamed` });
  if (renamed.name !== `${nameB}-renamed`) fail(`rename echo wrong: ${JSON.stringify(renamed)}`);
  await expectStatus(api.updateFolder(folderA.id, { parent_id: folderB.id }), 409, "cycle move");
  const moved = await api.updateFolder(folderB.id, { parent_id: null });
  if (moved.parent_id !== null) fail(`move-to-root echo wrong: ${JSON.stringify(moved)}`);
  const back = await api.updateFolder(folderB.id, { parent_id: folderA.id });
  if (back.parent_id !== folderA.id) fail(`move-back echo wrong: ${JSON.stringify(back)}`);
  ok("updateFolder: rename, move to root + back, cycle → 409");
}

// --- 4. getDocumentText + createShareLink ----------------------------------------------
{
  const { text } = await api.getDocumentText(slug);
  if (!text.includes("hello from the home screen e2e")) {
    fail(`getDocumentText returned wrong content: ${JSON.stringify(text)}`);
  }
  const link = await api.createShareLink(slug, "viewer");
  if (!link.url?.includes("share=")) fail(`share link looks wrong: ${JSON.stringify(link)}`);
  ok("getDocumentText + createShareLink");
}

// --- 5. document trash → trashed listing → restore --------------------------------------
{
  // close the live connection first: trash gates NEW connections, and a lingering
  // provider would just keep editing a trashed doc
  provider.destroy();
  provider = null;
  await sleep(300);
  const r = await api.trashDocument(slug);
  if (r.trashed !== true) fail(`trashDocument echo wrong: ${JSON.stringify(r)}`);
  if ((await api.listDocuments()).documents.some((d) => d.slug === slug)) {
    fail("trashed doc still in the default listing");
  }
  const trash = await api.listDocuments(undefined, { trashed: true });
  const td = trash.documents.find((d) => d.slug === slug);
  if (!td || !td.deleted_at) fail(`trashed listing wrong: ${JSON.stringify(trash.documents)}`);
  const restored = await api.restoreDocument(slug);
  if (restored.restored !== true) fail(`restore echo wrong: ${JSON.stringify(restored)}`);
  const d = (await api.listDocuments()).documents.find((d) => d.slug === slug);
  if (!d || d.folder_id !== folderB.id) {
    fail(`restored doc should be back in its folder: ${JSON.stringify(d)}`);
  }
  ok("document trash → trashed=true listing → restore (placement kept)");
}

// --- 6. folder subtree trash + restore ---------------------------------------------------
{
  const r = await api.trashFolder(folderA.id);
  if (r.folders !== 2 || r.documents !== 1) {
    fail(`trashFolder should cascade (2 folders, 1 doc): ${JSON.stringify(r)}`);
  }
  const live = await api.listDocuments();
  if ((live.folders ?? []).some((f) => f.id === folderA.id || f.id === folderB.id)) {
    fail("trashed folders still in the live listing");
  }
  if (live.documents.some((d) => d.slug === slug)) fail("cascade-trashed doc still live");
  const rr = await api.restoreFolder(folderA.id);
  if (rr.folders !== 2 || rr.documents !== 1) {
    fail(`restoreFolder counts wrong: ${JSON.stringify(rr)}`);
  }
  const after = await api.listDocuments();
  if (!(after.folders ?? []).some((f) => f.id === folderB.id)) fail("folder B not restored");
  if (!after.documents.some((d) => d.slug === slug)) fail("doc not restored with subtree");
  ok("folder trash cascades over the subtree; restore undoes it");
}

// --- 7. purge: gone from live AND trash ---------------------------------------------------
{
  const r = await api.purgeDocument(slug);
  if (r.purged !== true) fail(`purge echo wrong: ${JSON.stringify(r)}`);
  if ((await api.listDocuments()).documents.some((d) => d.slug === slug)) {
    fail("purged doc still in live listing");
  }
  const trash = await api.listDocuments(undefined, { trashed: true });
  if (trash.documents.some((d) => d.slug === slug)) fail("purged doc still in trash listing");
  ok("purgeDocument: gone from live and trash");
}

console.log("\nALL OK — home-screen workspaceApi additions verified end-to-end");
cleanup();
process.exit(0);
