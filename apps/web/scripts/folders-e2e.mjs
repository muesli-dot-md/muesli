// Folders + trash + rename e2e (migration 0008). Starts its OWN muesli-server on :8790
// (dex + postgres + redis from docker-compose must be up; minio is brought up by this
// script — convention: e2e servers live on 8790+ so the dev server on :8787 is never
// disturbed). Auth is a delegated agent token (dex password grant → /api/cli/login),
// which needs no browser redirect and therefore no extra dex redirectURI for :8790.
//
//   1.  create folder → nested folder; duplicate sibling name → 409; bad name → 400
//   2.  create a doc over ws → PATCH title + move into the nested folder → the listing
//       shows folder_id, the stored title, and a folders array (the tree)
//   3.  moving a folder under its own descendant → 409 (cycle)
//   4.  storage (MinIO): attach defaults rel_path to <folder chain>/<slug>.md; moving
//       the doc and renaming an ancestor folder relocate the object (old path deleted)
//   5.  attaching with an explicit nested rel_path auto-creates the folder chain;
//       poll-ingest re-places a chainless doc into its rel_path folder chain
//   6.  trash: DELETE doc → gone from listing + graph, ws connect → 410, backend file
//       stays; trashed=true lists it; restore brings everything back
//   7.  folder trash cascades over the subtree (folders + docs); restore undoes it
//   8.  purge: hard delete (with a comment attached) → gone from live AND trash lists
// Usage: node folders-e2e.mjs   (run `cargo build --workspace` first)
import { spawn, execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const SERVER_BIN = join(repoRoot, "target", "debug", "muesli-server");
const SERVER = "http://localhost:8790";
const WS_URL = "ws://localhost:8790/ws";
const DEX = "http://localhost:5556/dex";
const run = Date.now();
const slug = `folders-e2e-${run}`;
const slug2 = `folders-e2e-auto-${run}`;
const POLL_SECS = 2;

const S3 = {
  endpoint: "http://localhost:9000",
  bucket: "muesli-dev",
  region: "us-east-1",
  access: "muesli",
  secret: "muesli-dev-secret",
};

let serverProc = null;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  if (serverProc) serverProc.kill("SIGKILL");
  process.exit(1);
};
const ok = (msg) => console.log(`OK: ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => fail("global timeout"), 180_000).unref();

// --- prerequisites: minio up, port free -------------------------------------------
try {
  execFileSync("docker", ["compose", "up", "-d", "--wait", "minio"], {
    cwd: repoRoot,
    stdio: "pipe",
  });
  execFileSync("docker", ["compose", "up", "-d", "minio-init"], { cwd: repoRoot, stdio: "pipe" });
} catch (e) {
  fail(`docker compose up minio failed: ${e.message}`);
}
try {
  await fetch(`${SERVER}/healthz`);
  fail("something is already listening on :8790 — stop it first");
} catch {}
ok("minio is up, port 8790 is free");

// Own database: the dev server on :8787 shares the compose postgres and its poll loop
// must never ingest/materialize THIS run's documents (two processes ingesting the same
// doc would race the update log). Migrations run on connect.
const TEST_DB = "muesli_folders_e2e";
function psql(db, sql) {
  return execFileSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "muesli",
      "-d",
      db,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    { cwd: repoRoot, stdio: "pipe" },
  );
}
try {
  psql("muesli", `create database ${TEST_DB}`);
} catch (e) {
  if (!`${e.stderr}`.includes("already exists")) fail(`creating ${TEST_DB} failed: ${e.stderr}`);
}
ok(`test database ${TEST_DB} ready`);

// --- raw SigV4 (node crypto) for asserting backend objects out-of-band -------------
async function s3Request(method, key, body = null) {
  const datetime = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = datetime.slice(0, 8);
  const payloadHash = createHash("sha256")
    .update(body ?? "")
    .digest("hex");
  const host = new URL(S3.endpoint).host;
  const uri = `/${S3.bucket}/${key}`; // keys here are [A-Za-z0-9./-] — no encoding needed
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${datetime}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const creq = `${method}\n${uri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${day}/${S3.region}/s3/aws4_request`;
  const sts = `AWS4-HMAC-SHA256\n${datetime}\n${scope}\n${createHash("sha256").update(creq).digest("hex")}`;
  let k = createHmac("sha256", `AWS4${S3.secret}`).update(day).digest();
  for (const part of [S3.region, "s3", "aws4_request"]) {
    k = createHmac("sha256", k).update(part).digest();
  }
  const signature = createHmac("sha256", k).update(sts).digest("hex");
  return fetch(`${S3.endpoint}${uri}`, {
    method,
    headers: {
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": datetime,
      authorization: `AWS4-HMAC-SHA256 Credential=${S3.access}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: body ?? undefined,
  });
}

