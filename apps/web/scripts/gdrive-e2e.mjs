// Google Drive storage backend e2e (ADR 0013, kind "gdrive") against a MOCK Google that
// this script runs in-process on :9477 (/auth, /token, /drive/v3/files, /upload/...).
// Starts its own muesli-server in OIDC mode (dex + postgres + redis from docker-compose
// must be up) with the MUESLI_GOOGLE_* endpoint overrides pointed at the mock, and drives
// the whole connector end to end:
//   1. dev logs in → GET /api/workspaces/{id}/storage/google/start → 302; the auth URL
//      carries client_id, the callback redirect_uri, scope drive.file, access_type=offline,
//      prompt=consent, and a state token
//   2. following the mock's redirect into /auth/storage/google/callback creates the
//      connection: code→token exchange, "Muesli" folder find-or-create (the probe),
//      storage_connections row {refresh_token, folder_id, folder_name}, redirect to the
//      web origin with ?storage=connected
//   3. the API listing shows the connection with folder_id but REDACTS refresh_token;
//      the row in postgres holds the real one
//   4. POST /api/workspaces/{id}/storage {kind:"gdrive"} is rejected (the dance is the path)
//   5. attach doc → the Drive file exists immediately (multipart create, flat in the
//      folder, name = rel_path); ws edits are debounce-materialized (media PATCH)
//   6. out-of-band update of the mock file (content + md5 bump) → polled, ingested into
//      the live room within MUESLI_STORAGE_POLL_SECS
//   7. token EXPIRY path: the mock revokes all access tokens and 401s once; the server
//      refreshes (refresh_token grant) and retries transparently — the next edit lands
//   8. no echo loop (seq stable while idle); callback with a bogus state → 400
// Usage: node gdrive-e2e.mjs   (run `cargo build --workspace` first)
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
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
const MOCK = "http://localhost:9477";
const WEB_ORIGIN = "http://localhost:5173";
const slug = `ws-gdrive-e2e-${Date.now()}`;
const POLL_SECS = 2;
const CLIENT_ID = "mock-client-id";
const CLIENT_SECRET = "mock-client-secret";

