// Phase 5 enterprise e2e (ADR 0012 "Multi-issuer / per-Workspace IdP" + the audit log,
// migration 0007). Starts its own muesli-server in OIDC mode against the dev Dex pair
// (dex :5556 = primary, dex2 :5558 = the corporate IdP a workspace brings) and drives:
//   1. dev@muesli.md signs in via the PRIMARY issuer (cookie OIDC dance)
//   2. PUT /api/workspaces/{id}/sso registers dex2 on dev's workspace (probed discovery);
//      GET redacts the client_secret (has_client_secret echo, like gdrive tokens)
//   3. /auth/login/select?email=corp@corpdomain.example maps the domain to dex2 and the
//      full code+PKCE dance runs against THAT issuer; corp lands signed in with a
//      personal workspace AND auto-ensured membership in dev's workspace (the invariant)
//   4. share-link create + suggestion accept land in the audit trail
//   5. audit assertions (admin GET): sso config, sso login membership, logins, share,
//      suggestion accept — newest-first with the documented entry shape
//   6. negatives: unknown domain → 404; non-admin PUT sso → 403; non-admin audit → 403
// Usage: node enterprise-e2e.mjs   (run `cargo build --workspace` first; postgres+redis up)
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
const SERVER = "http://localhost:8787";
const WS_URL = "ws://localhost:8787/ws";
const DEX2_ISSUER = "http://localhost:5558/dex";
const CORP_EMAIL = "corp@corpdomain.example";
const slug = `enterprise-e2e-${Date.now()}`;

let serverProc = null;
let providers = [];
const cleanup = () => {
  for (const p of providers) p.destroy();
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

// --- 0. both issuers up (docker compose), port 8787 free --------------------------
execFileSync("docker", ["compose", "up", "-d", "dex", "dex2"], { cwd: repoRoot, stdio: "pipe" });
for (const issuer of ["http://localhost:5556/dex", DEX2_ISSUER]) {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try {
      up = (await fetch(`${issuer}/.well-known/openid-configuration`)).ok;
    } catch {}
    if (!up) await sleep(200);
  }
  if (!up) fail(`issuer did not come up: ${issuer}`);
}
ok("dex (primary) and dex2 (corp) issuers are up");

try {
  const out = execFileSync("lsof", ["-nP", "-iTCP:8787", "-sTCP:LISTEN"], { stdio: "pipe" })
    .toString()
    .trim();
  if (out) fail(`something is already listening on :8787 — stop it first:\n${out}`);
} catch (e) {
  if (e.status !== 1) fail(`lsof check failed: ${e.message}`); // exit 1 = no listeners, good
}

// --- 1. our own server in OIDC mode (primary = dex :5556) --------------------------
serverProc = spawn(SERVER_BIN, [], {
  env: {
    ...process.env,
    DATABASE_URL: "postgres://muesli:muesli@localhost:5433/muesli",
    REDIS_URL: "redis://localhost:6380",
    OIDC_ISSUER: "http://localhost:5556/dex",
    OIDC_CLIENT_ID: "muesli",
    OIDC_CLIENT_SECRET: "muesli-dev-secret",
    MUESLI_PUBLIC_URL: SERVER,
    MUESLI_WEB_ORIGIN: "http://localhost:5173",
    MUESLI_LISTEN: "127.0.0.1:8787",
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
ok("server up on :8787 (OIDC mode, primary issuer dex)");

// --- 2. cookie-jar form walker (as auth-e2e.mjs), parameterized per user ------------
function makeJar() {
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
  return { jar, follow };
}

/// Start at `startUrl` (an /auth/login or /auth/login/select URL), walk to the issuer's
/// password form, submit, and return the muesli session cookie.
async function login(startUrl, email, expectHost) {
  const { jar, follow } = makeJar();
  const { res, url } = await follow(startUrl);
  if (!res.ok) fail(`${email}: login chain ended ${res.status} at ${url}`);
  if (expectHost && !url.includes(expectHost))
    fail(`${email}: expected to land on ${expectHost}, got ${url}`);
  const { res: after, url: finalUrl } = await follow(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ login: email, password: "password" }),
  });
  if (!after.ok) fail(`${email}: login POST chain ended ${after.status} at ${finalUrl}`);
  const session = jar.get("localhost:8787")?.get("muesli_session");
  if (!session) fail(`${email}: no muesli_session cookie after the dance`);
  return `muesli_session=${session}`;
}

const apiFor = (cookie) =>
  createWorkspaceApi({
    httpBase: SERVER,
    fetchFn: (url, opts = {}) =>
      fetch(url, { ...opts, headers: { ...(opts.headers ?? {}), cookie } }),
  });

const devCookie = await login(`${SERVER}/auth/login`, "dev@muesli.md", "5556");
const dev = apiFor(devCookie);
const devMe = (await (await fetch(`${SERVER}/api/me`, { headers: { cookie: devCookie } })).json())
  .user;
if (devMe?.email !== "dev@muesli.md") fail(`dev /api/me: ${JSON.stringify(devMe)}`);
ok("dev signed in via the PRIMARY issuer");

