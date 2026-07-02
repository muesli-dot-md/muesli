// GitHub-compatible storage backend e2e (ADR 0013, kind "github") against the compose
// Gitea (the Contents API is wire-compatible across GitHub/Gitea/Forgejo). Starts its own
// muesli-server in OIDC mode (dex + postgres + redis from docker-compose must be up; gitea
// is brought up by this script) and drives the backend end to end:
//   1. gitea up + healthy → admin user (idempotent) → API token (write:repository) +
//      a fresh muesli-e2e repo, both minted over basic auth
//   2. admin creates a github storage connection (probe: branch must exist; bad repo → 502)
//   3. attach doc → the file exists immediately, with a "muesli: create <path>" commit
//   4. ws edit → debounce-materialized as a "muesli: update <path>" commit
//   5. out-of-band commit via the API is polled, ingested into the live room (ws client
//      sees it), history shows origin 'ingest', and no echo loop (seq stable while idle)
//   6. competing commit racing a materialization: the write's sha-CAS + single retry must
//      leave server and repo consistent (repo == room text eventually). NOTE: the 409/422
//      retry itself fires only if the external commit lands inside the GET-sha→PUT window
//      (milliseconds); that exact interleaving is covered deterministically by the Rust
//      unit tests (storage::tests::github_write_retries_once_on_sha_conflict). Here we
//      assert the honest end-to-end property: no crash + eventual consistency.
// Usage: node workspace-github-e2e.mjs   (run `cargo build --workspace` first)
import { spawn, execFileSync } from "node:child_process";
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
const slug = `ws-gh-e2e-${Date.now()}`;
const POLL_SECS = 2;

const GITEA = "http://localhost:3300";
const API = `${GITEA}/api/v1`;
const ADMIN = { user: "muesli", pass: "muesli-dev-secret" };
const REPO = "muesli-e2e";
const BRANCH = "main";