let serverProc = null;
let mockServer = null;
const shutdown = () => {
  if (serverProc) serverProc.kill("SIGKILL");
  if (mockServer) mockServer.close();
};
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  shutdown();
  process.exit(1);
};
const ok = (msg) => console.log(`OK: ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => fail("global timeout"), 180_000).unref();

// ---------------------------------------------------------------------------------
// The mock Google: OAuth (/auth, /token) + Drive v3 (files.list/get/create/update)
// ---------------------------------------------------------------------------------
const mock = {
  authRequests: [], // recorded query params of each /auth hit
  codes: new Set(),
  refreshTokens: new Set(),
  validAccess: new Set(),
  accessCounter: 0,
  codeCounter: 0,
  refreshGrants: 0,
  expireOnce: false, // next Drive request: 401 + revoke every live access token
  files: new Map(), // id -> {name, mimeType, parents:[...], content:Buffer|null, md5}
};
const md5 = (buf) => createHash("md5").update(buf).digest("hex");
const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
const sendJson = (res, status, obj) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

// Parse the Drive `q` grammar subset the server emits: name='…', '…' in parents,
// mimeType='…', trashed=false — joined by " and ". Unescapes \' and \\.
function parseQ(q) {
  const unesc = (s) => s.replace(/\\(['\\])/g, "$1");
  const out = {};
  const name = q.match(/name='((?:[^'\\]|\\.)*)'/);
  if (name) out.name = unesc(name[1]);
  const parent = q.match(/'((?:[^'\\]|\\.)*)' in parents/);
  if (parent) out.parent = unesc(parent[1]);
  const mime = q.match(/mimeType='((?:[^'\\]|\\.)*)'/);
  if (mime) out.mimeType = unesc(mime[1]);
  out.trashed = /trashed=false/.test(q);
  return out;
}

function bearerOf(req) {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

mockServer = createServer(async (req, res) => {
  const url = new URL(req.url, MOCK);
  try {
    // ---- OAuth: the consent screen ------------------------------------------------
    if (url.pathname === "/auth" && req.method === "GET") {
      const params = Object.fromEntries(url.searchParams);
      mock.authRequests.push(params);
      const code = `code-${++mock.codeCounter}`;
      mock.codes.add(code);
      const back = new URL(params.redirect_uri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", params.state);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    // ---- OAuth: the token endpoint ------------------------------------------------
    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams((await readBody(req)).toString());
      if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET)
        return sendJson(res, 401, { error: "invalid_client" });
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        const code = form.get("code");
        if (!mock.codes.delete(code)) return sendJson(res, 400, { error: "invalid_grant" });
        if (form.get("redirect_uri") !== `${SERVER}/auth/storage/google/callback`)
          return sendJson(res, 400, { error: "redirect_uri_mismatch" });
        const access = `at-${++mock.accessCounter}`;
        mock.validAccess.add(access);
        mock.refreshTokens.add("rt-1");
        return sendJson(res, 200, {
          access_token: access,
          refresh_token: "rt-1",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "https://www.googleapis.com/auth/drive.file",
        });
      }
      if (grant === "refresh_token") {
        if (!mock.refreshTokens.has(form.get("refresh_token")))
          return sendJson(res, 400, { error: "invalid_grant" });
        mock.refreshGrants++;
        const access = `at-${++mock.accessCounter}`;
        mock.validAccess.add(access);
        return sendJson(res, 200, { access_token: access, expires_in: 3600, token_type: "Bearer" });
      }
      return sendJson(res, 400, { error: "unsupported_grant_type" });
    }
    // ---- Drive v3 (everything below requires a live bearer token) ------------------
    if (url.pathname.startsWith("/drive/") || url.pathname.startsWith("/upload/")) {
      if (mock.expireOnce) {
        // Simulated expiry: revoke every live token and 401 this one request; the
        // server must refresh (refresh_token grant) and retry transparently.
        mock.expireOnce = false;
        mock.validAccess.clear();
        return sendJson(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
      }
      const token = bearerOf(req);
      if (!token || !mock.validAccess.has(token))
        return sendJson(res, 401, { error: { code: 401, message: "Invalid Credentials" } });

      // files.list
      if (url.pathname === "/drive/v3/files" && req.method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        const want = parseQ(q);
        const files = [...mock.files.entries()]
          .filter(([, f]) => (want.name ? f.name === want.name : true))
          .filter(([, f]) => (want.parent ? (f.parents ?? []).includes(want.parent) : true))
          .filter(([, f]) => (want.mimeType ? f.mimeType === want.mimeType : true))
          .map(([id, f]) => ({ id, name: f.name, mimeType: f.mimeType, md5Checksum: f.md5 }));
        return sendJson(res, 200, { files });
      }
      // files.get (metadata or ?alt=media)
      const fileGet = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
      if (fileGet && req.method === "GET") {
        const f = mock.files.get(fileGet[1]);
        if (!f) return sendJson(res, 404, { error: { code: 404, message: "not found" } });
        if (url.searchParams.get("alt") === "media") {
          res.writeHead(200, { "content-type": "text/markdown" });
          return res.end(f.content ?? Buffer.alloc(0));
        }
        return sendJson(res, 200, {
          id: fileGet[1],
          name: f.name,
          mimeType: f.mimeType,
          md5Checksum: f.md5,
          trashed: false,
        });
      }
      // files.create metadata-only (the app folder)
      if (url.pathname === "/drive/v3/files" && req.method === "POST") {
        const meta = JSON.parse((await readBody(req)).toString());
        const id = `folder-${randomUUID().slice(0, 8)}`;
        mock.files.set(id, {
          name: meta.name,
          mimeType: meta.mimeType ?? "application/octet-stream",
          parents: meta.parents ?? [],
          content: null,
          md5: undefined,
        });
        return sendJson(res, 200, { id, name: meta.name });
      }
      // multipart create
      if (url.pathname === "/upload/drive/v3/files" && req.method === "POST") {
        if (url.searchParams.get("uploadType") !== "multipart")
          return sendJson(res, 400, { error: "expected uploadType=multipart" });
        const ct = req.headers["content-type"] ?? "";
        const bMatch = ct.match(/boundary=([^;]+)/);
        if (!bMatch) return sendJson(res, 400, { error: "no boundary" });
        const raw = (await readBody(req)).toString("utf8");
        const parts = raw
          .split(`--${bMatch[1]}`)
          .map((p) => p.replace(/^\r\n/, "").replace(/\r\n$/, ""))
          .filter((p) => p && p !== "--");
        if (parts.length !== 2) return sendJson(res, 400, { error: `got ${parts.length} parts` });
        const [metaPart, mediaPart] = parts.map((p) => {
          const i = p.indexOf("\r\n\r\n");
          return { headers: p.slice(0, i), body: p.slice(i + 4) };
        });
        if (!/application\/json/i.test(metaPart.headers))
          return sendJson(res, 400, { error: "first part must be JSON metadata" });
        const meta = JSON.parse(metaPart.body);
        const content = Buffer.from(mediaPart.body, "utf8");
        const id = `file-${randomUUID().slice(0, 8)}`;
        mock.files.set(id, {
          name: meta.name,
          mimeType: "text/markdown",
          parents: meta.parents ?? [],
          content,
          md5: md5(content),
        });
        return sendJson(res, 200, { id, name: meta.name, md5Checksum: md5(content) });
      }
      // media update
      const patch = url.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
      if (patch && req.method === "PATCH") {
        if (url.searchParams.get("uploadType") !== "media")
          return sendJson(res, 400, { error: "expected uploadType=media" });
        const f = mock.files.get(patch[1]);
        if (!f) return sendJson(res, 404, { error: { code: 404, message: "not found" } });
        f.content = await readBody(req);
        f.md5 = md5(f.content);
        return sendJson(res, 200, { id: patch[1], md5Checksum: f.md5 });
      }
    }
    sendJson(res, 404, { error: `mock google: no route for ${req.method} ${url.pathname}` });
  } catch (e) {
    sendJson(res, 500, { error: String(e) });
  }
});
await new Promise((resolve, reject) => {
  mockServer.on("error", reject);
  mockServer.listen(9477, "127.0.0.1", resolve);
}).catch((e) => fail(`mock google could not bind :9477 — ${e.message}`));
ok("mock google up on :9477");

// ---------------------------------------------------------------------------------
// make this run repeatable: drop gdrive connections from earlier runs (their folder
// ids and refresh tokens point into a mock Drive that no longer exists)
// ---------------------------------------------------------------------------------
{
  const SQL = `
    update documents set storage_conn_id = null, rel_path = null, content_hash = null
      where storage_conn_id in (select id from storage_connections where kind = 'gdrive');
    delete from storage_connections where kind = 'gdrive';`;
  try {
    execFileSync(
      "docker",
      ["compose", "exec", "-T", "postgres", "psql", "-U", "muesli", "-d", "muesli", "-v", "ON_ERROR_STOP=1", "-c", SQL],
      { cwd: repoRoot, stdio: "pipe" },
    );
  } catch (e) {
    fail(`resetting old gdrive connections failed: ${e.stderr?.toString() ?? e.message}`);
  }
  ok("stale gdrive connections from earlier runs removed");
}

// ---------------------------------------------------------------------------------
// muesli-server in OIDC mode, Google endpoints pointed at the mock
// ---------------------------------------------------------------------------------
try {
  await fetch(`${SERVER}/healthz`);
  fail("something is already listening on :8787 — stop it first");
} catch {}
serverProc = spawn(SERVER_BIN, [], {
  env: {
    ...process.env,
    DATABASE_URL: "postgres://muesli:muesli@localhost:5433/muesli",
    REDIS_URL: "redis://localhost:6380",
    OIDC_ISSUER: DEX,
    OIDC_CLIENT_ID: "muesli",
    OIDC_CLIENT_SECRET: "muesli-dev-secret",
    MUESLI_PUBLIC_URL: SERVER,
    MUESLI_WEB_ORIGIN: WEB_ORIGIN,
    MUESLI_LISTEN: "127.0.0.1:8787",
    // the Google client (dummies) + the endpoint test hooks → the mock
    MUESLI_GOOGLE_CLIENT_ID: CLIENT_ID,
    MUESLI_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    MUESLI_GOOGLE_AUTH_URI: `${MOCK}/auth`,
    MUESLI_GOOGLE_TOKEN_URI: `${MOCK}/token`,
    MUESLI_GOOGLE_API_BASE: MOCK,
    MUESLI_STORAGE_POLL_SECS: String(POLL_SECS),
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
ok(`server up (OIDC mode, google → mock, poll every ${POLL_SECS}s)`);

// --- cookie-jar OIDC login helper (as workspace-s3-e2e.mjs) -------------------------
async function login(email) {
  const jar = new Map();
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

// --- login + the doc to attach -------------------------------------------------------
const devCookie = await login("dev@muesli.md");
const dev = apiFor(devCookie);
let devWs;
{
  const r = await dev("/api/workspaces");
  if (r.status !== 200) fail(`GET /api/workspaces → ${r.status} ${r.text}`);
  const personal = r.json.workspaces.find((w) => w.is_personal);
  if (!personal) fail(`no personal workspace in ${r.text}`);
  devWs = personal.id;
  ok(`dev logged in; personal workspace ${devWs}`);
}

function connect(cookie) {
  class JarWS extends WebSocket {
    constructor(url, protocols) {
      super(url, protocols, { headers: { cookie } });
    }
  }
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(WS_URL, slug, doc, {
    WebSocketPolyfill: JarWS,
    disableBc: true,
  });
  const synced = new Promise((resolve) => provider.on("sync", (s) => s && resolve()));
  return { doc, provider, text: doc.getText("content"), synced };
}
const devClient = connect(devCookie);
await devClient.synced;
devClient.text.insert(0, "# Drive Notes\n\nhello from dev.\n");
await sleep(400);
ok("doc created over ws");

// --- 1. the start redirect: assert every OAuth parameter ------------------------------
let stateToken;
{
  const res = await fetch(`${SERVER}/api/workspaces/${devWs}/storage/google/start`, {
    redirect: "manual",
    headers: { cookie: devCookie },
  });
  if (res.status !== 302 && res.status !== 303)
    fail(`start → ${res.status} (expected 302): ${await res.text()}`);
  const loc = new URL(res.headers.get("location"));
  if (`${loc.origin}${loc.pathname}` !== `${MOCK}/auth`)
    fail(`auth URL points at ${loc.origin}${loc.pathname}, expected ${MOCK}/auth`);
  const p = loc.searchParams;
  if (p.get("client_id") !== CLIENT_ID) fail(`client_id=${p.get("client_id")}`);
  if (p.get("redirect_uri") !== `${SERVER}/auth/storage/google/callback`)
    fail(`redirect_uri=${p.get("redirect_uri")}`);
  if (p.get("response_type") !== "code") fail(`response_type=${p.get("response_type")}`);
  if (p.get("scope") !== "https://www.googleapis.com/auth/drive.file")
    fail(`scope=${p.get("scope")}`);
  if (p.get("access_type") !== "offline") fail(`access_type=${p.get("access_type")}`);
  if (p.get("prompt") !== "consent") fail(`prompt=${p.get("prompt")}`);
  stateToken = p.get("state");
  if (!stateToken) fail("no state token in the auth URL");
  ok("start → 302 with drive.file scope, offline access, consent prompt, state token");

  // negative first: a bogus state must be a 400 and must not consume the real one
  const bogus = await fetch(
    `${SERVER}/auth/storage/google/callback?code=code-x&state=not-a-state`,
    { redirect: "manual" },
  );
  if (bogus.status !== 400) fail(`bogus state → ${bogus.status}, expected 400`);
  ok("callback with an unknown state → 400");

  // follow the dance: mock /auth redirects to the callback with a code
  const consent = await fetch(loc, { redirect: "manual" });
  if (consent.status !== 302) fail(`mock /auth → ${consent.status}`);
  const cbUrl = new URL(consent.headers.get("location"));
  if (`${cbUrl.origin}${cbUrl.pathname}` !== `${SERVER}/auth/storage/google/callback`)
    fail(`mock redirected to ${cbUrl}`);
  if (cbUrl.searchParams.get("state") !== stateToken) fail("state did not round-trip");
  const cb = await fetch(cbUrl, { redirect: "manual" });
  if (cb.status !== 302 && cb.status !== 303)
    fail(`callback → ${cb.status}: ${await cb.text()}`);
  const finalLoc = cb.headers.get("location");
  if (finalLoc !== `${WEB_ORIGIN}/?storage=connected#~settings/connections`)
    fail(`callback redirected to ${finalLoc}, expected ${WEB_ORIGIN}/?storage=connected#~settings/connections`);
  if (mock.authRequests.length !== 1) fail(`mock /auth hit ${mock.authRequests.length} times`);
  ok("callback exchanged the code and bounced to the web origin with ?storage=connected");

  // replay: the state token is single-use
  const replay = await fetch(cbUrl, { redirect: "manual" });
  if (replay.status !== 400) fail(`replayed callback → ${replay.status}, expected 400`);
  ok("replaying the callback (used state) → 400");
}

