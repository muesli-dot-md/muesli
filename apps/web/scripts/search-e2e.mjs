// Server-side search + ownership e2e (migration 0009). Starts its OWN muesli-server on
// :8791 (dex + postgres + redis from docker-compose must be up; minio is brought up by
// this script — convention: e2e servers live on 8790+ so the dev server on :8787 is
// never disturbed) with its OWN scratch database, and the server's cwd OUTSIDE the repo
// so dotenvy never picks up the repo .env. Auth is a delegated agent token per user
// (dex password grant → /api/cli/login) for TWO users: dev@muesli.md (A) and
// friend@muesli.md (B).
//
//   1.  A creates three docs over ws: a title-prefix match, a title-substring match, and
//       a content match (multibyte Japanese + a long unique word for the ILIKE fallback)
//   2.  GET /api/search ranking: title prefix > title substring > content FTS; fields,
//       snippets (token present, newlines stripped), owner/is_owner, native source label
//   3.  multibyte content query (日本語) and a partial-token query (ILIKE fallback)
//   4.  empty/whitespace q → {results:[]}; no auth → 401
//   5.  visibility: B finds none of A's docs; B finds their own (is_owner:true); A
//       cannot find B's
//   6.  sharing: A invites B into the personal workspace → B finds A's docs with
//       is_owner:false + owner = A, and GET /api/documents carries owner/is_owner
//       (the client-side "Shared with me" set)
//   7.  trash: a trashed doc disappears from search
//   8.  source labels: attaching a doc to MinIO flips its source to {kind:"s3",
//       label:<bucket>}; unattached stays {kind:"native", label:"Muesli Cloud"}
// Usage: node search-e2e.mjs   (run `cargo build --workspace` first)
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const SERVER_BIN = join(repoRoot, "target", "debug", "muesli-server");
const SERVER = "http://localhost:8791";
const WS_URL = "ws://localhost:8791/ws";
const DEX = "http://localhost:5556/dex";
const run = Date.now();
const zq = `zq${run}`; // the unique search token of this run
const longWord = `xylografika${run}`; // for the partial-token (ILIKE) fallback
const slugT1 = `se-a-${run}`; // title-prefix match
const slugT2 = `se-b-${run}`; // title-substring match
const slugC1 = `se-c-${run}`; // content match (multibyte)
const slugB1 = `se-bb-${run}`; // user B's own doc

const S3 = {
  endpoint: "http://localhost:9000",
  bucket: "muesli-dev",
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

// --- prerequisites: minio up, port free, scratch database --------------------------
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
  fail("something is already listening on :8791 — stop it first");
} catch {}

// Own database: the dev server on :8787 shares the compose postgres and its loops must
// never touch THIS run's documents. Migrations run on connect.
const TEST_DB = "muesli_search_e2e";
function psql(db, sql) {
  return execFileSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-U", "muesli", "-d", db, "-v", "ON_ERROR_STOP=1", "-c", sql],
    { cwd: repoRoot, stdio: "pipe" },
  );
}
// Recreated every run: the visibility checks assume B starts WITHOUT a membership in
// A's workspace, and memberships (unlike slugs) are not run-stamped.
try {
  psql("muesli", `drop database if exists ${TEST_DB} with (force)`);
  psql("muesli", `create database ${TEST_DB}`);
} catch (e) {
  fail(`recreating ${TEST_DB} failed: ${e.stderr}`);
}
ok(`minio up, port 8791 free, test database ${TEST_DB} ready`);

// --- server lifecycle (cwd OUTSIDE the repo: dotenvy walks parent dirs) -------------
serverProc = spawn(SERVER_BIN, [], {
  cwd: tmpdir(),
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
    MUESLI_S3_ACCESS_KEY: S3.access,
    MUESLI_S3_SECRET_KEY: S3.secret,
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
ok("server up on :8791 (OIDC mode, S3 creds set)");

// --- delegated agent tokens for both users (dex password grant → /api/cli/login) -----
async function mintToken(email) {
  const res = await fetch(`${DEX}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "muesli-cli",
      scope: "openid email profile",
      username: email,
      password: "password",
    }),
  });
  const body = await res.json();
  if (!body.id_token) fail(`dex password grant for ${email} returned no id_token: ${JSON.stringify(body)}`);
  const login = await fetch(`${SERVER}/api/cli/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id_token: body.id_token, label: `search-e2e-${email}` }),
  });
  if (!login.ok) fail(`/api/cli/login for ${email} → ${login.status} ${await login.text()}`);
  const { token } = await login.json();
  if (!token?.startsWith("mua_")) fail(`expected a mua_ token for ${email}, got ${token}`);
  return token;
}
const tokenA = await mintToken("dev@muesli.md");
const tokenB = await mintToken("friend@muesli.md");
ok("minted delegated agent tokens for users A and B");

