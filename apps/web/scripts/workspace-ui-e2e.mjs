// Integration test for the workspace-management UI's data layer: drives the
// EXACT functions the UI uses (src/workspaceApi.ts, imported directly — node
// 22 strips types) against a live muesli-server in OIDC mode.
//
//   node scripts/workspace-ui-e2e.mjs   (run `cargo build --workspace` first;
//   dex + postgres + redis from docker-compose must be up)
//
// The server runs on :8787 — NOT an arbitrary port — because the dev dex
// instance only allows the redirect_uri registered for localhost:8787, and
// MUESLI_PUBLIC_URL must match it for the OIDC code flow to complete (same
// trick as workspace-s3-e2e.mjs). We verify the port is free first and kill
// our server on exit.
//
// Flow: list workspaces (personal first, admin) → detail shape → rename +
// rename back → invite friend@muesli.md (handles both "added" and "invited",
// claiming the invite via friend's login when needed) → member role change
// round-trip → 409 last-admin guard on self → invite revoke lifecycle →
// documents list + query filter (doc created over ws). Exit nonzero on failure.
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
const slug = `ws-ui-e2e-${Date.now()}`;

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

// --- 0. port 8787 must be free (dex redirect constraint pins us to it) ----------
try {
  const out = execFileSync("lsof", ["-nP", "-iTCP:8787", "-sTCP:LISTEN"], { stdio: "pipe" })
    .toString()
    .trim();
  if (out) fail(`something is already listening on :8787 — stop it first:\n${out}`);
} catch (e) {
  if (e.status !== 1) fail(`lsof check failed: ${e.message}`); // exit 1 = no listeners, good
}
ok("port 8787 is free");