// --- 2. the connection: folder created, refresh token stored (and redacted) ------------
let connId, folderId;
{
  const r = await dev(`/api/workspaces/${devWs}/storage`);
  if (r.status !== 200) fail(`list storage → ${r.status} ${r.text}`);
  const conn = r.json.connections.find((c) => c.kind === "gdrive");
  if (!conn) fail(`no gdrive connection in ${r.text}`);
  connId = conn.id;
  folderId = conn.config.folder_id;
  if (!folderId) fail(`connection has no folder_id: ${r.text}`);
  if (conn.config.folder_name !== "Muesli") fail(`folder_name=${conn.config.folder_name}`);
  if ("refresh_token" in conn.config)
    fail("refresh_token LEAKED through GET /api/workspaces/{id}/storage");
  if (conn.config.has_refresh_token !== true) fail("has_refresh_token flag missing");
  const folder = mock.files.get(folderId);
  if (!folder || folder.name !== "Muesli" || folder.mimeType !== "application/vnd.google-apps.folder")
    fail(`mock has no Muesli folder under id ${folderId}`);
  // the row itself must hold the refresh token (server-side, for the token dance)
  try {
    const out = execFileSync(
      "docker",
      ["compose", "exec", "-T", "postgres", "psql", "-U", "muesli", "-d", "muesli", "-tA", "-c",
        `select config->>'refresh_token' from storage_connections where id = '${connId}'`],
      { cwd: repoRoot, stdio: "pipe" },
    ).toString().trim();
    if (out !== "rt-1") fail(`stored refresh_token is ${JSON.stringify(out)}, expected rt-1`);
  } catch (e) {
    fail(`psql check failed: ${e.stderr?.toString() ?? e.message}`);
  }
  ok(`gdrive connection ${connId}: Muesli folder ${folderId}, refresh_token stored in db, redacted in api`);
}

