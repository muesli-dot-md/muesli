// REAL Google Drive walkthrough (ADR 0013, kind "gdrive") — runs the same attach/edit/
// ingest assertions as gdrive-e2e.mjs against the REAL Google, minus the mocked OAuth
// internals. This script starts NOTHING itself: it expects a muesli-server already
// running on :8787 in OIDC mode with real Google credentials.
//
// ── PREFLIGHT (one-time) ─────────────────────────────────────────────────────────────
//   1. In the Google Cloud Console (the project behind ./muesli.json), add this
//      authorized redirect URI to the OAuth web client:
//          http://localhost:8787/auth/storage/google/callback
//      Until that URI is registered, Google refuses the consent screen
//      (redirect_uri_mismatch) and this script will time out and SKIP.
//   2. docker compose up -d postgres dex redis
//   3. Run the server with real creds (./muesli.json is picked up automatically when
//      the server's cwd is the repo root):
//          set -a; source .env 2>/dev/null; set +a
//          DATABASE_URL=postgres://muesli:muesli@localhost:5433/muesli \
//          REDIS_URL=redis://localhost:6380 \
//          OIDC_ISSUER=http://localhost:5556/dex OIDC_CLIENT_ID=muesli \
//          OIDC_CLIENT_SECRET=muesli-dev-secret MUESLI_STORAGE_POLL_SECS=5 \
//          ./target/debug/muesli-server
//
// The script then prints the /start URL; YOU open it in a browser (after signing into
// http://localhost:8787/auth/login as dev@muesli.md / password) and click through
// Google's consent screen with a real Google account. The script polls for the
// resulting connection (5 min budget; exits 0 with SKIP if the dance never completes),
// then attaches a doc, edits it over ws, verifies the bytes in the real Drive via the
// stored refresh token, rewrites the Drive file out-of-band, and watches the live
// ingest. Requires the compose postgres (to read the refresh token) and ./muesli.json
// (to mint an access token for the out-of-band verification).
// Usage: node gdrive-real.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const SERVER = "http://localhost:8787";
const WS_URL = "ws://localhost:8787/ws";
const slug = `gdrive-real-${Date.now()}`;
const DANCE_BUDGET_MS = 5 * 60_000;

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
const skip = (msg) => {
  console.log(`SKIP: ${msg}`);
  process.exit(0);
};
const ok = (msg) => console.log(`OK: ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`
──────────────────────────────────────────────────────────────────────────────
 REAL Google Drive connector walkthrough
──────────────────────────────────────────────────────────────────────────────
 Preflight checklist (see the header of this script for details):
   [ ] Redirect URI registered on the Google OAuth web client:
         http://localhost:8787/auth/storage/google/callback
   [ ] muesli-server RUNNING on :8787 in OIDC mode with real Google creds
       (./muesli.json or MUESLI_GOOGLE_CLIENT_ID/SECRET) — this script starts nothing
   [ ] docker compose postgres up (the script reads the stored refresh token)
──────────────────────────────────────────────────────────────────────────────
`);

// --- a running server is a precondition, not something we manage --------------------
try {
  const res = await fetch(`${SERVER}/healthz`);
  if (!res.ok) throw new Error(`healthz ${res.status}`);
} catch (e) {
  fail(`no server on ${SERVER} (${e.message}) — start it first (see the checklist above)`);
}
{
  const me = await fetch(`${SERVER}/api/me`).then((r) => r.json());
  if (me.mode !== "oidc") fail("the server is in open mode — restart it with OIDC_* set");
}
ok("server is up in OIDC mode");

// --- cookie-jar OIDC login (dex dev@muesli.md), same helper as the e2e scripts ---------
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
const wsList = await dev("/api/workspaces");
const personal = wsList.json?.workspaces?.find((w) => w.is_personal);
if (!personal) fail(`no personal workspace: ${wsList.text}`);
const devWs = personal.id;
ok(`logged in as dev@muesli.md; workspace ${devWs}`);

// don't re-dance if a connection already exists from an earlier run
const existing = (await dev(`/api/workspaces/${devWs}/storage`)).json?.connections?.find(
  (c) => c.kind === "gdrive",
);
let conn = existing ?? null;
if (conn) {
  ok(`reusing the existing gdrive connection ${conn.id}`);
} else {
  console.log(`
 NOW, IN YOUR BROWSER (the dance needs a human + a real Google account):
   1. open  ${SERVER}/auth/login        and sign in: dev@muesli.md / password
   2. open  ${SERVER}/api/workspaces/${devWs}/storage/google/start
   3. click through Google's consent screen (scope: drive.file only)
   → you should land back on the web origin with ?storage=connected

 Polling for the connection (up to ${DANCE_BUDGET_MS / 60000} min) …
`);
  const deadline = Date.now() + DANCE_BUDGET_MS;
  while (Date.now() < deadline && !conn) {
    await sleep(3000);
    conn = (await dev(`/api/workspaces/${devWs}/storage`)).json?.connections?.find(
      (c) => c.kind === "gdrive",
    );
  }
  if (!conn)
    skip(
      "the OAuth dance never completed within 5 min — most likely the redirect URI " +
        `http://localhost:8787/auth/storage/google/callback is not registered on the ` +
        "Google OAuth client yet (Console → APIs & Services → Credentials).",
    );
  ok(`gdrive connection created: ${conn.id}`);
}
if (!conn.config?.folder_id) fail(`connection has no folder_id: ${JSON.stringify(conn)}`);
if ("refresh_token" in (conn.config ?? {})) fail("refresh_token leaked through the API listing");
ok(`Muesli folder in the user's Drive: ${conn.config.folder_id} (refresh token redacted in API)`);

