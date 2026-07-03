// Settings-UI data-layer e2e: drives the EXACT functions the settings page uses
// (src/accountApi.ts + the storage methods on src/workspaceApi.ts, imported
// directly — node 22 strips types) against a live muesli-server in OIDC mode.
//
// Starts its OWN server on :8797 against its OWN scratch Postgres database
// (dex + postgres + redis + minio from docker-compose must be up) — the dev
// server on :8787 and its database are never touched. Sessions are injected
// into the redis store (the account-e2e.mjs pattern; dex's redirectURIs pin
// the browser dance to :8787, which this port can't run).
//
//   1. getMeta() — unauthenticated version probe (About section)
//   2. patchMe() — display-name override set / clear (null), avatar data-URL
//      set, 400 surfaces as AccountApiError{status:400} (bad avatar)
//   3. mintToken() → the raw mua_ secret authenticates as a Bearer;
//      listTokens() carries the row; revokeToken() kills it (Bearer → 401,
//      list empties); foreign id → AccountApiError 404
//   4. listStorageConnections() → google:{configured:false} (env scrubbed);
//      createStorageConnection() s3 against minio (the StorageS3Form path);
//      deleteStorageConnection() removes it
//
// Usage: node scripts/settings-ui-e2e.mjs   (run `cargo build --workspace` first)
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createAccountApi, AccountApiError } from "../src/accountApi.ts";
import { createWorkspaceApi, WorkspaceApiError } from "../src/workspaceApi.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const SERVER_BIN = join(repoRoot, "target", "debug", "muesli-server");
const SERVER = "http://localhost:8797";
const DEX = "http://localhost:5556/dex";

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
  fail("something is already listening on :8797 — stop it first");
} catch {}
try {
  execFileSync("docker", ["compose", "up", "-d", "--wait", "minio"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("docker", ["compose", "up", "-d", "minio-init"], { cwd: repoRoot, stdio: "pipe" });
} catch (e) {
  fail(`docker compose up minio failed: ${e.message}`);
}

// Own scratch database, recreated per run (the dev DB is never touched).
const TEST_DB = "muesli_settings_ui_e2e";
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
  MUESLI_LISTEN: "127.0.0.1:8797",
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
ok("server up on :8797 (oidc mode, scratch db)");

// --- session plumbing (account-e2e.mjs pattern) -----------------------------------------
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
  if (!body.id_token) fail(`dex password grant (${email}) returned no id_token`);
  return body.id_token;
}

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

// The UI builds these apis with the browser's cookie-carrying fetch; here we
// inject the session cookie into the SAME code paths via fetchFn.
const apisFor = (cookie) => {
  const fetchFn = (url, opts = {}) =>
    fetch(url, { ...opts, headers: { ...(opts.headers ?? {}), cookie } });
  return {
    account: createAccountApi({ httpBase: SERVER, fetchFn }),
    workspace: createWorkspaceApi({ httpBase: SERVER, fetchFn }),
  };
};

await cliLogin("dev@muesli.md", "settings-ui-e2e-cli");
const dev = apisFor(injectSession(userId("dev@muesli.md")));
await cliLogin("friend@muesli.md", "settings-ui-e2e-friend");
const friend = apisFor(injectSession(userId("friend@muesli.md")));

// --- 1. getMeta -----------------------------------------------------------------------
{
  const anonymous = createAccountApi({ httpBase: SERVER });
  const meta = await anonymous.getMeta();
  if (!/^\d+\.\d+\.\d+/.test(meta.version)) fail(`bad meta.version: ${JSON.stringify(meta)}`);
  if (meta.mode !== "oidc") fail(`expected mode oidc, got ${meta.mode}`);
  ok(`getMeta() → v${meta.version}, mode ${meta.mode}`);
}

// --- 2. patchMe: override set / clear / 400 ---------------------------------------------
{
  const set = await dev.account.patchMe({ display_name: "  Ada Override  " });
  if (set.display_name !== "Ada Override") fail(`override not trimmed/applied: ${set.display_name}`);
  const avatar = `data:image/webp;base64,${"A".repeat(128)}`;
  const withAvatar = await dev.account.patchMe({ avatar_url: avatar });
  if (withAvatar.avatar_url !== avatar) fail("avatar override not applied");
  if (withAvatar.display_name !== "Ada Override") fail("display_name lost on avatar-only patch (absent ≠ null broken)");
  const cleared = await dev.account.patchMe({ display_name: null, avatar_url: null });
  if (cleared.display_name === "Ada Override") fail("null did not clear the override");
  try {
    await dev.account.patchMe({ avatar_url: "https://cdn.example/me.png" });
    fail("non-data-URL avatar was accepted");
  } catch (e) {
    if (!(e instanceof AccountApiError) || e.status !== 400) fail(`expected AccountApiError 400, got ${e}`);
  }
  ok("patchMe(): set (trimmed), absent-keeps, null-clears, bad avatar → AccountApiError 400");
}

// --- 3. token lifecycle ------------------------------------------------------------------
{
  const before = (await dev.account.listTokens()).tokens.length;
  const minted = await dev.account.mintToken({
    label: "settings-ui key",
    scopes: ["read", "write"],
    expires_in_days: 90,
  });
  if (!minted.token.startsWith("mua_")) fail(`expected mua_ secret, got ${minted.token.slice(0, 8)}…`);
  if (!minted.expires_at) fail("expires_at missing on a 90-day key");

  const asAgent = await fetch(`${SERVER}/api/me`, { headers: { authorization: `Bearer ${minted.token}` } });
  const agentMe = await asAgent.json();
  if (!asAgent.ok || !agentMe.user) fail(`minted Bearer does not authenticate: ${asAgent.status}`);

  const listed = (await dev.account.listTokens()).tokens;
  if (listed.length !== before + 1) fail(`expected ${before + 1} tokens, got ${listed.length}`);
  const row = listed.find((t) => t.id === minted.id);
  if (!row || row.label !== "settings-ui key") fail(`minted key missing from listTokens(): ${JSON.stringify(listed)}`);
  if (JSON.stringify([...row.scopes].sort()) !== '["read","write"]') fail(`bad scopes: ${row.scopes}`);

  try {
    await friend.account.revokeToken(minted.id);
    fail("friend revoked dev's key");
  } catch (e) {
    if (!(e instanceof AccountApiError) || e.status !== 404) fail(`expected 404-hide, got ${e}`);
  }
  await dev.account.revokeToken(minted.id);
  const after = (await dev.account.listTokens()).tokens;
  if (after.some((t) => t.id === minted.id)) fail("revoked key still listed");
  const revokedBearer = await fetch(`${SERVER}/api/me/tokens`, { headers: { authorization: `Bearer ${minted.token}` } });
  if (revokedBearer.status !== 401 && revokedBearer.status !== 403) {
    fail(`revoked Bearer still works: ${revokedBearer.status}`);
  }
  ok("mintToken()/listTokens()/revokeToken(): full lifecycle, 404-hide across owners");
}

// --- 4. storage connections through workspaceApi ------------------------------------------
{
  const { workspaces } = await dev.workspace.listWorkspaces();
  const personal = workspaces[0];
  if (!personal?.is_personal || personal.role !== "admin") {
    fail(`expected personal admin workspace first: ${JSON.stringify(workspaces)}`);
  }

  const empty = await dev.workspace.listStorageConnections(personal.id);
  if (empty.google?.configured !== false) fail(`expected google.configured:false, got ${JSON.stringify(empty.google)}`);

  // The exact StorageS3Form submit path, against the compose minio.
  const created = await dev.workspace.createStorageConnection(personal.id, {
    kind: "s3",
    endpoint: "http://localhost:9000",
    bucket: "muesli-dev",
    prefix: `settings-ui-e2e-${Date.now()}/`,
  });
  if (!created.storage_conn_id) fail(`create returned no id: ${JSON.stringify(created)}`);

  const listed = await dev.workspace.listStorageConnections(personal.id);
  if (!listed.connections.some((c) => c.id === created.storage_conn_id && c.kind === "s3")) {
    fail(`created connection missing from list: ${JSON.stringify(listed.connections)}`);
  }

  // A probed-at-create bad endpoint maps to 502 (the form's inline error path).
  try {
    await dev.workspace.createStorageConnection(personal.id, {
      kind: "s3",
      endpoint: "http://localhost:9", // nothing listens here
      bucket: "muesli-dev",
    });
    fail("unreachable endpoint was accepted");
  } catch (e) {
    if (!(e instanceof WorkspaceApiError) || e.status !== 502) fail(`expected 502, got ${e}`);
  }

  const del = await dev.workspace.deleteStorageConnection(personal.id, created.storage_conn_id);
  if (del?.deleted !== true) fail(`delete answered ${JSON.stringify(del)}`);
  const gone = await dev.workspace.listStorageConnections(personal.id);
  if (gone.connections.some((c) => c.id === created.storage_conn_id)) fail("connection survived delete");
  ok("listStorageConnections()/createStorageConnection()/deleteStorageConnection(): attach (probed), 502 inline error, disconnect");
}

serverProc.kill("SIGKILL");
psql("muesli", `drop database if exists ${TEST_DB} with (force)`);
console.log("settings-ui-e2e: all checks passed");
process.exit(0);