// --- 3. POSTing kind gdrive is not the path ---------------------------------------------
{
  const r = await dev(`/api/workspaces/${devWs}/storage`, {
    method: "POST",
    body: { kind: "gdrive" },
  });
  if (r.status !== 400) fail(`POST kind gdrive → ${r.status}, expected 400`);
  ok("POST {kind:\"gdrive\"} → 400 (the OAuth dance is the only path)");
}

// --- 4. attach: multipart create, flat name --------------------------------------------
const relPath = `${slug}.md`;
const driveFileOf = (name) => [...mock.files.entries()].find(([, f]) => f.name === name);
{
  const r = await dev(`/api/documents/${slug}/storage`, {
    method: "POST",
    body: { storage_conn_id: connId },
  });
  if (r.status !== 200) fail(`attach → ${r.status} ${r.text}`);
  if (r.json.rel_path !== relPath) fail(`rel_path=${r.json.rel_path}`);
  if (!r.json.content_hash) fail(`attach did not materialize: ${r.text}`);
  const entry = driveFileOf(relPath);
  if (!entry) fail(`no Drive file named ${relPath} after attach`);
  const [, f] = entry;
  if (!(f.parents ?? []).includes(folderId)) fail("file is not in the Muesli folder");
  if (f.content.toString() !== devClient.text.toString())
    fail(`Drive content differs from the doc: ${JSON.stringify(f.content.toString())}`);
  ok("attach created the Drive file (multipart, in the Muesli folder) with the doc text");
}