// --- a Drive client of our own (for verification + the out-of-band write) -------------
// Reads the stored refresh token from postgres and the client creds from muesli.json —
// dev-environment-only conveniences, clearly outside the server's trust boundary.
let driveToken = null;
const driveTokenOrSkip = async () => {
  if (driveToken) return driveToken;
  let refresh, client;
  try {
    refresh = execFileSync(
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
        "muesli",
        "-tA",
        "-c",
        `select config->>'refresh_token' from storage_connections where id = '${conn.id}'`,
      ],
      { cwd: repoRoot, stdio: "pipe" },
    )
      .toString()
      .trim();
    client = JSON.parse(readFileSync(join(repoRoot, "muesli.json"), "utf8")).web;
  } catch (e) {
    skip(
      `cannot self-verify against Drive (${e.message}) — needs compose postgres + ./muesli.json`,
    );
  }
  const res = await fetch(client.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) fail(`refresh-token grant failed: ${res.status} ${await res.text()}`);
  driveToken = (await res.json()).access_token;
  return driveToken;
};
const drive = async (path, opts = {}) => {
  const token = await driveTokenOrSkip();
  const res = await fetch(`https://www.googleapis.com${path}`, {
    ...opts,
    headers: { ...(opts.headers ?? {}), authorization: `Bearer ${token}` },
  });
  return res;
};
const findDriveFile = async (name) => {
  const q = encodeURIComponent(
    `name='${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and '${conn.config.folder_id}' in parents and trashed=false`,
  );
  const res = await drive(`/drive/v3/files?q=${q}&fields=files(id,name,md5Checksum)`);
  if (!res.ok) fail(`drive files.list → ${res.status} ${await res.text()}`);
  return (await res.json()).files[0] ?? null;
};

// --- the same attach/edit/ingest assertions as the mock e2e ----------------------------
function connectWs(cookie) {
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
const client = connectWs(devCookie);
await client.synced;
client.text.insert(0, "# Real Drive Notes\n\nhello from the real-mode script.\n");
await sleep(400);

const relPath = `${slug}.md`;
{
  const r = await dev(`/api/documents/${slug}/storage`, {
    method: "POST",
    body: { storage_conn_id: conn.id },
  });
  if (r.status !== 200) fail(`attach → ${r.status} ${r.text}`);
  if (!r.json.content_hash) fail(`attach did not materialize: ${r.text}`);
  ok(`doc attached and materialized (rel_path ${r.json.rel_path})`);
  const f = await findDriveFile(relPath);
  if (!f) fail(`no file named ${relPath} in the Muesli folder on Drive`);
  const body = await (await drive(`/drive/v3/files/${f.id}?alt=media`)).text();
  if (body !== client.text.toString()) fail(`Drive content differs: ${JSON.stringify(body)}`);
  ok("verified the materialized bytes in the real Drive");
}

client.text.insert(client.text.length, "MATERIALIZE-ME\n");
{
  let body = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const f = await findDriveFile(relPath);
    if (f) body = await (await drive(`/drive/v3/files/${f.id}?alt=media`)).text();
    if (body?.includes("MATERIALIZE-ME")) break;
  }
  if (!body?.includes("MATERIALIZE-ME")) fail("ws edit never reached Drive");
  ok("ws edit landed in the real Drive via the debounced materialize loop");
}

{
  const f = await findDriveFile(relPath);
  const current = await (await drive(`/drive/v3/files/${f.id}?alt=media`)).text();
  const modified = current.replace("hello from", "hello (edited OUT-OF-BAND) from");
  const put = await drive(`/upload/drive/v3/files/${f.id}?uploadType=media`, {
    method: "PATCH",
    headers: { "content-type": "text/markdown" },
    body: modified,
  });
  if (!put.ok) fail(`out-of-band Drive update failed: ${put.status} ${await put.text()}`);
  let seen = false;
  for (let i = 0; i < 60 && !seen; i++) {
    await sleep(1000);
    seen = client.text.toString().includes("OUT-OF-BAND");
  }
  if (!seen) fail("out-of-band Drive edit never reached the live room (poll/ingest)");
  ok("out-of-band Drive edit ingested into the live room (history origin 'ingest')");
}

{
  const before = (await dev(`/api/documents/${slug}/text`)).json.seq;
  await sleep(12_000);
  const after = (await dev(`/api/documents/${slug}/text`)).json.seq;
  if (after !== before) fail(`seq moved ${before} → ${after} with no edits (echo loop!)`);
  ok("no materialize/ingest echo loop (seq stable)");
}

console.log("ALL REAL GOOGLE DRIVE CHECKS PASSED");
client.provider.destroy();
process.exit(0);
