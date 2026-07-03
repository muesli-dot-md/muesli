// Workspace management + S3 storage backend e2e (ADR 0011 / ADR 0013). Starts its own
// muesli-server in OIDC mode (dex + postgres + redis from docker-compose must be up;
// minio is brought up by this script) and drives the Phase 2 surface end to end:
//   1. dev logs in → GET /api/workspaces shows the personal workspace (admin)
//   2. inviting friend@muesli.md (no such user yet) → {status:"invited"}; the invite is
//      claimed on friend's first OIDC login → membership appears, invite list drains
//   3. friend (member) can open + edit dev's doc over ws (membership → Editor)
//   4. member-role checks: friend gets 403 on invite/storage endpoints; demoting the
//      last admin is a 409
//   5. admin creates an s3 storage connection (MinIO) → attach doc → the object exists
//      immediately; further ws edits are debounce-materialized (~500ms)
//   6. overwriting the object out-of-band is polled (MUESLI_S3_POLL_SECS), ingested into
//      the live room (ws client sees it), and history shows origin 'ingest'
// Usage: node workspace-s3-e2e.mjs   (run `cargo build --workspace` first)
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
const SERVER = "http://localhost:8787";
const WS_URL = "ws://localhost:8787/ws";
const DEX = "http://localhost:5556/dex";
const slug = `ws-s3-e2e-${Date.now()}`;
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

// --- prerequisites: minio up, port free ----------------------------------------
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
  fail("something is already listening on :8787 — stop it first");
} catch {}
ok("minio is up, port 8787 is free");