// --- server lifecycle ----------------------------------------------------------------
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
    MUESLI_LISTEN: "127.0.0.1:8790",
    MUESLI_S3_ACCESS_KEY: S3.access,
    MUESLI_S3_SECRET_KEY: S3.secret,
    MUESLI_S3_POLL_SECS: String(POLL_SECS),
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
ok(`server up on :8790 (OIDC mode, S3 creds set, poll every ${POLL_SECS}s)`);

// --- a delegated agent token (dex password grant → /api/cli/login) ---------------------
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
    body: JSON.stringify({ id_token: body.id_token, label: "folders-e2e" }),
  });
  if (!login.ok) fail(`/api/cli/login → ${login.status} ${await login.text()}`);
  ({ token } = await login.json());
  if (!token?.startsWith("mua_")) fail(`expected a mua_ token, got ${token}`);
  ok("minted delegated agent token");
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

let personalWs;
{
  const r = await api("/api/workspaces");
  if (r.status !== 200) fail(`GET /api/workspaces → ${r.status} ${r.text}`);
  personalWs = r.json.workspaces.find((w) => w.is_personal)?.id;
  if (!personalWs) fail(`no personal workspace: ${r.text}`);
}

// --- 1. folders: create, nest, 409 on duplicate sibling, 400 on bad name ---------------
const nameA = `proj-${run}`;
const nameB = `sub-${run}`;
let folderA, folderB;
{
  let r = await api("/api/folders", { method: "POST", body: { name: nameA } });
  if (r.status !== 200) fail(`create folder A → ${r.status} ${r.text}`);
  if (r.json.workspace_id !== personalWs)
    fail(`folder A should default to the personal workspace: ${r.text}`);
  if (r.json.parent_id !== null) fail(`folder A should be a root folder: ${r.text}`);
  folderA = r.json.id;

  r = await api("/api/folders", { method: "POST", body: { name: nameB, parent_id: folderA } });
  if (r.status !== 200) fail(`create folder B → ${r.status} ${r.text}`);
  if (r.json.parent_id !== folderA) fail(`folder B parent wrong: ${r.text}`);
  folderB = r.json.id;

  // sibling-name uniqueness is case-insensitive among LIVE folders
  r = await api("/api/folders", {
    method: "POST",
    body: { name: nameB.toUpperCase(), parent_id: folderA },
  });
  if (r.status !== 409) fail(`duplicate sibling name should be 409, got ${r.status} ${r.text}`);

  r = await api("/api/folders", { method: "POST", body: { name: "a/b" } });
  if (r.status !== 400) fail(`slash in folder name should be 400, got ${r.status} ${r.text}`);
  ok("folders: create + nest, duplicate sibling → 409, '/' in name → 400");
}

// --- 2. a doc over ws, then rename (title) + move into the nested folder ----------------
function connect(roomSlug) {
  class BearerWS extends WebSocket {
    constructor(url, protocols) {
      super(url, protocols, { headers: { authorization: `Bearer ${token}` } });
    }
  }
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(WS_URL, roomSlug, doc, {
    WebSocketPolyfill: BearerWS,
    disableBc: true, // same-process clients must not bypass the server over BroadcastChannel
  });
  const synced = new Promise((resolve) => provider.on("sync", (s) => s && resolve()));
  return { doc, provider, text: doc.getText("content"), synced };
}