// --- 5. ws edit → debounced media PATCH --------------------------------------------------
devClient.text.insert(devClient.text.length, "MATERIALIZE-ME\n");
{
  let content = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    content = driveFileOf(relPath)?.[1].content?.toString();
    if (content?.includes("MATERIALIZE-ME")) break;
  }
  if (!content?.includes("MATERIALIZE-ME"))
    fail(`edit was not materialized to Drive: ${JSON.stringify(content)}`);
  if (content !== devClient.text.toString()) fail("Drive content diverges from the doc");
  ok("ws edit landed in Drive via the debounced materialize loop (media PATCH)");
}

// --- 6. out-of-band update of the mock file → polled ingest -------------------------------
{
  const [, f] = driveFileOf(relPath);
  const modified = f.content.toString().replace("hello from dev.", "hello from dev, edited OUT-OF-BAND.");
  if (modified === f.content.toString()) fail("test bug: replacement did not change the text");
  f.content = Buffer.from(modified);
  f.md5 = md5(f.content);

  let seen = false;
  for (let i = 0; i < 40 && !seen; i++) {
    await sleep(500);
    seen = devClient.text.toString().includes("OUT-OF-BAND");
  }
  if (!seen) fail("ws client never saw the out-of-band change (poll/ingest broken)");
  if (devClient.text.toString() !== modified)
    fail(`room text diverges from Drive after ingest: ${JSON.stringify(devClient.text.toString())}`);
  ok(`out-of-band Drive change ingested live within the poll interval (${POLL_SECS}s)`);

  const hist = await dev(`/api/documents/${slug}/history?limit=100`);
  if (!hist.json.entries?.some((e) => e.origin === "ingest"))
    fail(`no origin=ingest entry in history: ${hist.text}`);
  ok("history shows the ingest entry (origin 'ingest')");
}