// --- raw SigV4 (node crypto) for verifying/overwriting objects out-of-band ------
async function s3Request(method, key, body = null) {
  const datetime = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = datetime.slice(0, 8);
  const payloadHash = createHash("sha256")
    .update(body ?? "")
    .digest("hex");
  const host = new URL(S3.endpoint).host;
  const uri = `/${S3.bucket}/${key}`; // keys here are plain [a-z0-9.-] — no encoding needed
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

// --- server lifecycle (env shape as mcp-e2e.mjs) ---------------------------------
serverProc = spawn(SERVER_BIN, [], {
  env: {
    ...process.env,
    DATABASE_URL: "postgres://muesli:muesli@localhost:5433/muesli",
    REDIS_URL: "redis://localhost:6380",
    OIDC_ISSUER: DEX,
    OIDC_CLIENT_ID: "muesli",
    OIDC_CLIENT_SECRET: "muesli-dev-secret",
    MUESLI_PUBLIC_URL: SERVER,
    MUESLI_WEB_ORIGIN: "http://localhost:5173",
    MUESLI_LISTEN: "127.0.0.1:8787",
    MUESLI_S3_ACCESS_KEY: S3.access,
    MUESLI_S3_SECRET_KEY: S3.secret,
    MUESLI_S3_POLL_SECS: String(POLL_SECS),
    // MinIO is at localhost:9000 (SSRF guard target) — this harness IS the trusted
    // self-host case the escape hatch exists for.
    MUESLI_STORAGE_ALLOW_PRIVATE: "true",
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
ok(`server up (OIDC mode, S3 creds set, poll every ${POLL_SECS}s)`);

// --- make this run repeatable: forget friend@muesli.md (claim must be first-login) ---
{
  const SQL = `
    update crdt_updates set author_id = null
      where author_id in (select id from users where email = 'friend@muesli.md');
    delete from document_acl
      where user_id in (select id from users where email = 'friend@muesli.md');
    delete from api_tokens
      where principal_id in (select id from users where email = 'friend@muesli.md')
         or owner_user_id in (select id from users where email = 'friend@muesli.md');
    delete from invites where email = 'friend@muesli.md';
    update documents set workspace_id = null where workspace_id in
      (select id from workspaces where created_by in
        (select id from users where email = 'friend@muesli.md'));
    delete from workspaces
      where created_by in (select id from users where email = 'friend@muesli.md');
    delete from users where email = 'friend@muesli.md';`;
  try {
    execFileSync(
      "docker",
      ["compose", "exec", "-T", "postgres", "psql", "-U", "muesli", "-d", "muesli", "-v", "ON_ERROR_STOP=1", "-c", SQL],
      { cwd: repoRoot, stdio: "pipe" },
    );
  } catch (e) {
    fail(`resetting friend@muesli.md failed: ${e.stderr?.toString() ?? e.message}`);
  }
  ok("friend@muesli.md reset (invite claim will be a first login)");
}

// --- cookie-jar OIDC login helper (as auth-e2e.mjs), one jar per user -------------
async function login(email) {
  const jar = new Map(); // host -> Map(name -> value)
  const cookieHeader = (url) => {
    const m = jar.get(new URL(url).host);
    return m ? [...m].map(([k, v]) => `${k}=${v}`).join("; ") : "";
  };
  const request = async (url, opts = {}) => {
    const res = await fetch(url, {
      ...opts,
      redirect: "manual",
      headers: { ...(opts.headers ?? {}), cookie: cookieHeader(url) },
    });
    const host = new URL(url).host;
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (!jar.has(host)) jar.set(host, new Map());
      jar.get(host).set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return res;
  };
  const follow = async (url, opts = {}) => {
    let res = await request(url, opts);
    let hops = 0;
    while ([301, 302, 303, 307].includes(res.status)) {
      if (++hops > 10) fail("redirect loop");
      url = new URL(res.headers.get("location"), url).toString();
      res = await request(url);
    }
    return { res, url };
  };
  const { res, url } = await follow(`${SERVER}/auth/login`);
  if (!res.ok) fail(`${email}: login chain ended ${res.status} at ${url}`);
  const { res: after } = await follow(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ login: email, password: "password" }),
  });
  if (!after.ok) fail(`${email}: login POST failed (${after.status})`);
  const session = jar.get("localhost:8787")?.get("muesli_session");
  if (!session) fail(`${email}: no session cookie`);
  return `muesli_session=${session}`;
}

function apiFor(cookie) {
  return async (path, { method = "GET", body } = {}) => {
    const res = await fetch(`${SERVER}${path}`, {
      method,
      headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
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

// --- 1. dev logs in: personal workspace exists -------------------------------------
const devCookie = await login("dev@muesli.md");
const dev = apiFor(devCookie);
const devUserId = (await dev("/api/me")).json?.user?.id;
if (!devUserId) fail("no dev user id from /api/me");

let devWs;
{
  const r = await dev("/api/workspaces");
  if (r.status !== 200) fail(`GET /api/workspaces → ${r.status} ${r.text}`);
  const personal = r.json.workspaces.find((w) => w.is_personal);
  if (!personal) fail(`no personal workspace in ${r.text}`);
  if (personal.role !== "admin") fail(`expected admin on personal workspace, got ${personal.role}`);
  devWs = personal.id;
  ok(`dev's personal workspace: ${devWs} (admin)`);
}

// --- 2. invite friend (no such user yet) → status invited ---------------------------
{
  const r = await dev(`/api/workspaces/${devWs}/invites`, {
    method: "POST",
    body: { email: "friend@muesli.md", role: "member" },
  });
  if (r.status !== 200) fail(`invite → ${r.status} ${r.text}`);
  if (r.json.status !== "invited") fail(`expected status invited, got ${r.text}`);
  const detail = await dev(`/api/workspaces/${devWs}`);
  if (!detail.json.invites?.some((i) => i.email === "friend@muesli.md"))
    fail(`pending invite missing from workspace detail: ${detail.text}`);
  ok("friend invited (pending invite row, visible to the admin)");
}

// --- 2b. invite lifecycle: a deletable ghost invite ---------------------------------
{
  const inv = await dev(`/api/workspaces/${devWs}/invites`, {
    method: "POST",
    body: { email: "ghost@muesli.md", role: "admin" },
  });
  if (inv.json?.status !== "invited") fail(`ghost invite → ${inv.status} ${inv.text}`);
  const del = await dev(`/api/workspaces/${devWs}/invites/${inv.json.invite_id}`, {
    method: "DELETE",
  });
  if (del.status !== 200) fail(`delete invite → ${del.status} ${del.text}`);
  const detail = await dev(`/api/workspaces/${devWs}`);
  if (detail.json.invites?.some((i) => i.email === "ghost@muesli.md"))
    fail("deleted invite still listed");
  ok("invite delete works");
}

// --- 3. dev creates a doc over ws ----------------------------------------------------
function connect(cookie) {
  class JarWS extends WebSocket {
    constructor(url, protocols) {
      super(url, protocols, { headers: { cookie } });
    }
  }
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(WS_URL, slug, doc, {
    WebSocketPolyfill: JarWS,
    disableBc: true, // same-process clients must not bypass the server over BroadcastChannel
  });
  const synced = new Promise((resolve) => provider.on("sync", (s) => s && resolve()));
  return { doc, provider, text: doc.getText("content"), synced };
}

const devClient = connect(devCookie);
await devClient.synced;
const BASE_TEXT = "# Shared Notes\n\nhello from dev.\n";
devClient.text.insert(0, BASE_TEXT);
await sleep(400);
{
  const docs = await dev("/api/documents");
  if (docs.status !== 200) fail(`GET /api/documents → ${docs.status} ${docs.text}`);
  const d = docs.json.documents.find((d) => d.slug === slug);
  if (!d) fail("new doc missing from GET /api/documents");
  if (d.workspace_id !== devWs) fail(`doc owned by ${d.workspace_id}, expected ${devWs}`);
  ok("doc created over ws, listed by GET /api/documents in dev's workspace");
}

// --- 4. friend's first login claims the invite ----------------------------------------
const friendCookie = await login("friend@muesli.md");
const friend = apiFor(friendCookie);
{
  const r = await friend("/api/workspaces");
  if (r.status !== 200) fail(`friend GET /api/workspaces → ${r.status} ${r.text}`);
  const shared = r.json.workspaces.find((w) => w.id === devWs);
  if (!shared) fail(`invite not claimed; friend's workspaces: ${r.text}`);
  if (shared.role !== "member") fail(`expected member role, got ${shared.role}`);
  const detail = await dev(`/api/workspaces/${devWs}`);
  if (detail.json.invites?.some((i) => i.email === "friend@muesli.md"))
    fail("claimed invite still pending");
  if (!detail.json.members.some((m) => m.email === "friend@muesli.md" && m.role === "member"))
    fail(`friend missing from members: ${detail.text}`);
  ok("invite claimed on first OIDC login: friend is a member of dev's workspace");
}

// --- 5. membership → Editor: friend edits dev's doc over ws ----------------------------
const friendClient = connect(friendCookie);
await friendClient.synced;
if (!friendClient.text.toString().includes("hello from dev")) fail("friend did not sync the doc");
friendClient.text.insert(friendClient.text.length, "FRIEND-MARK\n");
await sleep(500);
if (!devClient.text.toString().includes("FRIEND-MARK"))
  fail("friend's edit did not reach dev's client");
ok("friend (workspace member) edited the doc over ws");

// --- 6. member-role checks: 403 on admin-only endpoints --------------------------------
{
  const inv = await friend(`/api/workspaces/${devWs}/invites`, {
    method: "POST",
    body: { email: "nope@muesli.md", role: "member" },
  });
  if (inv.status !== 403) fail(`member invite should be 403, got ${inv.status} ${inv.text}`);
  const st = await friend(`/api/workspaces/${devWs}/storage`, {
    method: "POST",
    body: { kind: "s3", endpoint: S3.endpoint, bucket: S3.bucket },
  });
  if (st.status !== 403) fail(`member storage create should be 403, got ${st.status} ${st.text}`);
  ok("non-admin gets 403 on invite + storage endpoints");
}

// --- 7. last-admin guard ------------------------------------------------------------------
{
  const r = await dev(`/api/workspaces/${devWs}/members/${devUserId}`, {
    method: "PATCH",
    body: { role: "member" },
  });
  if (r.status !== 409) fail(`demoting the last admin should be 409, got ${r.status} ${r.text}`);
  ok("demoting the last admin is rejected with 409");
}

// --- 8. storage connection + attach ----------------------------------------------------
let connId;
{
  const r = await dev(`/api/workspaces/${devWs}/storage`, {
    method: "POST",
    body: { kind: "s3", endpoint: S3.endpoint, bucket: S3.bucket },
  });
  if (r.status !== 200) fail(`create storage connection → ${r.status} ${r.text}`);
  connId = r.json.storage_conn_id;
  const list = await dev(`/api/workspaces/${devWs}/storage`);
  if (!list.json.connections?.some((c) => c.id === connId))
    fail(`connection missing from list: ${list.text}`);
  ok(`s3 storage connection created (${connId})`);
}

const relPath = `${slug}.md`;
{
  const r = await dev(`/api/documents/${slug}/storage`, {
    method: "POST",
    body: { storage_conn_id: connId },
  });
  if (r.status !== 200) fail(`attach → ${r.status} ${r.text}`);
  if (r.json.rel_path !== relPath) fail(`expected default rel_path ${relPath}, got ${r.text}`);
  if (!r.json.content_hash) fail(`attach did not materialize: ${r.text}`);
  const obj = await s3Request("GET", relPath);
  if (!obj.ok) fail(`object missing right after attach: ${obj.status}`);
  const body = await obj.text();
  if (body !== devClient.text.toString())
    fail(`materialized object differs from the doc: ${JSON.stringify(body)}`);
  ok("attach materialized the current text to MinIO immediately");
}

// --- 9. ws edit → debounced materialization --------------------------------------------
devClient.text.insert(devClient.text.length, "MATERIALIZE-ME\n");
{
  let body = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const obj = await s3Request("GET", relPath);
    if (obj.ok) {
      body = await obj.text();
      if (body.includes("MATERIALIZE-ME")) break;
    }
  }
  if (!body?.includes("MATERIALIZE-ME"))
    fail(`edit was not materialized to MinIO: ${JSON.stringify(body)}`);
  if (body !== devClient.text.toString()) fail("materialized object diverges from the doc");
  ok("ws edit landed in MinIO via the debounced materialize loop");
}

// --- 10. out-of-band overwrite → polled ingest into the live room -------------------------
{
  const current = await (await s3Request("GET", relPath)).text();
  const modified = current.replace("hello from dev.", "hello from dev, edited OUT-OF-BAND.");
  if (modified === current) fail("test bug: replacement did not change the text");
  const put = await s3Request("PUT", relPath, modified);
  if (!put.ok) fail(`out-of-band PUT failed: ${put.status} ${await put.text()}`);

  let seen = false;
  for (let i = 0; i < 40 && !seen; i++) {
    await sleep(500);
    seen = devClient.text.toString().includes("OUT-OF-BAND");
  }
  if (!seen) fail("ws client never saw the out-of-band change (poll/ingest broken)");
  if (devClient.text.toString() !== modified)
    fail(`room text diverges from the object after ingest: ${JSON.stringify(devClient.text.toString())}`);
  if (!friendClient.text.toString().includes("OUT-OF-BAND"))
    fail("friend's client did not receive the ingested change");
  ok(`out-of-band change ingested live within the poll interval (${POLL_SECS}s)`);

  const hist = await dev(`/api/documents/${slug}/history?limit=100`);
  if (hist.status !== 200) fail(`history → ${hist.status} ${hist.text}`);
  const ingest = hist.json.entries.find((e) => e.origin === "ingest");
  if (!ingest) fail(`no origin=ingest entry in history: ${hist.text}`);
  if (ingest.author !== null) fail(`ingest entry should be unattributed, got ${JSON.stringify(ingest.author)}`);
  ok("history shows the ingest entry (origin 'ingest', author None)");
}

// --- 11. the ingest does not echo back (no churn) ------------------------------------------
{
  const before = (await dev(`/api/documents/${slug}/text`)).json.seq;
  await sleep((POLL_SECS + 2) * 1000);
  const after = (await dev(`/api/documents/${slug}/text`)).json.seq;
  if (after !== before) fail(`seq moved ${before} → ${after} with no edits (echo loop!)`);
  ok("no materialize/ingest echo loop (seq stable across poll intervals)");
}

console.log("ALL WORKSPACE + S3 CHECKS PASSED");
devClient.provider.destroy();
friendClient.provider.destroy();
serverProc.kill("SIGKILL");
process.exit(0);
