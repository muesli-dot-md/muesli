// One-shot real-world validation of the github storage backend against a real Gitea
// instance (creds in <repo>/gitea.json, gitignored: {url, token}; the token has
// write:repository ONLY — it cannot create repos or read /user). Strategy:
//   1. create a throwaway branch muesli-e2e-<epoch> from the default branch
//   2. attach a doc against THAT branch (prefix muesli-e2e/) → edit → verify the commit
//   3. one external commit on the branch → verify poll-ingest into the live room
//   4. DELETE the branch. The default branch is never written.
// If the instance is unreachable or branch-create is forbidden by the token scope, this
// reports SKIP and exits 0 — the compose e2e (workspace-github-e2e.mjs) is the hard gate.
// Usage: node workspace-github-real.mjs   (cargo build first; dex/postgres/redis up)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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
const slug = `gh-real-${Date.now()}`;
const POLL_SECS = 3;
const OWNER = "julianbeaulieu";
const REPO = "muesli";
const BRANCH = `muesli-e2e-${Math.floor(Date.now() / 1000)}`;

const ok = (msg) => console.log(`OK: ${msg}`);
const skip = (msg) => {
  console.log(`SKIP: ${msg}`);
  process.exit(0);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let creds;
try {
  creds = JSON.parse(readFileSync(join(repoRoot, "gitea.json"), "utf8"));
} catch (e) {
  skip(`no usable gitea.json: ${e.message}`);
}
const API = `${creds.url.replace(/\/$/, "")}/api/v1`;

let serverProc = null;
let branchCreated = false;
async function cleanup() {
  if (branchCreated) {
    const r = await forge(`/repos/${OWNER}/${REPO}/branches/${BRANCH}`, { method: "DELETE" });
    console.log(
      r.status === 204
        ? `OK: throwaway branch ${BRANCH} deleted`
        : `WARN: branch delete → ${r.status} ${r.text} (delete ${BRANCH} manually)`,
    );
    branchCreated = false;
  }
  if (serverProc) serverProc.kill("SIGKILL");
}
const fail = async (msg) => {
  console.error(`FAIL: ${msg}`);
  await cleanup();
  process.exit(1);
};
setTimeout(() => {
  console.error("FAIL: global timeout");
  cleanup().finally(() => process.exit(1));
}, 240_000).unref();

async function forge(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `token ${creds.token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

// --- 1. reachability + throwaway branch off the default branch -----------------------
try {
  const v = await fetch(`${API}/version`, { signal: AbortSignal.timeout(8000) });
  if (!v.ok) skip(`instance answered ${v.status} on /version`);
} catch (e) {
  skip(`instance unreachable: ${e.message}`);
}
let defaultBranch;
{
  const r = await forge(`/repos/${OWNER}/${REPO}`);
  if (r.status !== 200) skip(`cannot read repo ${OWNER}/${REPO}: ${r.status} ${r.text}`);
  if (r.json.empty)
    skip(
      `${OWNER}/${REPO} has no commits — a branch cannot be created from an empty default ` +
        `branch, and bootstrapping the first commit would write the default branch (forbidden). ` +
        `Push any initial commit to the repo and re-run.`,
    );
  defaultBranch = r.json.default_branch;
  ok(`instance reachable; ${OWNER}/${REPO} default branch is ${defaultBranch}`);
}
{
  const r = await forge(`/repos/${OWNER}/${REPO}/branches`, {
    method: "POST",
    body: { new_branch_name: BRANCH, old_branch_name: defaultBranch },
  });
  if (r.status === 403 || r.status === 401)
    skip(`branch create forbidden for this token (${r.status}): ${r.text}`);
  if (r.status !== 201) skip(`branch create → ${r.status} ${r.text}`);
  branchCreated = true;
  ok(`throwaway branch ${BRANCH} created from ${defaultBranch}`);
}

// --- 2. server with the real token -----------------------------------------------------
try {
  await fetch(`${SERVER}/healthz`);
  await fail("something is already listening on :8787 — stop it first");
} catch (e) {
  if (e?.exit) throw e;
}
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
    MUESLI_GITHUB_TOKEN: creds.token,
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
    if (serverProc.exitCode !== null)
      await fail(`server exited ${serverProc.exitCode}: ${stderrTail}`);
    try {
      up = (await fetch(`${SERVER}/healthz`)).ok;
    } catch {}
  }
  if (!up) await fail(`server did not come up: ${stderrTail}`);
}
ok(`server up (real token from gitea.json, poll every ${POLL_SECS}s)`);

// --- OIDC login (same dance as workspace-github-e2e.mjs) -------------------------------
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
      if (++hops > 10) await fail("redirect loop");
      url = new URL(res.headers.get("location"), url).toString();
      res = await request(url);
    }
    return { res, url };
  };
  const { res, url } = await follow(`${SERVER}/auth/login`);
  if (!res.ok) await fail(`${email}: login chain ended ${res.status} at ${url}`);
  const { res: after } = await follow(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ login: email, password: "password" }),
  });
  if (!after.ok) await fail(`${email}: login POST failed (${after.status})`);
  const session = jar.get("localhost:8787")?.get("muesli_session");
  if (!session) await fail(`${email}: no session cookie`);
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
const devWs = (await dev("/api/workspaces")).json?.workspaces?.find((w) => w.is_personal)?.id;
if (!devWs) await fail("no personal workspace");

// --- 3. connection against the throwaway branch → attach → edit → commit ---------------
let connId;
{
  const r = await dev(`/api/workspaces/${devWs}/storage`, {
    method: "POST",
    body: {
      kind: "github",
      api_base: API,
      owner: OWNER,
      repo: REPO,
      branch: BRANCH,
      prefix: "muesli-e2e",
    },
  });
  if (r.status !== 200) await fail(`create github connection → ${r.status} ${r.text}`);
  connId = r.json.storage_conn_id;
  ok(`github connection created against ${OWNER}/${REPO}@${BRANCH} (prefix muesli-e2e/)`);
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
const client = connect(devCookie);
await client.synced;
client.text.insert(0, "# Real-instance check\n\nhello from muesli.\n");
await sleep(400);

const relPath = `${slug}.md`;
const repoPath = `muesli-e2e/${relPath}`;
async function readFile() {
  const r = await forge(
    `/repos/${OWNER}/${REPO}/contents/${repoPath}?ref=${encodeURIComponent(BRANCH)}`,
  );
  if (r.status === 404) return null;
  if (r.status !== 200) return fail(`contents GET → ${r.status} ${r.text}`);
  return {
    sha: r.json.sha,
    text: Buffer.from(r.json.content.replace(/\s/g, ""), "base64").toString("utf8"),
  };
}
{
  const r = await dev(`/api/documents/${slug}/storage`, {
    method: "POST",
    body: { storage_conn_id: connId },
  });
  if (r.status !== 200) await fail(`attach → ${r.status} ${r.text}`);
  const file = await readFile();
  if (!file || file.text !== client.text.toString())
    await fail(`attach did not materialize correctly: ${JSON.stringify(file?.text)}`);
  ok("attach materialized to the real repo branch immediately");
}
client.text.insert(client.text.length, "MATERIALIZE-ME\n");
{
  let file = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    file = await readFile();
    if (file?.text.includes("MATERIALIZE-ME")) break;
  }
  if (!file?.text.includes("MATERIALIZE-ME"))
    await fail("edit was not materialized to the branch");
  const commits = await forge(
    `/repos/${OWNER}/${REPO}/commits?sha=${encodeURIComponent(BRANCH)}&limit=20`,
  );
  const messages = (commits.json ?? []).map((c) => c.commit.message.trim());
  if (!messages.includes(`muesli: update ${repoPath}`))
    await fail(`no muesli update commit on the branch: ${JSON.stringify(messages)}`);
  ok(`edit → materialize → commit verified on ${BRANCH}`);
}

// --- 4. one external commit on the branch → poll ingest --------------------------------
{
  const current = await readFile();
  const modified = current.text.replace("hello from muesli.", "hello, edited OUT-OF-BAND.");
  const put = await forge(`/repos/${OWNER}/${REPO}/contents/${repoPath}`, {
    method: "PUT",
    body: {
      content: Buffer.from(modified, "utf8").toString("base64"),
      message: "external edit (muesli real-instance e2e)",
      branch: BRANCH,
      sha: current.sha,
    },
  });
  if (put.status !== 200 && put.status !== 201)
    await fail(`external commit failed: ${put.status} ${put.text}`);
  let seen = false;
  for (let i = 0; i < 40 && !seen; i++) {
    await sleep(500);
    seen = client.text.toString().includes("OUT-OF-BAND");
  }
  if (!seen) await fail("external commit was never ingested into the live room");
  const hist = await dev(`/api/documents/${slug}/history?limit=100`);
  if (!hist.json?.entries?.some((e) => e.origin === "ingest"))
    await fail("no origin=ingest entry in history");
  ok("external commit on the branch was poll-ingested into the live room");
}

console.log("REAL-INSTANCE GITHUB-BACKEND VALIDATION PASSED");
client.provider.destroy();
await cleanup();
process.exit(0);