const client = connect(slug);
await client.synced;
const BASE_TEXT = `# Folders E2E\n\nhello folders. [[${slug2}]]\n`;
client.text.insert(0, BASE_TEXT);
await sleep(600);
{
  const r = await api("/api/documents");
  const d = r.json.documents.find((d) => d.slug === slug);
  if (!d) fail("doc missing from listing");
  if (d.folder_id !== null) fail(`fresh doc should be at the root: ${JSON.stringify(d)}`);
  if (d.title !== slug) fail(`unset title should fall back to the slug: ${JSON.stringify(d)}`);
  if (d.deleted_at !== null) fail(`fresh doc should not be trashed: ${JSON.stringify(d)}`);
  if (!Array.isArray(r.json.folders)) fail("listing has no folders array");
  ok("doc created at the root; listing has documents + folders arrays");
}
{
  const r = await api(`/api/documents/${slug}`, {
    method: "PATCH",
    body: { title: "My Fancy Title", folder_id: folderB },
  });
  if (r.status !== 200) fail(`PATCH document → ${r.status} ${r.text}`);
  if (r.json.title !== "My Fancy Title" || r.json.folder_id !== folderB)
    fail(`PATCH response wrong: ${r.text}`);
  const list = await api("/api/documents");
  const d = list.json.documents.find((d) => d.slug === slug);
  if (d.title !== "My Fancy Title") fail(`stored title missing from listing: ${JSON.stringify(d)}`);
  if (d.folder_id !== folderB) fail(`folder move missing from listing: ${JSON.stringify(d)}`);
  const fA = list.json.folders.find((f) => f.id === folderA);
  const fB = list.json.folders.find((f) => f.id === folderB);
  if (!fA || !fB || fB.parent_id !== folderA) fail("folder tree wrong in listing");
  ok("rename (display title) + move into nested folder; tree shows in the listing");
}

// --- 3. cycle rejection -------------------------------------------------------------------
{
  const r = await api(`/api/folders/${folderA}`, { method: "PATCH", body: { parent_id: folderB } });
  if (r.status !== 409) fail(`cycle move should be 409, got ${r.status} ${r.text}`);
  ok("moving a folder under its own descendant → 409");
}

// --- 4. storage: attach inherits the folder chain; moves/renames relocate the object -------
let connId;
{
  const r = await api(`/api/workspaces/${personalWs}/storage`, {
    method: "POST",
    body: { kind: "s3", endpoint: S3.endpoint, bucket: S3.bucket },
  });
  if (r.status !== 200) fail(`create storage connection → ${r.status} ${r.text}`);
  connId = r.json.storage_conn_id;
}
const relNested = `${nameA}/${nameB}/${slug}.md`;
{
  const r = await api(`/api/documents/${slug}/storage`, {
    method: "POST",
    body: { storage_conn_id: connId },
  });
  if (r.status !== 200) fail(`attach → ${r.status} ${r.text}`);
  if (r.json.rel_path !== relNested)
    fail(`default rel_path should mirror the folder chain (${relNested}), got ${r.text}`);
  const obj = await s3Request("GET", relNested);
  if (!obj.ok) fail(`object missing at the nested path: ${obj.status}`);
  if ((await obj.text()) !== client.text.toString()) fail("materialized object differs");
  ok(`attach materialized at the folder-chain path ${relNested}`);
}
{
  // move to the root → object moves to <slug>.md, the nested object is deleted
  const r = await api(`/api/documents/${slug}`, { method: "PATCH", body: { folder_id: null } });
  if (r.status !== 200) fail(`move to root → ${r.status} ${r.text}`);
  const rootObj = await s3Request("GET", `${slug}.md`);
  if (!rootObj.ok) fail(`object missing at root path after move: ${rootObj.status}`);
  const oldObj = await s3Request("GET", relNested);
  if (oldObj.status !== 404) fail(`old nested object should be deleted, got ${oldObj.status}`);
  ok("doc move to root relocated the object (old path deleted)");
}
{
  // move back, then rename the ANCESTOR folder → the whole subtree relocates
  let r = await api(`/api/documents/${slug}`, { method: "PATCH", body: { folder_id: folderB } });
  if (r.status !== 200) fail(`move back → ${r.status} ${r.text}`);
  if (!(await s3Request("GET", relNested)).ok) fail("object did not move back to the nested path");

  const renamed = `proj2-${run}`;
  r = await api(`/api/folders/${folderA}`, { method: "PATCH", body: { name: renamed } });
  if (r.status !== 200) fail(`rename folder → ${r.status} ${r.text}`);
  if (r.json.name !== renamed) fail(`rename response wrong: ${r.text}`);
  const newPath = `${renamed}/${nameB}/${slug}.md`;
  if (!(await s3Request("GET", newPath)).ok) fail(`object missing at ${newPath} after rename`);
  if ((await s3Request("GET", relNested)).status !== 404)
    fail("old object survived the folder rename");
  // later assertions use the renamed chain
  ok(`ancestor folder rename relocated the subtree object to ${newPath}`);
}
const nameA2 = `proj2-${run}`;
const docPath = `${nameA2}/${nameB}/${slug}.md`;

