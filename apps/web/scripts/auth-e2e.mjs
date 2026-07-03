// Auth e2e (ADR 0011/0012): drives the full OIDC code+PKCE dance against the dev Dex issuer,
// then proves the authorization seam over the websocket:
//   1. login → session cookie → /api/me
//   2. unauthenticated ws connect is rejected
//   3. authenticated user creates the doc, mints share links
//   4. editor link can write; viewer link's writes are dropped server-side
// Usage: node auth-e2e.mjs <room>
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";

const SERVER = process.env.MUESLI_HTTP ?? "http://localhost:8787";
const WS_URL = process.env.MUESLI_WS ?? "ws://localhost:8787/ws";
const room = process.argv[2] ?? `auth-e2e-${Date.now()}`;

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`OK: ${msg}`);
setTimeout(() => fail("global timeout"), 30_000).unref();

// --- tiny cookie jar (per host) + manual redirect follower -----------------
const jar = new Map(); // host -> Map(name -> value)
function storeCookies(url, res) {
  const host = new URL(url).host;
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (!jar.has(host)) jar.set(host, new Map());
    jar.get(host).set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
function cookieHeader(url) {
  const host = new URL(url).host;
  const m = jar.get(host);
  return m ? [...m].map(([k, v]) => `${k}=${v}`).join("; ") : "";
}
async function request(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    redirect: "manual",
    headers: { ...(opts.headers ?? {}), cookie: cookieHeader(url) },
  });
  storeCookies(url, res);
  return res;
}
async function follow(url, opts = {}) {
  let res = await request(url, opts);
  let hops = 0;
  while ([301, 302, 303, 307].includes(res.status)) {
    if (++hops > 10) fail("redirect loop");
    url = new URL(res.headers.get("location"), url).toString();
    res = await request(url);
  }
  return { res, url };
}

// --- 1. the OIDC dance ------------------------------------------------------
{
  // /auth/login bounces us to Dex; Dex's password connector serves an HTML form.
  const { res, url } = await follow(`${SERVER}/auth/login?next=${encodeURIComponent("http://localhost:5173/#" + room)}`);
  if (!res.ok) fail(`login chain ended ${res.status} at ${url}`);
  if (!url.includes("5556")) fail(`expected to land on dex, got ${url}`);

  // Submit the static credentials to the page we landed on.
  const { res: afterLogin, url: finalUrl } = await follow(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ login: "dev@muesli.md", password: "password" }),
  });
  if (!afterLogin.ok) fail(`login POST chain ended ${afterLogin.status} at ${finalUrl}`);
  const session = jar.get(new URL(SERVER).host)?.get("muesli_session");
  if (!session) fail("no muesli_session cookie after callback");
  ok("oidc login completed, session cookie set");
}

const sessionCookie = `muesli_session=${jar.get(new URL(SERVER).host).get("muesli_session")}`;

// --- 2. /api/me -------------------------------------------------------------
{
  const res = await request(`${SERVER}/api/me`);
  const body = await res.json();
  if (body.mode !== "oidc") fail(`expected oidc mode, got ${body.mode}`);
  if (body.user?.email !== "dev@muesli.md") fail(`unexpected user ${JSON.stringify(body.user)}`);
  ok(`/api/me → ${body.user.email}`);
}

// --- 3. unauthenticated websocket is rejected --------------------------------
await new Promise((resolve) => {
  const sock = new WebSocket(`${WS_URL}/${room}`);
  sock.on("open", () => fail("unauthenticated ws connected (should be 401)"));
  sock.on("unexpected-response", (_req, res) => {
    if (res.statusCode !== 401) fail(`expected 401, got ${res.statusCode}`);
    ok("unauthenticated ws rejected with 401");
    resolve();
  });
  sock.on("error", () => {});
});

// --- helpers for y-websocket connections -------------------------------------
class CookieWS extends WebSocket {
  constructor(url, protocols) {
    super(url, protocols, { headers: { cookie: sessionCookie } });
  }
}
function connect({ withCookie = false, share = null }) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(WS_URL, room, doc, {
    WebSocketPolyfill: withCookie ? CookieWS : WebSocket,
    params: share ? { share } : {},
    // All clients share this process: without this, same-room docs sync locally over
    // BroadcastChannel and bypass the server entirely (false positives).
    disableBc: true,
  });
  const synced = new Promise((resolve) => provider.on("sync", (s) => s && resolve()));
  return { doc, provider, text: doc.getText("content"), synced };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 4. owner connects (creates + owns the doc), mints links ------------------
const owner = connect({ withCookie: true });
await owner.synced;
owner.text.insert(0, "owned by dev\n");
await sleep(300);
ok("authenticated owner connected and wrote");

async function mintLink(role) {
  const res = await fetch(`${SERVER}/api/documents/${room}/share`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: sessionCookie },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) fail(`share(${role}) → ${res.status} ${await res.text()}`);
  return res.json();
}
const editorLink = await mintLink("editor");
const viewerLink = await mintLink("viewer");
ok(`minted links: editor + viewer (${editorLink.url})`);

// --- 5. guest with editor link can write --------------------------------------
const editorGuest = connect({ share: editorLink.token });
await editorGuest.synced;
if (!editorGuest.text.toString().includes("owned by dev")) fail("editor guest did not sync");
editorGuest.text.insert(0, "EDITOR-MARK\n");
await sleep(400);
if (!owner.text.toString().includes("EDITOR-MARK")) fail("editor guest write did not propagate");
ok("editor share link can write");

// --- 6. guest with viewer link syncs but cannot write --------------------------
const viewerGuest = connect({ share: viewerLink.token });
await viewerGuest.synced;
if (!viewerGuest.text.toString().includes("EDITOR-MARK")) fail("viewer guest did not sync");
viewerGuest.text.insert(0, "VIEWER-MARK\n");
await sleep(500);
if (owner.text.toString().includes("VIEWER-MARK")) fail("viewer write reached the room!");
ok("viewer share link write was dropped server-side");

console.log("ALL AUTH CHECKS PASSED");
for (const c of [owner, editorGuest, viewerGuest]) c.provider.destroy();
process.exit(0);