const { workspaces: devWorkspaces } = await dev.listWorkspaces();
const wsId = devWorkspaces.find((w) => w.is_personal)?.id ?? devWorkspaces[0]?.id;
if (!wsId) fail("dev has no workspace");

// --- 3. PUT sso on dev's workspace (probed against dex2) + redaction -----------------
{
  const res = await dev.setSso(wsId, {
    issuer: DEX2_ISSUER,
    client_id: "muesli",
    client_secret: "muesli-dev-secret",
    email_domains: ["corpdomain.example"],
  });
  if (res.issuer !== DEX2_ISSUER) fail(`sso PUT echoed issuer ${res.issuer}`);
  if ("client_secret" in res) fail("sso PUT response leaked the client_secret");
  if (res.has_client_secret !== true) fail("sso PUT response missing has_client_secret");
  ok("workspace SSO configured against dex2 (discovery probe passed)");

  const detail = await dev.getWorkspace(wsId);
  const sso = detail.sso;
  if (!sso) fail("GET workspace (admin) is missing the sso block");
  if (sso.client_secret !== undefined) fail("GET workspace leaked sso.client_secret!");
  if (sso.has_client_secret !== true) fail(`sso redaction wrong: ${JSON.stringify(sso)}`);
  if (sso.issuer !== DEX2_ISSUER || !sso.email_domains?.includes("corpdomain.example"))
    fail(`sso config mangled: ${JSON.stringify(sso)}`);
  ok("GET workspace redacts the client_secret (has_client_secret echo)");

  // a bad issuer must fail the PUT itself with 502, not a later login
  let caught = null;
  try {
    await dev.setSso(wsId, {
      issuer: "http://localhost:9/nowhere",
      client_id: "x",
      client_secret: "y",
      email_domains: ["corpdomain.example"],
    });
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof WorkspaceApiError) || caught.status !== 502)
    fail(`bad issuer should be a 502 at config time, got ${caught?.status ?? caught}`);
  // …and the previous (good) config must be untouched
  if ((await dev.getWorkspace(wsId)).sso?.issuer !== DEX2_ISSUER)
    fail("failed probe clobbered the working sso config");
  ok("unreachable issuer → 502 at config time, working config untouched");
}

// --- 4. negative: unknown email domain → 404 -----------------------------------------
{
  const res = await fetch(`${SERVER}/auth/login/select?email=x@unknown.example`, {
    redirect: "manual",
  });
  if (res.status !== 404) fail(`login/select unknown domain → ${res.status}, expected 404`);
  ok("login/select with an unknown domain → 404");
}

// --- 5. corp signs in via /auth/login/select → dex2 → the invariant -------------------
let corpMe;
{
  const corpCookie = await login(
    `${SERVER}/auth/login/select?email=${encodeURIComponent(CORP_EMAIL)}`,
    CORP_EMAIL,
    "5558", // the dance must run against dex2, not the primary
  );
  corpMe = (await (await fetch(`${SERVER}/api/me`, { headers: { cookie: corpCookie } })).json())
    .user;
  if (corpMe?.email !== CORP_EMAIL) fail(`corp /api/me: ${JSON.stringify(corpMe)}`);
  ok(`corp signed in via dex2; /api/me → ${corpMe.email}`);

  const corp = apiFor(corpCookie);
  const { workspaces } = await corp.listWorkspaces();
  const personal = workspaces.find((w) => w.is_personal);
  if (!personal) fail(`corp has no personal workspace: ${JSON.stringify(workspaces)}`);
  const devWs = workspaces.find((w) => w.id === wsId);
  if (!devWs) fail(`INVARIANT BROKEN: corp is not a member of dev's workspace ${wsId}`);
  if (devWs.role !== "member") fail(`corp should be a plain member, got ${devWs.role}`);
  ok("invariant holds: corp has a personal workspace AND membership in dev's workspace");

  // --- 6. negatives: non-admin PUT sso → 403; non-admin audit → 403 -------------------
  let caught = null;
  try {
    await corp.setSso(wsId, {
      issuer: DEX2_ISSUER,
      client_id: "evil",
      client_secret: "evil",
      email_domains: ["corpdomain.example"],
    });
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof WorkspaceApiError) || caught.status !== 403)
    fail(`non-admin PUT sso should be 403, got ${caught?.status ?? caught}`);

  caught = null;
  try {
    await corp.getAudit(wsId);
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof WorkspaceApiError) || caught.status !== 403)
    fail(`non-admin audit should be 403, got ${caught?.status ?? caught}`);
  ok("non-admin corp: PUT sso → 403, GET audit → 403");
}