// --- 5. explicit nested rel_path auto-creates the folder chain; poll re-places ------------
const client2 = connect(slug2);
await client2.synced;
client2.text.insert(0, `# Auto Chain\n\nsecond doc.\n`);
await sleep(600);
const rel2 = `auto-${run}/chain-${run}/${slug2}.md`;
let chainLeaf;
{
  const r = await api(`/api/documents/${slug2}/storage`, {
    method: "POST",
    body: { storage_conn_id: connId, rel_path: rel2 },
  });
  if (r.status !== 200) fail(`attach with nested rel_path → ${r.status} ${r.text}`);
  const list = await api("/api/documents");
  const auto = list.json.folders.find((f) => f.name === `auto-${run}` && f.parent_id === null);
  const chain = list.json.folders.find(
    (f) => f.name === `chain-${run}` && f.parent_id === auto?.id,
  );
  if (!auto || !chain)
    fail(`folder chain was not auto-created: ${JSON.stringify(list.json.folders)}`);
  const d = list.json.documents.find((d) => d.slug === slug2);
  if (d.folder_id !== chain.id) fail(`doc2 not placed into the chain leaf: ${JSON.stringify(d)}`);
  chainLeaf = chain.id;
  ok("explicit nested rel_path auto-created the folder chain and placed the doc");
}
{
  // simulate a pre-folders attachment: chainless doc with a nested rel_path; an
  // out-of-band change must re-place it via poll-ingest
  psql(TEST_DB, `update documents set folder_id = null where slug = '${slug2}';`);
  const put = await s3Request("PUT", rel2, "# Auto Chain\n\nsecond doc, EDITED-OUT-OF-BAND.\n");
  if (!put.ok) fail(`out-of-band PUT failed: ${put.status}`);
  let placed = false;
  for (let i = 0; i < 30 && !placed; i++) {
    await sleep(500);
    const d = (await api("/api/documents")).json.documents.find((d) => d.slug === slug2);
    placed = d?.folder_id === chainLeaf;
  }
  if (!placed) fail("poll-ingest did not re-place the doc into its rel_path folder chain");
  if (!client2.text.toString().includes("EDITED-OUT-OF-BAND"))
    fail("out-of-band change was not ingested into the live room");
  ok("poll-ingest auto-created/used the folder chain for a nested path");
}