// --- 7. token expiry: 401 once → transparent refresh + retry ------------------------------
{
  const grantsBefore = mock.refreshGrants;
  mock.expireOnce = true;
  devClient.text.insert(devClient.text.length, "AFTER-EXPIRY\n");
  let content = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    content = driveFileOf(relPath)?.[1].content?.toString();
    if (content?.includes("AFTER-EXPIRY")) break;
  }
  if (!content?.includes("AFTER-EXPIRY"))
    fail("edit after the forced expiry never reached Drive (401-refresh-retry broken)");
  if (mock.refreshGrants <= grantsBefore)
    fail("no refresh_token grant was issued after the 401");
  if (mock.expireOnce) fail("the mock's 401 was never consumed");
  ok(`forced 401 → server refreshed (grants ${grantsBefore}→${mock.refreshGrants}) and retried transparently`);
}

// --- 8. no echo loop ------------------------------------------------------------------------
{
  // let the post-expiry materialize/ingest churn settle one full poll first
  await sleep((POLL_SECS + 1) * 1000);
  const before = (await dev(`/api/documents/${slug}/text`)).json.seq;
  await sleep((POLL_SECS + 2) * 1000);
  const after = (await dev(`/api/documents/${slug}/text`)).json.seq;
  if (after !== before) fail(`seq moved ${before} → ${after} with no edits (echo loop!)`);
  ok("no materialize/ingest echo loop (seq stable across poll intervals)");
}

console.log("ALL GOOGLE DRIVE CHECKS PASSED");
devClient.provider.destroy();
shutdown();
process.exit(0);