// --- 7. drive a share link + a suggestion accept into the audit (as collab-e2e) -------
let documentId;
{
  class CookieWS extends WebSocket {
    constructor(url, protocols) {
      super(url, protocols, { headers: { cookie: devCookie } });
    }
  }
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(WS_URL, slug, ydoc, {
    WebSocketPolyfill: CookieWS,
    disableBc: true,
  });
  providers.push(provider);
  await new Promise((resolve) => provider.on("sync", (s) => s && resolve()));
  const ytext = ydoc.getText("content");
  ytext.insert(0, "# Enterprise\n\nhello audited world\n");
  await sleep(500);

  const api = async (path, { method = "GET", body } = {}) => {
    const res = await fetch(`${SERVER}/api/documents/${slug}${path}`, {
      method,
      headers: { cookie: devCookie, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) fail(`${method} ${path} → ${res.status} ${text}`);
    return JSON.parse(text);
  };

  const share = await api("/share", { method: "POST", body: { role: "viewer" } });
  if (!share.token) fail("share link mint failed");

  const text = ytext.toString();
  const at = text.indexOf("hello");
  const sugg = await api("/suggestions", {
    method: "POST",
    body: { edits: [{ start: at, end: at + 5, insert: "HELLO" }] },
  });
  const accepted = await api(`/suggestions/${sugg.suggestion_ids[0]}/accept`, { method: "POST" });
  if (accepted.status !== "accepted") fail(`suggestion accept: ${JSON.stringify(accepted)}`);

  const docs = await dev.listDocuments(slug);
  documentId = docs.documents.find((d) => d.slug === slug)?.document_id;
  if (!documentId) fail("new doc missing from the documents list");
  ok("share link minted + suggestion accepted on a fresh doc");
}

// --- 8. audit assertions (dev = admin) -------------------------------------------------
{
  // The audit insert is fire-and-forget — give the spawned tasks a beat.
  await sleep(500);
  const { entries } = await dev.getAudit(wsId, { limit: 200 });
  if (!Array.isArray(entries) || entries.length === 0) fail("audit log is empty");
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].id >= entries[i - 1].id) fail("audit entries are not newest-first");
  }
  for (const k of ["id", "action", "actor", "actor_label", "document_id", "detail", "created_at"]) {
    if (!(k in entries[0])) fail(`audit entry missing '${k}': ${JSON.stringify(entries[0])}`);
  }
  const find = (pred, what) => {
    const e = entries.find(pred);
    if (!e) fail(`audit missing: ${what}\n(have: ${[...new Set(entries.map((x) => x.action))].join(", ")})`);
    return e;
  };

  const ssoCfg = find((e) => e.action === "workspace_sso_configured", "workspace_sso_configured");
  if (ssoCfg.detail?.client_secret !== undefined) fail("audit detail leaked the sso client_secret!");
  if (ssoCfg.detail?.issuer !== DEX2_ISSUER) fail(`sso audit detail: ${JSON.stringify(ssoCfg.detail)}`);
  if (ssoCfg.actor?.id !== devMe.id) fail("sso config not attributed to dev");

  const ssoMember = find(
    (e) => e.action === "sso_login_membership" && e.actor?.id === corpMe.id,
    "sso_login_membership (actor corp)",
  );
  if (ssoMember.detail?.issuer !== DEX2_ISSUER)
    fail(`sso_login_membership detail: ${JSON.stringify(ssoMember.detail)}`);

  find(
    (e) => e.action === "login" && e.actor?.id === devMe.id && e.detail?.method === "web",
    "dev's web login",
  );

  const shareEntry = find((e) => e.action === "share_link_created", "share_link_created");
  if (shareEntry.document_id !== documentId)
    fail(`share audit on wrong document: ${shareEntry.document_id}`);
  if (shareEntry.detail?.role !== "viewer") fail(`share audit detail: ${JSON.stringify(shareEntry.detail)}`);

  const acceptEntry = find((e) => e.action === "suggestion_accepted", "suggestion_accepted");
  if (acceptEntry.document_id !== documentId)
    fail(`suggestion audit on wrong document: ${acceptEntry.document_id}`);
  if (acceptEntry.actor?.kind !== "human") fail("suggestion accept actor should be human here");

  find((e) => e.action === "document_created" && e.document_id === documentId, "document_created");
  ok("audit contains: sso config, sso login membership, login, document created, share link, suggestion accept");

  // paging: a tiny limit pages with before_id, no overlap
  const page1 = (await dev.getAudit(wsId, { limit: 2 })).entries;
  if (page1.length !== 2) fail("limit=2 page sizing wrong");
  const page2 = (await dev.getAudit(wsId, { limit: 2, beforeId: page1[1].id })).entries;
  if (page2.length && page2[0].id >= page1[1].id) fail("before_id paging overlaps");
  ok("audit paging via before_id works");
}

// --- 9. cleanup for reruns: drop corp's membership + the sso config --------------------
{
  await dev.removeMember(wsId, corpMe.id);
  await dev.removeSso(wsId);
  const detail = await dev.getWorkspace(wsId);
  if (detail.sso) fail("sso config still present after DELETE");
  if (detail.members.some((m) => m.user_id === corpMe.id)) fail("corp still a member after removal");
  // and the issuer is no longer accepted as a login override
  const res = await fetch(`${SERVER}/auth/login?issuer=${encodeURIComponent(DEX2_ISSUER)}`, {
    redirect: "manual",
  });
  if (res.status !== 404) fail(`deregistered issuer login → ${res.status}, expected 404`);
  ok("cleanup: corp membership removed, sso deleted, issuer deregistered (404 on login)");
}

console.log("ALL ENTERPRISE CHECKS PASSED");
cleanup();
process.exit(0);