// --- 6. document trash → hidden everywhere, ws refused, file stays; restore ---------------
function wsHandshakeStatus(roomSlug) {
  return new Promise((resolve) => {
    const sock = new WebSocket(`${WS_URL}/${roomSlug}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    sock.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode);
      sock.terminate();
    });
    sock.on("open", () => {
      resolve(101);
      sock.terminate();
    });
    sock.on("error", () => {}); // unexpected-response already resolves
  });
}
{
  let g = await api("/api/graph");
  if (!g.json.nodes.some((n) => n.slug === slug)) fail("doc missing from graph before trash");

  const del = await api(`/api/documents/${slug}`, { method: "DELETE" });
  if (del.status !== 200 || del.json.trashed !== true) fail(`trash → ${del.status} ${del.text}`);

  const live = await api("/api/documents");
  if (live.json.documents.some((d) => d.slug === slug)) fail("trashed doc still in the live list");
  const trash = await api("/api/documents?trashed=true");
  const td = trash.json.documents.find((d) => d.slug === slug);
  if (!td) fail("trashed doc missing from ?trashed=true");
  if (!td.deleted_at) fail(`trashed doc has no deleted_at: ${JSON.stringify(td)}`);

  g = await api("/api/graph");
  if (g.json.nodes.some((n) => n.slug === slug)) fail("trashed doc still in the graph");

  const status = await wsHandshakeStatus(slug);
  if (status !== 410) fail(`ws connect to a trashed doc should be 410, got ${status}`);

  const obj = await s3Request("GET", docPath);
  if (!obj.ok) fail(`backend file should stay in place on trash, got ${obj.status}`);
  ok("trash: hidden from listing+graph, ws → 410, backend file left in place");
}
{
  const r = await api(`/api/documents/${slug}/restore`, { method: "POST" });
  if (r.status !== 200 || r.json.restored !== true) fail(`restore → ${r.status} ${r.text}`);
  if (r.json.folder_id !== folderB) fail(`restore should keep the folder: ${r.text}`);
  const live = await api("/api/documents");
  if (!live.json.documents.some((d) => d.slug === slug)) fail("restored doc missing from listing");
  const status = await wsHandshakeStatus(slug);
  if (status !== 101) fail(`ws connect to a restored doc should succeed, got ${status}`);
  ok("restore: listed again, ws connects, folder kept");
}

// --- 7. folder trash cascades over the subtree; restore undoes it --------------------------
{
  const del = await api(`/api/folders/${folderA}`, { method: "DELETE" });
  if (del.status !== 200) fail(`trash folder → ${del.status} ${del.text}`);
  if (del.json.folders !== 2 || del.json.documents !== 1)
    fail(`expected 2 folders + 1 document trashed, got ${del.text}`);
  const live = await api("/api/documents");
  if (live.json.documents.some((d) => d.slug === slug)) fail("subtree doc still live");
  if (live.json.folders.some((f) => f.id === folderA || f.id === folderB))
    fail("trashed folders still in the live tree");
  const trash = await api("/api/documents?trashed=true");
  if (!trash.json.folders.some((f) => f.id === folderB)) fail("subfolder missing from the trash");
  if (!trash.json.documents.some((d) => d.slug === slug))
    fail("subtree doc missing from the trash");
  if ((await wsHandshakeStatus(slug)) !== 410) fail("subtree-trashed doc still accepts ws");

  const res = await api(`/api/folders/${folderA}/restore`, { method: "POST" });
  if (res.status !== 200) fail(`restore folder → ${res.status} ${res.text}`);
  if (res.json.folders !== 2 || res.json.documents !== 1)
    fail(`expected 2 folders + 1 document restored, got ${res.text}`);
  const after = await api("/api/documents");
  const d = after.json.documents.find((d) => d.slug === slug);
  if (!d || d.folder_id !== folderB) fail("subtree restore lost the document placement");
  ok("folder trash cascades over the subtree; restore brings folders + doc back");
}

// --- 8. purge: hard delete with child rows present ------------------------------------------
{
  // give the purge real child rows to delete: a comment thread on live text
  const c = await api(`/api/documents/${slug}/comments`, {
    method: "POST",
    body: { anchor_start: 2, anchor_end: 9, body: "purge me with the doc" },
  });
  if (c.status !== 200) fail(`create comment → ${c.status} ${c.text}`);

  const del = await api(`/api/documents/${slug}/purge`, { method: "DELETE" });
  if (del.status !== 200 || del.json.purged !== true) fail(`purge → ${del.status} ${del.text}`);
  const live = await api("/api/documents");
  if (live.json.documents.some((d) => d.slug === slug)) fail("purged doc still in the live list");
  const trash = await api("/api/documents?trashed=true");
  if (trash.json.documents.some((d) => d.slug === slug)) fail("purged doc still in the trash list");
  ok("purge removed the document (and its comment thread) for good");
}

console.log("ALL FOLDERS + TRASH + RENAME CHECKS PASSED");
client.provider.destroy();
client2.provider.destroy();
serverProc.kill("SIGKILL");
process.exit(0);
