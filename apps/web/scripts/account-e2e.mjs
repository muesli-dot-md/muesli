// Account settings e2e (docs/design/settings.md): PATCH /api/me profile overrides,
// the /api/me/tokens API-key lifecycle, DELETE workspace storage connections, and
// GET /api/meta. Starts its OWN muesli-server on :8796 against its OWN scratch
// Postgres database (dex + postgres + redis + minio from docker-compose must be up) —
// the dev server on :8787 and its database are never touched.
//
// Sessions: dex's redirectURIs only allow :8787, so the browser dance cannot run
// against :8796. Instead users are created via the dex password grant → /api/cli/login
// (the folders-e2e pattern), and a SESSION is injected directly into the shared redis
// session store (muesli:session:<token> → user_id) — exactly what /auth/callback
// would have written.
//
//   1.  /api/meta is unauthenticated: {version, mode:"oidc"}
//   2.  PATCH /api/me: set display_name + avatar override; bad avatars → 400;
//       a re-login (claim refresh) does NOT clobber the override; null clears it
//   3.  agent principals (Bearer) are rejected from every /api/me* mutation (403)
//   4.  mint key (preset scopes + expiry) → mua_ secret works as a Bearer; bad
//       presets/labels/expiries → 400; revoke kills it immediately; 404-hide for
//       foreign/unknown ids (friend cannot revoke dev's key)
//   5.  storage: list carries google:{configured:false}; DELETE connection works,
//       409 {attached_documents:n} while a document references it, member-of-nothing
//       callers get 403
// Usage: node account-e2e.mjs   (run `cargo build --workspace` first)
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const SERVER_BIN = join(repoRoot, "target", "debug", "muesli-server");
const SERVER = "http://localhost:8796";
const DEX = "http://localhost:5556/dex";
const run = Date.now();
const slug = `account-e2e-${run}`;

let serverProc = null;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  if (serverProc) serverProc.kill("SIGKILL");
  process.exit(1);
};
const ok = (msg) => console.log(`OK: ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => fail("global timeout"), 120_000).unref();

// --- prerequisites ------------------------------------------------------------------
try {
  await fetch(`${SERVER}/healthz`);
  fail("something is already listening on :8796 — stop it first");
} catch {}
try {
  execFileSync("docker", ["compose", "up", "-d", "--wait", "minio"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("docker", ["compose", "up", "-d", "minio-init"], { cwd: repoRoot, stdio: "pipe" });
} catch (e) {
  fail(`docker compose up minio failed: ${e.message}`);
}

// Own scratch database, recreated per run (the dev DB is never touched).
const TEST_DB = "muesli_account_e2e";
function psql(db, sql, args = []) {
  return execFileSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-U", "muesli", "-d", db, "-v", "ON_ERROR_STOP=1", ...args, "-c", sql],
    { cwd: repoRoot, stdio: "pipe" },
  ).toString();
}
try {
  psql("muesli", `drop database if exists ${TEST_DB} with (force)`);
} catch (e) {
  fail(`dropping ${TEST_DB} failed: ${e.stderr}`);
}
psql("muesli", `create database ${TEST_DB}`);
ok(`scratch database ${TEST_DB} ready`);

// --- server lifecycle (cwd OUTSIDE the repo: dotenvy walks parents for .env) ---------
const env = {
  ...process.env,
  DATABASE_URL: `postgres://muesli:muesli@localhost:5433/${TEST_DB}`,
  REDIS_URL: "redis://localhost:6380",
  OIDC_ISSUER: DEX,
  OIDC_CLIENT_ID: "muesli",
  OIDC_CLIENT_SECRET: "muesli-dev-secret",
  MUESLI_PUBLIC_URL: SERVER,
  MUESLI_WEB_ORIGIN: "http://localhost:5173",
  MUESLI_LISTEN: "127.0.0.1:8796",
  MUESLI_S3_ACCESS_KEY: "muesli",
  MUESLI_S3_SECRET_KEY: "muesli-dev-secret",
  RUST_LOG: "muesli_server=info",
};
// google.configured must read false: scrub any Drive client config from the env.
delete env.MUESLI_GOOGLE_CLIENT_ID;
delete env.MUESLI_GOOGLE_CLIENT_SECRET;
delete env.MUESLI_GOOGLE_CLIENT_FILE;
serverProc = spawn(SERVER_BIN, [], { env, cwd: tmpdir(), stdio: ["ignore", "ignore", "pipe"] });
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
ok("server up on :8796 (oidc mode, scratch db)");