function apiFor(token) {
  return async (path, { method = "GET", body } = {}) => {
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
  };
}
const apiA = apiFor(tokenA);
const apiB = apiFor(tokenB);

let wsA, userIdA, userIdB;
{
  const r = await apiA("/api/workspaces");
  if (r.status !== 200) fail(`GET /api/workspaces (A) → ${r.status} ${r.text}`);
  wsA = r.json.workspaces.find((w) => w.is_personal)?.id;
  if (!wsA) fail(`A has no personal workspace: ${r.text}`);
  const detail = await apiA(`/api/workspaces/${wsA}`);
  userIdA = detail.json.members.find((m) => m.kind === "human")?.user_id;
  if (!userIdA) fail(`no human member in A's workspace: ${detail.text}`);
  const rb = await apiB("/api/workspaces");
  const wsB = rb.json.workspaces.find((w) => w.is_personal)?.id;
  const detailB = await apiB(`/api/workspaces/${wsB}`);
  userIdB = detailB.json.members.find((m) => m.kind === "human")?.user_id;
  if (!userIdB) fail(`no human member in B's workspace: ${detailB.text}`);
}

// --- 1. documents over ws ------------------------------------------------------------
function connect(roomSlug, token) {
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

const clients = [];
async function createDoc(slug, token, content) {
  const c = connect(slug, token);
  clients.push(c);
  await c.synced;
  c.text.insert(0, content);
  return c;
}
await createDoc(slugT1, tokenA, `# Prefix Doc\n\nnothing searchable in the body here.\n`);
await createDoc(slugT2, tokenA, `# Substring Doc\n\nstill nothing searchable in the body.\n`);
const C1_TEXT =
  `# Content Doc\n\n` +
  `A long opening paragraph that pads the text out before the interesting part, ` +
  `so the snippet has to find its window rather than lead with the hit.\n\n` +
  `The magic word ${zq} appears exactly here, surrounded by prose.\n\n` +
  `これは日本語のコンテンツです。マルチバイト文字の検索を確かめる。\n\n` +
  `And one very specific long word: ${longWord} closes the document.\n`;
await createDoc(slugC1, tokenA, C1_TEXT);
await createDoc(slugB1, tokenB, `# B's Own\n\nthe private token bq${run} lives here.\n`);
await sleep(300);
{
  let r = await apiA(`/api/documents/${slugT1}`, { method: "PATCH", body: { title: `Zq${run} Guide` } });
  if (r.status !== 200) fail(`PATCH title t1 → ${r.status} ${r.text}`);
  r = await apiA(`/api/documents/${slugT2}`, {
    method: "PATCH",
    body: { title: `Notes about ${zq} things` },
  });
  if (r.status !== 200) fail(`PATCH title t2 → ${r.status} ${r.text}`);
  ok("A created 3 docs (+ B created 1); titles set for prefix/substring matches");
}

// --- 2. ranking, fields, snippets, owner, native source -------------------------------
// The content projection rides the link indexer's ~2s debounce: poll until all 3 land.
let results;
{
  for (let i = 0; i < 40; i++) {
    const r = await apiA(`/api/search?q=${zq}`);
    if (r.status !== 200) fail(`GET /api/search → ${r.status} ${r.text}`);
    results = r.json.results;
    if (results.length === 3) break;
    await sleep(500);
  }
  if (results.length !== 3) fail(`expected 3 results for ${zq}, got ${JSON.stringify(results)}`);
  const [r0, r1, r2] = results;
  if (r0.slug !== slugT1) fail(`title-prefix match should rank first: ${JSON.stringify(results)}`);
  if (r1.slug !== slugT2) fail(`title-substring match should rank second: ${JSON.stringify(results)}`);
  if (r2.slug !== slugC1) fail(`content match should rank third: ${JSON.stringify(results)}`);
  if (r0.match.field !== "title" || r1.match.field !== "title" || r2.match.field !== "content")
    fail(`match fields wrong: ${JSON.stringify(results.map((r) => r.match))}`);
  if (r0.match.snippet !== `Zq${run} Guide`) fail(`title snippet should be the title: ${r0.match.snippet}`);
  if (!r2.match.snippet.includes(zq)) fail(`content snippet misses the token: ${r2.match.snippet}`);
  if (/[\n\r\t]/.test(r2.match.snippet)) fail(`snippet contains raw newlines: ${JSON.stringify(r2.match.snippet)}`);
  if (r2.match.snippet.length > 400) fail(`snippet suspiciously long: ${r2.match.snippet.length}`);
  if (r0.title !== `Zq${run} Guide`) fail(`stored title missing: ${JSON.stringify(r0)}`);
  if (r2.title !== slugC1) fail(`unset title should fall back to the slug: ${JSON.stringify(r2)}`);
  for (const r of results) {
    if (r.is_owner !== true) fail(`A owns these docs, is_owner should be true: ${JSON.stringify(r)}`);
    if (r.owner?.id !== userIdA) fail(`owner should be A (${userIdA}): ${JSON.stringify(r.owner)}`);
    if (r.source.kind !== "native" || r.source.label !== "Muesli Cloud")
      fail(`unattached docs are native/Muesli Cloud: ${JSON.stringify(r.source)}`);
    if (r.workspace_id !== wsA) fail(`workspace_id wrong: ${JSON.stringify(r)}`);
    if (!r.document_id || !r.updated_at || r.folder_id !== null) fail(`row shape wrong: ${JSON.stringify(r)}`);
  }
  ok("ranking title-prefix > title-substring > content; fields, snippets, owner, native source");
}

// --- 3. multibyte content query + partial-token ILIKE fallback ------------------------
{
  const jp = await apiA(`/api/search?q=${encodeURIComponent("日本語のコンテンツ")}`);
  const hit = jp.json.results.find((r) => r.slug === slugC1);
  if (!hit) fail(`multibyte query found nothing: ${jp.text}`);
  if (hit.match.field !== "content" || !hit.match.snippet.includes("日本語のコンテンツ"))
    fail(`multibyte snippet wrong: ${JSON.stringify(hit.match)}`);

  // "lografika…" is a mid-word substring: FTS can't match it, ILIKE must.
  const part = await apiA(`/api/search?q=${longWord.slice(2)}`);
  const phit = part.json.results.find((r) => r.slug === slugC1);
  if (!phit) fail(`partial-token query found nothing: ${part.text}`);
  if (phit.match.field !== "content" || !phit.match.snippet.toLowerCase().includes(longWord.slice(2)))
    fail(`partial-token snippet wrong: ${JSON.stringify(phit.match)}`);
  ok("multibyte content query and partial-token ILIKE fallback both hit, with sane snippets");
}

// --- 4. empty q and missing auth -------------------------------------------------------
{
  let r = await apiA(`/api/search?q=`);
  if (r.status !== 200 || r.json.results.length !== 0) fail(`empty q should be {results:[]}: ${r.text}`);
  r = await apiA(`/api/search?q=${encodeURIComponent("   ")}`);
  if (r.status !== 200 || r.json.results.length !== 0) fail(`whitespace q should be {results:[]}: ${r.text}`);
  r = await apiA(`/api/search`);
  if (r.status !== 200 || r.json.results.length !== 0) fail(`missing q should be {results:[]}: ${r.text}`);
  const anon = await fetch(`${SERVER}/api/search?q=${zq}`);
  if (anon.status !== 401) fail(`unauthenticated search should be 401, got ${anon.status}`);
  ok("empty/whitespace/missing q → {results:[]}; no auth → 401");
}

// --- 5. visibility across users ---------------------------------------------------------
{
  const r = await apiB(`/api/search?q=${zq}`);
  if (r.json.results.length !== 0)
    fail(`B should not find A's private docs yet: ${JSON.stringify(r.json.results)}`);
  let own;
  for (let i = 0; i < 20; i++) {
    own = await apiB(`/api/search?q=bq${run}`);
    if (own.json.results.length === 1) break; // content projection: same ~2s debounce
    await sleep(500);
  }
  if (own.json.results.length !== 1 || own.json.results[0].slug !== slugB1)
    fail(`B should find their own doc: ${own.text}`);
  if (own.json.results[0].is_owner !== true || own.json.results[0].owner?.id !== userIdB)
    fail(`B owns their doc: ${JSON.stringify(own.json.results[0])}`);
  const cross = await apiA(`/api/search?q=bq${run}`);
  if (cross.json.results.length !== 0) fail(`A should not find B's doc: ${cross.text}`);
  ok("visibility: B can't find A's docs, each finds their own, A can't find B's");
}

// --- 6. sharing: workspace membership flips visibility + is_owner -----------------------
{
  const inv = await apiA(`/api/workspaces/${wsA}/invites`, {
    method: "POST",
    body: { email: "friend@muesli.md", role: "member" },
  });
  if (inv.status !== 200 || inv.json.status !== "added")
    fail(`inviting an existing user should add immediately: ${inv.status} ${inv.text}`);

  const r = await apiB(`/api/search?q=${zq}`);
  if (r.json.results.length !== 3) fail(`B should now find all 3 shared docs: ${r.text}`);
  for (const hit of r.json.results) {
    if (hit.is_owner !== false) fail(`shared doc must have is_owner:false for B: ${JSON.stringify(hit)}`);
    if (hit.owner?.id !== userIdA) fail(`shared doc owner should be A: ${JSON.stringify(hit.owner)}`);
    if (typeof hit.owner?.display_name === "undefined")
      fail(`owner is missing display_name: ${JSON.stringify(hit.owner)}`);
  }

  // GET /api/documents carries the same owner/is_owner — the "Shared with me" set.
  const list = await apiB("/api/documents");
  const shared = list.json.documents.find((d) => d.slug === slugT1);
  if (!shared || shared.is_owner !== false || shared.owner?.id !== userIdA)
    fail(`listing should mark A's doc as shared for B: ${JSON.stringify(shared)}`);
  const mine = list.json.documents.find((d) => d.slug === slugB1);
  if (!mine || mine.is_owner !== true || mine.owner?.id !== userIdB)
    fail(`listing should mark B's own doc as owned: ${JSON.stringify(mine)}`);
  const listA = await apiA("/api/documents");
  const ownA = listA.json.documents.find((d) => d.slug === slugT1);
  if (!ownA || ownA.is_owner !== true || ownA.owner?.id !== userIdA)
    fail(`listing should mark A's doc as A's own: ${JSON.stringify(ownA)}`);
  ok("after invite: B finds A's docs (is_owner:false, owner=A); listings carry owner/is_owner");
}

// --- 7. trashed documents never match ----------------------------------------------------
{
  const del = await apiA(`/api/documents/${slugT2}`, { method: "DELETE" });
  if (del.status !== 200 || del.json.trashed !== true) fail(`trash t2 → ${del.status} ${del.text}`);
  const r = await apiA(`/api/search?q=${zq}`);
  if (r.json.results.length !== 2) fail(`trashed doc still matches: ${r.text}`);
  if (r.json.results.some((x) => x.slug === slugT2)) fail(`trashed doc in results: ${r.text}`);
  ok("trashed doc disappeared from search");
}

// --- 8. source labels: attached-storage vs native ------------------------------------------
{
  const conn = await apiA(`/api/workspaces/${wsA}/storage`, {
    method: "POST",
    body: { kind: "s3", endpoint: S3.endpoint, bucket: S3.bucket },
  });
  if (conn.status !== 200) fail(`create storage connection → ${conn.status} ${conn.text}`);
  const attach = await apiA(`/api/documents/${slugT1}/storage`, {
    method: "POST",
    body: { storage_conn_id: conn.json.storage_conn_id },
  });
  if (attach.status !== 200) fail(`attach t1 → ${attach.status} ${attach.text}`);

  const r = await apiA(`/api/search?q=${zq}`);
  const t1 = r.json.results.find((x) => x.slug === slugT1);
  const c1 = r.json.results.find((x) => x.slug === slugC1);
  if (!t1 || t1.source.kind !== "s3" || t1.source.label !== S3.bucket)
    fail(`attached doc source should be s3/${S3.bucket}: ${JSON.stringify(t1?.source)}`);
  if (!c1 || c1.source.kind !== "native" || c1.source.label !== "Muesli Cloud")
    fail(`unattached doc source should stay native: ${JSON.stringify(c1?.source)}`);
  ok(`source labels: attached → s3/${S3.bucket}, unattached → native/Muesli Cloud`);
}

console.log("ALL SEARCH + SHARED/OWNER CHECKS PASSED");
for (const c of clients) c.provider.destroy();
serverProc.kill("SIGKILL");
process.exit(0);