let serverProc = null;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  if (serverProc) serverProc.kill("SIGKILL");
  process.exit(1);
};
const ok = (msg) => console.log(`OK: ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => fail("global timeout"), 240_000).unref();

const basicAuth = `Basic ${Buffer.from(`${ADMIN.user}:${ADMIN.pass}`).toString("base64")}`;
async function gitea(path, { method = "GET", body, token } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: token ? `token ${token}` : basicAuth,
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

// --- 1. gitea up + healthy; admin user; token + fresh repo --------------------------
try {
  execFileSync("docker", ["compose", "up", "-d", "--wait", "gitea"], {
    cwd: repoRoot,
    stdio: "pipe",
  });
} catch (e) {
  fail(`docker compose up gitea failed: ${e.message}`);
}
{
  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    try {
      healthy = (await fetch(`${API}/version`)).ok;
    } catch {}
    if (!healthy) await sleep(1000);
  }
  if (!healthy) fail(`gitea never became healthy on ${API}/version`);
}
try {
  execFileSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "gitea",
      "gitea",
      "admin",
      "user",
      "create",
      "--admin",
      "--username",
      ADMIN.user,
      "--password",
      ADMIN.pass,
      "--email",
      "gitea@muesli.md",
      "--must-change-password=false",
    ],
    { cwd: repoRoot, stdio: "pipe" },
  );
} catch (e) {
  const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  if (!out.includes("already exists")) fail(`gitea admin user create failed: ${out}`);
}
ok("gitea is up (admin user ensured)");

// Idempotent per run: drop + recreate the e2e repo and the named token.
await gitea(`/repos/${ADMIN.user}/${REPO}`, { method: "DELETE" }); // 404 is fine
{
  const r = await gitea("/user/repos", {
    method: "POST",
    body: { name: REPO, auto_init: true, default_branch: BRANCH, private: false },
  });
  if (r.status !== 201) fail(`repo create → ${r.status} ${r.text}`);
}
await gitea(`/users/${ADMIN.user}/tokens/muesli-e2e`, { method: "DELETE" }); // 404 is fine
let TOKEN;
{
  const r = await gitea(`/users/${ADMIN.user}/tokens`, {
    method: "POST",
    body: { name: "muesli-e2e", scopes: ["write:repository"] },
  });
  if (r.status !== 201 || !r.json?.sha1) fail(`token mint → ${r.status} ${r.text}`);
  TOKEN = r.json.sha1;
}
ok(`fresh repo ${ADMIN.user}/${REPO} + write:repository token minted over basic auth`);

// Contents helpers over the minted token (this is the "out-of-band editor").
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
async function readFile(path) {
  const r = await gitea(`/repos/${ADMIN.user}/${REPO}/contents/${path}?ref=${BRANCH}`, {
    token: TOKEN,
  });
  if (r.status === 404) return null;
  if (r.status !== 200) fail(`contents GET ${path} → ${r.status} ${r.text}`);
  return {
    sha: r.json.sha,
    text: Buffer.from(r.json.content.replace(/\s/g, ""), "base64").toString("utf8"),
  };
}
async function commitFile(path, text, sha, message) {
  return gitea(`/repos/${ADMIN.user}/${REPO}/contents/${path}`, {
    method: sha ? "PUT" : "POST",
    token: TOKEN,
    body: { content: b64(text), message, branch: BRANCH, ...(sha ? { sha } : {}) },
  });
}
async function commitMessages() {
  const r = await gitea(`/repos/${ADMIN.user}/${REPO}/commits?sha=${BRANCH}&limit=50`, {
    token: TOKEN,
  });
  if (r.status !== 200) fail(`commits list → ${r.status} ${r.text}`);
  return r.json.map((c) => c.commit.message.trim());
}

// --- server lifecycle (env shape as workspace-s3-e2e.mjs) ---------------------------
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
    MUESLI_WEB_ORIGIN: "http://localhost:5173",
    MUESLI_LISTEN: "127.0.0.1:8787",
    MUESLI_GITHUB_TOKEN: TOKEN,
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
ok(`server up (OIDC mode, MUESLI_GITHUB_TOKEN minted from gitea, poll every ${POLL_SECS}s)`);

// --- cookie-jar OIDC login (as workspace-s3-e2e.mjs) --------------------------------
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

// --- 2. storage connection kind github (probe: bad repo → 502, good → 200) ----------
{
  const bad = await dev(`/api/workspaces/${devWs}/storage`, {
    method: "POST",
    body: {
      kind: "github",
      api_base: API,
      owner: ADMIN.user,
      repo: "no-such-repo",
      branch: BRANCH,
    },
  });
  if (bad.status !== 502) fail(`bad repo should be 502, got ${bad.status} ${bad.text}`);
  ok("typo'd repo is rejected by the connect-time probe (502)");
}
let connId;
{
  const r = await dev(`/api/workspaces/${devWs}/storage`, {
    method: "POST",
    body: { kind: "github", api_base: API, owner: ADMIN.user, repo: REPO, branch: BRANCH },
  });
  if (r.status !== 200) fail(`create github connection → ${r.status} ${r.text}`);
  connId = r.json.storage_conn_id;
  const list = await dev(`/api/workspaces/${devWs}/storage`);
  if (!list.json.connections?.some((c) => c.id === connId && c.kind === "github"))
    fail(`github connection missing from list: ${list.text}`);
  ok(`github storage connection created (${connId})`);
}

// --- 3. doc over ws → attach → file + create-commit exist immediately ----------------
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
const BASE_TEXT = "# Repo Notes\n\nhello from dev.\n";
devClient.text.insert(0, BASE_TEXT);
await sleep(400);

const relPath = `${slug}.md`;
{
  const r = await dev(`/api/documents/${slug}/storage`, {
    method: "POST",
    body: { storage_conn_id: connId },
  });
  if (r.status !== 200) fail(`attach → ${r.status} ${r.text}`);
  if (r.json.rel_path !== relPath) fail(`expected default rel_path ${relPath}, got ${r.text}`);
  if (!r.json.content_hash) fail(`attach did not materialize: ${r.text}`);
  const file = await readFile(relPath);
  if (!file) fail("file missing right after attach");
  if (file.text !== devClient.text.toString())
    fail(`materialized file differs from the doc: ${JSON.stringify(file.text)}`);
  const messages = await commitMessages();
  if (!messages.includes(`muesli: create ${relPath}`))
    fail(`no "muesli: create ${relPath}" commit; commits: ${JSON.stringify(messages)}`);
  ok("attach materialized to the repo immediately, with a muesli create commit");
}

// --- 4. ws edit → debounced materialization commit ------------------------------------
devClient.text.insert(devClient.text.length, "MATERIALIZE-ME\n");
{
  let file = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    file = await readFile(relPath);
    if (file?.text.includes("MATERIALIZE-ME")) break;
  }
  if (!file?.text.includes("MATERIALIZE-ME"))
    fail(`edit was not materialized to the repo: ${JSON.stringify(file?.text)}`);
  if (file.text !== devClient.text.toString()) fail("materialized file diverges from the doc");
  const messages = await commitMessages();
  if (!messages.includes(`muesli: update ${relPath}`))
    fail(`no "muesli: update ${relPath}" commit; commits: ${JSON.stringify(messages)}`);
  ok("ws edit landed as a muesli update commit via the debounced materialize loop");
}

// --- 5. out-of-band commit → polled ingest into the live room --------------------------
{
  const current = await readFile(relPath);
  const modified = current.text.replace("hello from dev.", "hello from dev, edited OUT-OF-BAND.");
  if (modified === current.text) fail("test bug: replacement did not change the text");
  const put = await commitFile(relPath, modified, current.sha, "external edit");
  if (put.status !== 200 && put.status !== 201)
    fail(`out-of-band commit failed: ${put.status} ${put.text}`);

  let seen = false;
  for (let i = 0; i < 40 && !seen; i++) {
    await sleep(500);
    seen = devClient.text.toString().includes("OUT-OF-BAND");
  }
  if (!seen) fail("ws client never saw the out-of-band commit (poll/ingest broken)");
  if (devClient.text.toString() !== modified)
    fail(
      `room text diverges from the file after ingest: ${JSON.stringify(devClient.text.toString())}`,
    );
  ok(`out-of-band commit ingested live within the poll interval (${POLL_SECS}s)`);

  const hist = await dev(`/api/documents/${slug}/history?limit=100`);
  if (hist.status !== 200) fail(`history → ${hist.status} ${hist.text}`);
  const ingest = hist.json.entries.find((e) => e.origin === "ingest");
  if (!ingest) fail(`no origin=ingest entry in history: ${hist.text}`);
  if (ingest.author !== null)
    fail(`ingest entry should be unattributed, got ${JSON.stringify(ingest.author)}`);
  ok("history shows the ingest entry (origin 'ingest', author None)");
}

// --- 6. no echo loop: seq stable across two idle poll intervals -------------------------
{
  const before = (await dev(`/api/documents/${slug}/text`)).json.seq;
  await sleep((POLL_SECS + 2) * 2 * 1000);
  const after = (await dev(`/api/documents/${slug}/text`)).json.seq;
  if (after !== before) fail(`seq moved ${before} → ${after} with no edits (echo loop!)`);
  ok("no materialize/ingest echo loop (seq stable across 2 idle poll intervals)");
}

// --- 7. competing commit racing a materialization --------------------------------------
// An external commit lands and a ws edit follows immediately, so the debounced
// materialize races the new repo state. The write's GET-sha→PUT CAS plus single retry
// must keep everything consistent. Honest scope: whether the 409/422 retry branch
// actually fires depends on ms-level interleaving (covered deterministically by the Rust
// unit test); what we assert here is no crash + eventual consistency (repo == room text)
// + no echo churn. Git history always retains the competing commit either way.
{
  const current = await readFile(relPath);
  const put = await commitFile(
    relPath,
    current.text + "CONFLICT-MARK\n",
    current.sha,
    "competing external commit",
  );
  if (put.status !== 200 && put.status !== 201)
    fail(`competing commit failed: ${put.status} ${put.text}`);
  devClient.text.insert(devClient.text.length, "WS-RACE\n"); // materialize fires ~500ms later

  let consistent = false;
  let file = null;
  for (let i = 0; i < 40 && !consistent; i++) {
    await sleep(500);
    file = await readFile(relPath);
    const room = devClient.text.toString();
    consistent = file !== null && file.text === room && room.includes("WS-RACE");
  }
  if (!consistent)
    fail(
      `repo and room never converged after the race: repo=${JSON.stringify(file?.text)} room=${JSON.stringify(devClient.text.toString())}`,
    );
  const health = await fetch(`${SERVER}/healthz`);
  if (!health.ok) fail("server unhealthy after the sha-conflict race");
  const survived = devClient.text.toString().includes("CONFLICT-MARK")
    ? "the competing commit's text was ingested into the room"
    : "the competing commit was superseded in the file (still in git history)";
  ok(`sha-conflict race: no crash, repo == room text (${survived})`);

  const before = (await dev(`/api/documents/${slug}/text`)).json.seq;
  await sleep((POLL_SECS + 2) * 2 * 1000);
  const after = (await dev(`/api/documents/${slug}/text`)).json.seq;
  if (after !== before) fail(`seq moved ${before} → ${after} after the race (echo loop!)`);
  ok("seq stable after the race (no echo loop)");
}

console.log("ALL WORKSPACE + GITHUB-BACKEND CHECKS PASSED");
devClient.provider.destroy();
serverProc.kill("SIGKILL");
process.exit(0);