// --- helpers --------------------------------------------------------------------------
async function dexIdToken(email) {
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
  if (!body.id_token) fail(`dex password grant (${email}) returned no id_token: ${JSON.stringify(body)}`);
  return body.id_token;
}

/// dex grant → /api/cli/login: creates/refreshes the human user (the OIDC upsert) and
/// mints a delegated agent Bearer token. Returns { token, agent }.
async function cliLogin(email, label) {
  const res = await fetch(`${SERVER}/api/cli/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id_token: await dexIdToken(email), label }),
  });
  if (!res.ok) fail(`/api/cli/login (${email}) → ${res.status} ${await res.text()}`);
  return res.json();
}

function userId(email) {
  const out = psql(TEST_DB, `select id from users where kind = 'human' and email = '${email}'`, ["-t", "-A"]).trim();
  if (!/^[0-9a-f-]{36}$/.test(out)) fail(`could not resolve user id for ${email}: ${out}`);
  return out;
}

/// What /auth/callback would have done, minus the dex redirect that :8796 cannot run:
/// write a session token into the redis store the server reads.
function injectSession(uid) {
  const token = randomBytes(32).toString("hex");
  const out = execFileSync(
    "docker",
    ["compose", "exec", "-T", "redis", "redis-cli", "SET", `muesli:session:${token}`, uid, "EX", "900"],
    { cwd: repoRoot, stdio: "pipe" },
  ).toString();
  if (!out.includes("OK")) fail(`session inject failed: ${out}`);
  return `muesli_session=${token}`;
}

function apiFor(headers) {
  return async (path, { method = "GET", body } = {}) => {
    const res = await fetch(`${SERVER}${path}`, {
      method,
      headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text };
  };
}

// --- 1. /api/meta is public ------------------------------------------------------------
{
  const res = await fetch(`${SERVER}/api/meta`);
  if (!res.ok) fail(`GET /api/meta → ${res.status}`);
  const meta = await res.json();
  if (!/^\d+\.\d+\.\d+/.test(meta.version ?? "")) fail(`bad version in ${JSON.stringify(meta)}`);
  if (meta.mode !== "oidc") fail(`expected mode oidc, got ${meta.mode}`);
  if (!("commit" in meta)) fail("meta carries no commit field");
  ok(`/api/meta → v${meta.version} (mode ${meta.mode}), no auth required`);
}

// --- users: dev (with session + agent bearer) and friend (session) ----------------------
const { token: cliToken } = await cliLogin("dev@muesli.md", "account-e2e-cli");
if (!cliToken.startsWith("mua_")) fail(`expected a mua_ token, got ${cliToken}`);
const devId = userId("dev@muesli.md");
const dev = apiFor({ cookie: injectSession(devId) });
const devBearer = apiFor({ authorization: `Bearer ${cliToken}` });
await cliLogin("friend@muesli.md", "account-e2e-friend-cli");
const friend = apiFor({ cookie: injectSession(userId("friend@muesli.md")) });

let claimName;
{
  const me = await dev("/api/me");
  if (me.status !== 200 || me.json.user?.email !== "dev@muesli.md")
    fail(`session /api/me → ${me.status} ${me.text}`);
  claimName = me.json.user.display_name;
  ok(`injected session works: /api/me → ${me.json.user.email} (claim name "${claimName}")`);
}

// --- 2. PATCH /api/me — profile overrides ------------------------------------------------
{
  const empty = await dev("/api/me", { method: "PATCH", body: {} });
  if (empty.status !== 400) fail(`empty PATCH /api/me → ${empty.status} (want 400)`);

  const set = await dev("/api/me", { method: "PATCH", body: { display_name: "  Account E2E Custom  " } });
  if (set.status !== 200 || set.json.display_name !== "Account E2E Custom")
    fail(`PATCH display_name → ${set.status} ${set.text}`);
  const me = await dev("/api/me");
  if (me.json.user.display_name !== "Account E2E Custom") fail("GET /api/me does not reflect the override");
  ok("display_name override set (trimmed) and visible via GET /api/me");

  const avatar = "data:image/webp;base64," + "A".repeat(400);
  const av = await dev("/api/me", { method: "PATCH", body: { avatar_url: avatar } });
  if (av.status !== 200 || av.json.avatar_url !== avatar) fail(`PATCH avatar → ${av.status} ${av.text}`);
  for (const [bad, why] of [
    ["https://cdn.example/me.png", "plain url"],
    ["data:image/svg+xml;base64,AAAA", "svg"],
    ["data:image/webp;base64," + "A".repeat(65 * 1024), "oversize"],
  ]) {
    const r = await dev("/api/me", { method: "PATCH", body: { avatar_url: bad } });
    if (r.status !== 400) fail(`bad avatar (${why}) → ${r.status} (want 400)`);
  }
  const tooLong = await dev("/api/me", { method: "PATCH", body: { display_name: "x".repeat(121) } });
  if (tooLong.status !== 400) fail(`121-char display_name → ${tooLong.status} (want 400)`);
  ok("avatar data-URL accepted; plain-url/svg/oversize avatars and long names → 400");

  // The coalesce trap: a fresh login refreshes the claim columns; the override survives.
  await cliLogin("dev@muesli.md", "account-e2e-relogin");
  const after = await dev("/api/me");
  if (after.json.user.display_name !== "Account E2E Custom")
    fail(`re-login clobbered the override: ${after.text}`);
  ok("override survives a re-login (claim refresh does not clobber it)");

  const clear = await dev("/api/me", { method: "PATCH", body: { display_name: null, avatar_url: null } });
  if (clear.status !== 200 || clear.json.display_name !== claimName)
    fail(`clearing overrides → ${clear.status} ${clear.text} (want claim name "${claimName}")`);
  ok("null clears the overrides back to the IdP claims");
}

// --- 3. agents are rejected from account mutations ---------------------------------------
{
  for (const [path, opts] of [
    ["/api/me", { method: "PATCH", body: { display_name: "agent says hi" } }],
    ["/api/me/tokens", {}],
    ["/api/me/tokens", { method: "POST", body: { label: "x", scopes: ["read"] } }],
  ]) {
    const r = await devBearer(path, opts);
    if (r.status !== 403) fail(`bearer ${opts.method ?? "GET"} ${path} → ${r.status} (want 403)`);
  }
  const anon = await apiFor({})("/api/me/tokens");
  if (anon.status !== 401) fail(`anonymous GET /api/me/tokens → ${anon.status} (want 401)`);
  ok("agent principals → 403, anonymous → 401 on /api/me* endpoints");
}

// --- 4. API-key lifecycle -----------------------------------------------------------------
let mintedId;
{
  const list = await dev("/api/me/tokens");
  if (list.status !== 200) fail(`GET /api/me/tokens → ${list.status} ${list.text}`);
  const cli = list.json.tokens.find((t) => t.label === "account-e2e-cli");
  if (!cli) fail(`cli token missing from the list: ${list.text}`);
  if (cli.expires_at !== null) fail("cli token should never expire");
  if (JSON.stringify([...cli.scopes].sort()) !== '["read","write"]') fail(`cli scopes ${cli.scopes}`);
  if (list.text.includes("token_hash") || list.text.includes("mua_")) fail("list leaks secrets");
  ok(`token list shows the cli key (scopes ${cli.scopes}, no secrets)`);

  const mint = await dev("/api/me/tokens", {
    method: "POST",
    body: { label: "  e2e key  ", scopes: ["read"], expires_in_days: 30 },
  });
  if (mint.status !== 200) fail(`mint → ${mint.status} ${mint.text}`);
  if (!mint.json.token?.startsWith("mua_")) fail(`mint returned no mua_ secret: ${mint.text}`);
  if (mint.json.label !== "e2e key") fail(`mint label ${mint.json.label}`);
  const days = (new Date(mint.json.expires_at) - Date.now()) / 86_400_000;
  if (!(days > 29 && days < 31)) fail(`expires_at ${mint.json.expires_at} is not ~30 days out`);
  mintedId = mint.json.id;
  const asKey = await apiFor({ authorization: `Bearer ${mint.json.token}` })("/api/me");
  if (asKey.json.user?.display_name !== "e2e key" || asKey.json.user?.id === devId)
    fail(`minted key does not authenticate as its agent: ${asKey.text}`);
  ok("minted a 30-day read key; the secret authenticates as the agent identity");

  for (const [body, why] of [
    [{ label: "x", scopes: ["admin"] }, "non-preset scope"],
    [{ label: "x", scopes: ["write"] }, "write-only"],
    [{ label: "x", scopes: [] }, "no scopes"],
    [{ label: "   ", scopes: ["read"] }, "blank label"],
    [{ label: "x", scopes: ["read"], expires_in_days: 0 }, "zero expiry"],
    [{ label: "x", scopes: ["read"], expires_in_days: -3 }, "negative expiry"],
  ]) {
    const r = await dev("/api/me/tokens", { method: "POST", body });
    if (r.status !== 400) fail(`mint with ${why} → ${r.status} (want 400)`);
  }
  ok("invalid mint requests (scopes/label/expiry) → 400");

  const revoke = await dev(`/api/me/tokens/${mintedId}`, { method: "DELETE" });
  if (revoke.status !== 204) fail(`revoke → ${revoke.status} ${revoke.text}`);
  const dead = await apiFor({ authorization: `Bearer ${mint.json.token}` })("/api/me");
  if (dead.json.user !== null) fail(`revoked key still authenticates: ${dead.text}`);
  const after = await dev("/api/me/tokens");
  if (after.json.tokens.some((t) => t.id === mintedId)) fail("revoked key still listed");
  const again = await dev(`/api/me/tokens/${mintedId}`, { method: "DELETE" });
  if (again.status !== 404) fail(`double revoke → ${again.status} (want 404)`);
  ok("revoke kills the key immediately; re-revoke → 404");

  const cliId = cli.id;
  const foreign = await friend(`/api/me/tokens/${cliId}`, { method: "DELETE" });
  if (foreign.status !== 404) fail(`friend revoking dev's key → ${foreign.status} (want 404, hidden)`);
  const ghost = await dev(`/api/me/tokens/00000000-0000-7000-8000-000000000000`, { method: "DELETE" });
  if (ghost.status !== 404) fail(`unknown id → ${ghost.status} (want 404)`);
  ok("owner-scoping hides foreign/unknown key ids behind 404");
}

// --- 5. storage connections: readiness flag + disconnect -----------------------------------
{
  const ws = (await dev("/api/workspaces")).json.workspaces.find((w) => w.is_personal);
  if (!ws) fail("dev has no personal workspace");

  const empty = await dev(`/api/workspaces/${ws.id}/storage`);
  if (empty.status !== 200) fail(`GET storage → ${empty.status} ${empty.text}`);
  if (empty.json.google?.configured !== false)
    fail(`expected google.configured === false, got ${empty.text}`);
  ok("storage list carries google: {configured: false} (no Drive client on this server)");

  const mkConn = () =>
    dev(`/api/workspaces/${ws.id}/storage`, {
      method: "POST",
      body: { kind: "s3", endpoint: "http://localhost:9000", bucket: "muesli-dev", prefix: `account-e2e/${run}` },
    });
  let conn = await mkConn();
  if (conn.status !== 200) fail(`create s3 conn → ${conn.status} ${conn.text}`);
  const del = await dev(`/api/workspaces/${ws.id}/storage/${conn.json.storage_conn_id}`, { method: "DELETE" });
  if (del.status !== 200 || del.json.deleted !== true) fail(`disconnect → ${del.status} ${del.text}`);
  if ((await dev(`/api/workspaces/${ws.id}/storage`)).json.connections.length !== 0)
    fail("connection still listed after disconnect");
  ok("unreferenced connection disconnects cleanly");

  conn = await mkConn();
  const connId = conn.json.storage_conn_id;
  // POST share creates the document (ensure_document_owned) without a websocket.
  const share = await dev(`/api/documents/${slug}/share`, { method: "POST", body: { role: "viewer" } });
  if (share.status !== 200) fail(`create doc via share → ${share.status} ${share.text}`);
  const attach = await dev(`/api/documents/${slug}/storage`, { method: "POST", body: { storage_conn_id: connId } });
  if (attach.status !== 200) fail(`attach → ${attach.status} ${attach.text}`);

  const blocked = await dev(`/api/workspaces/${ws.id}/storage/${connId}`, { method: "DELETE" });
  if (blocked.status !== 409 || blocked.json.attached_documents !== 1)
    fail(`disconnect with attached doc → ${blocked.status} ${blocked.text} (want 409 {attached_documents:1})`);
  ok("disconnect with an attached document → 409 {attached_documents: 1}");

  const notMember = await friend(`/api/workspaces/${ws.id}/storage/${connId}`, { method: "DELETE" });
  if (notMember.status !== 403) fail(`non-member disconnect → ${notMember.status} (want 403)`);
  ok("non-members cannot disconnect (403)");

  const purge = await dev(`/api/documents/${slug}/purge`, { method: "DELETE" });
  if (purge.status !== 200) fail(`purge → ${purge.status} ${purge.text}`);
  const freed = await dev(`/api/workspaces/${ws.id}/storage/${connId}`, { method: "DELETE" });
  if (freed.status !== 200) fail(`disconnect after purge → ${freed.status} ${freed.text}`);
  ok("disconnect succeeds once the document is gone");
}

console.log("ALL ACCOUNT SETTINGS CHECKS PASSED");
serverProc.kill("SIGKILL");
process.exit(0);