// --- 1. our own server in OIDC mode (env per .env.example) ----------------------
serverProc = spawn(SERVER_BIN, [], {
  env: {
    ...process.env,
    DATABASE_URL: "postgres://muesli:muesli@localhost:5433/muesli",
    REDIS_URL: "redis://localhost:6380",
    OIDC_ISSUER: "http://localhost:5556/dex",
    OIDC_CLIENT_ID: "muesli",
    OIDC_CLIENT_SECRET: "muesli-dev-secret",
    MUESLI_PUBLIC_URL: SERVER,
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
ok("server up on :8787 (OIDC mode)");

// --- 2. cookie-jar OIDC login helper (as workspace-s3-e2e.mjs) -------------------
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

// The UI builds the api with the browser's cookie-carrying fetch; here we
// inject the session cookie into the same code path via fetchFn.
const apiFor = (cookie) =>
  createWorkspaceApi({
    httpBase: SERVER,
    fetchFn: (url, opts = {}) =>
      fetch(url, { ...opts, headers: { ...(opts.headers ?? {}), cookie } }),
  });

const devCookie = await login("dev@muesli.md");
const dev = apiFor(devCookie);
const meRes = await fetch(`${SERVER}/api/me`, { headers: { cookie: devCookie } });
const devUserId = (await meRes.json())?.user?.id;
if (!devUserId) fail("no dev user id from /api/me");
ok("dev logged in");

// --- 3. list workspaces: personal first, admin, summary shape --------------------
let wsId;
{
  const { workspaces } = await dev.listWorkspaces();
  if (!Array.isArray(workspaces) || workspaces.length === 0) fail("no workspaces listed");
  const first = workspaces[0];
  if (!first.is_personal) fail(`personal workspace is not first: ${JSON.stringify(workspaces)}`);
  if (first.role !== "admin") fail(`expected admin on personal workspace, got ${first.role}`);
  for (const k of ["id", "name", "role", "is_personal"]) {
    if (!(k in first)) fail(`workspace summary missing '${k}': ${JSON.stringify(first)}`);
  }
  wsId = first.id;
  ok(`workspaces listed; personal first (${wsId}, admin)`);
}

// --- 4. detail shape (members + invites visible to the admin) ---------------------
let originalName;
{
  const d = await dev.getWorkspace(wsId);
  if (d.id !== wsId) fail(`detail id mismatch: ${d.id}`);
  if (typeof d.name !== "string" || !d.name) fail(`bad detail name: ${JSON.stringify(d)}`);
  if (d.role !== "admin") fail(`detail role should be admin, got ${d.role}`);
  if (!Array.isArray(d.members)) fail("detail.members is not an array");
  const self = d.members.find((m) => m.user_id === devUserId);
  if (!self) fail("self missing from members");
  if (self.role !== "admin") fail(`self role should be admin, got ${self.role}`);
  if (self.email !== "dev@muesli.md") fail(`self email mismatch: ${self.email}`);
  for (const k of ["user_id", "display_name", "email", "kind", "role"]) {
    if (!(k in self)) fail(`member missing '${k}': ${JSON.stringify(self)}`);
  }
  if (!Array.isArray(d.invites)) fail("invites missing from admin's detail view");
  originalName = d.name;
  ok("workspace detail has the expected shape (members + invites)");
}

// --- 5. rename (admin) + rename back ----------------------------------------------
{
  const tmp = `ui-e2e renamed ${Date.now()}`;
  const r = await dev.renameWorkspace(wsId, tmp);
  if (r.name !== tmp) fail(`rename response name mismatch: ${JSON.stringify(r)}`);
  const d = await dev.getWorkspace(wsId);
  if (d.name !== tmp) fail(`rename not reflected in detail: ${d.name}`);
  const { workspaces } = await dev.listWorkspaces();
  if (workspaces.find((w) => w.id === wsId)?.name !== tmp)
    fail("rename not reflected in the list");
  await dev.renameWorkspace(wsId, originalName);
  if ((await dev.getWorkspace(wsId)).name !== originalName) fail("rename-back failed");
  ok("rename works (and was reverted)");
}

// --- 6. invite friend@muesli.md — both statuses are valid --------------------------
// "added" = the user already exists (possibly already a member from earlier e2e
// runs); "invited" = no such user yet, claimed on their first OIDC login.
let friendUserId = null;
{
  const res = await dev.createInvite(wsId, "friend@muesli.md", "member");
  if (res.status === "added") {
    friendUserId = res.user_id;
    ok(`invite → status "added" (friend already a user: ${friendUserId})`);
  } else if (res.status === "invited") {
    const d = await dev.getWorkspace(wsId);
    if (!d.invites.some((i) => i.id === res.invite_id && i.email === "friend@muesli.md"))
      fail("pending invite missing from detail");
    ok('invite → status "invited" (pending row visible to the admin)');
    await login("friend@muesli.md"); // first login claims the invite
    const d2 = await dev.getWorkspace(wsId);
    if (d2.invites.some((i) => i.email === "friend@muesli.md")) fail("claimed invite still pending");
    ok("friend's first login claimed the invite");
  } else {
    fail(`unexpected invite status: ${JSON.stringify(res)}`);
  }
  const d = await dev.getWorkspace(wsId);
  const friend = d.members.find((m) => m.email === "friend@muesli.md");
  if (!friend) fail(`friend missing from members: ${JSON.stringify(d.members)}`);
  friendUserId = friend.user_id;
  ok("friend is a member of the workspace");
}

// --- 7. role change round-trip on friend --------------------------------------------
{
  await dev.setMemberRole(wsId, friendUserId, "admin");
  let d = await dev.getWorkspace(wsId);
  if (d.members.find((m) => m.user_id === friendUserId)?.role !== "admin")
    fail("friend not promoted to admin");
  await dev.setMemberRole(wsId, friendUserId, "member");
  d = await dev.getWorkspace(wsId);
  if (d.members.find((m) => m.user_id === friendUserId)?.role !== "member")
    fail("friend not demoted back to member");
  ok("member role change round-trip (member → admin → member)");
}

// --- 8. last-admin guard: demoting yourself is a 409 ----------------------------------
{
  let caught = null;
  try {
    await dev.setMemberRole(wsId, devUserId, "member");
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof WorkspaceApiError)) fail(`expected WorkspaceApiError, got ${caught}`);
  if (caught.status !== 409) fail(`expected 409 on last-admin demotion, got ${caught.status}`);
  ok("demoting the last admin (self) is rejected with 409");
}

// --- 9. invite lifecycle: create + revoke ----------------------------------------------
{
  const res = await dev.createInvite(wsId, "ghost-ui@muesli.md", "admin");
  if (res.status !== "invited") fail(`ghost invite → ${JSON.stringify(res)}`);
  await dev.revokeInvite(wsId, res.invite_id);
  const d = await dev.getWorkspace(wsId);
  if (d.invites.some((i) => i.email === "ghost-ui@muesli.md")) fail("revoked invite still listed");
  ok("invite revoke works");
}

// --- 10. documents list + query filter (doc created over ws, as the UI notes) -----------
{
  class JarWS extends WebSocket {
    constructor(url, protocols) {
      super(url, protocols, { headers: { cookie: devCookie } });
    }
  }
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(WS_URL, slug, ydoc, {
    WebSocketPolyfill: JarWS,
    disableBc: true,
  });
  providers.push(provider);
  await new Promise((resolve) => provider.on("sync", (s) => s && resolve()));
  ydoc.getText("content").insert(0, `# Workspace UI E2E\n\ncreated by ${slug}\n`);
  await sleep(500);

  const all = await dev.listDocuments();
  const mine = all.documents.find((d) => d.slug === slug);
  if (!mine) fail(`new doc missing from listDocuments(): ${JSON.stringify(all.documents)}`);
  if (mine.workspace_id !== wsId)
    fail(`doc owned by ${mine.workspace_id}, expected ${wsId}`);
  for (const k of ["document_id", "slug", "title", "updated_at", "workspace_id"]) {
    if (!(k in mine)) fail(`document summary missing '${k}': ${JSON.stringify(mine)}`);
  }
  const filtered = await dev.listDocuments(slug);
  if (!filtered.documents.some((d) => d.slug === slug))
    fail("query filter did not return the matching doc");
  const none = await dev.listDocuments(`no-such-doc-${Date.now()}`);
  if (none.documents.some((d) => d.slug === slug))
    fail("query filter returned a non-matching doc");
  ok("documents list + query filter work");
}

// --- 11. cleanup: remove friend so reruns start from a known state -----------------------
{
  await dev.removeMember(wsId, friendUserId);
  const d = await dev.getWorkspace(wsId);
  if (d.members.some((m) => m.user_id === friendUserId)) fail("friend still a member after removal");
  ok("member removal works (friend removed, state reset for reruns)");
}

console.log("ALL WORKSPACE UI CHECKS PASSED");
cleanup();
process.exit(0);
