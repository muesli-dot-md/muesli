// MCP façade e2e (ADR 0008/0007; docs/design/mcp-and-agent-auth.md). Starts its own
// muesli-server in OIDC mode (dex + postgres + redis from docker-compose must be up),
// mints a real mua_ delegated agent token, and drives POST /mcp end to end:
//   1. protocol plumbing: 405 on GET, 401 unauthenticated, initialize/ping/notifications,
//      unknown method → JSON-RPC error, tools/list exposes the full surface
//   2. create_document + edit_document(direct, anchor_text) → attributed agent history
//   3. ambiguous anchor_text and stale base_seq are clear tool errors, never guesses
//   4. suggest-when-co-present: a live human downgrades direct → suggest (doc untouched)
//   5. gated actions: accept/resolve are policy-disabled until MUESLI_AGENT_GATED_ACTIONS=true
//      (server restart), then accepting applies the suggestion
//   6. MUESLI_AGENT_DIRECT=always pins direct despite co-presence, and the human sees the
//      synthetic "agent" awareness entry while the edit lands
//   7. the `muesli mcp` stdio proxy forwards JSON-RPC lines with the stored token
// Usage: node mcp-e2e.mjs   (run `cargo build --workspace` first)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const SERVER_BIN = join(repoRoot, "target", "debug", "muesli-server");
const CLI_BIN = join(repoRoot, "target", "debug", "muesli");
const SERVER = "http://localhost:8787";
const WS_URL = "ws://localhost:8787/ws";
const DEX = "http://localhost:5556/dex";
const slug = `mcp-e2e-${Date.now()}`;

let serverProc = null;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  if (serverProc) serverProc.kill("SIGKILL");
  process.exit(1);
};
const ok = (msg) => console.log(`OK: ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => fail("global timeout"), 120_000).unref();

// --- server lifecycle ---------------------------------------------------------
const BASE_ENV = {
  DATABASE_URL: "postgres://muesli:muesli@localhost:5433/muesli",
  REDIS_URL: "redis://localhost:6380", // sessions survive the mid-test restart
  OIDC_ISSUER: DEX,
  OIDC_CLIENT_ID: "muesli",
  OIDC_CLIENT_SECRET: "muesli-dev-secret",
  MUESLI_PUBLIC_URL: SERVER,
  MUESLI_WEB_ORIGIN: "http://localhost:5173",
  MUESLI_LISTEN: "127.0.0.1:8787",
  RUST_LOG: "muesli_server=info",
};
async function startServer(extraEnv = {}) {
  const proc = spawn(SERVER_BIN, [], {
    env: { ...process.env, ...BASE_ENV, ...extraEnv },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderrTail = "";
  proc.stderr.on("data", (c) => (stderrTail = (stderrTail + c.toString()).slice(-4000)));
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (proc.exitCode !== null) fail(`server exited ${proc.exitCode}: ${stderrTail}`);
    try {
      const res = await fetch(`${SERVER}/healthz`);
      if (res.ok) return proc;
    } catch {}
  }
  fail(`server did not come up: ${stderrTail}`);
}
async function stopServer(proc) {
  proc.kill("SIGKILL");
  await new Promise((r) => proc.on("exit", r));
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${SERVER}/healthz`);
      await sleep(100);
    } catch {
      return; // port released
    }
  }
}

serverProc = await startServer();
ok("server up (OIDC mode, gated actions off)");

// --- a human session (cookie OIDC dance, as collab-e2e.mjs) --------------------
const jar = new Map();
function cookieHeader(url) {
  const m = jar.get(new URL(url).host);
  return m ? [...m].map(([k, v]) => `${k}=${v}`).join("; ") : "";
}
async function request(url, opts = {}) {
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
{
  const { res, url } = await follow(`${SERVER}/auth/login`);
  if (!res.ok) fail(`login chain ended ${res.status} at ${url}`);
  const { res: after } = await follow(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ login: "dev@muesli.md", password: "password" }),
  });
  if (!after.ok) fail(`login POST failed (${after.status})`);
  if (!jar.get("localhost:8787")?.get("muesli_session")) fail("no session cookie");
  ok("human OIDC session established");
}
const sessionCookie = `muesli_session=${jar.get("localhost:8787").get("muesli_session")}`;

// --- a real mua_ delegated agent token (dex password grant → /api/cli/login) ----
let token;
{
  const res = await fetch(`${DEX}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "muesli-cli",
      scope: "openid email profile",
      username: "dev@muesli.md",
      password: "password",
    }),
  });
  const body = await res.json();
  if (!body.id_token) fail(`dex password grant returned no id_token: ${JSON.stringify(body)}`);
  const login = await fetch(`${SERVER}/api/cli/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id_token: body.id_token, label: "mcp-e2e" }),
  });
  if (!login.ok) fail(`/api/cli/login → ${login.status} ${await login.text()}`);
  ({ token } = await login.json());
  if (!token?.startsWith("mua_")) fail(`expected a mua_ token, got ${token}`);
  ok("minted delegated agent token (mua_…)");
}

// --- MCP helpers -----------------------------------------------------------------
let rpcId = 0;
async function rpc(method, params = {}, { auth = token, raw = false } = {}) {
  const res = await fetch(`${SERVER}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (raw) return res;
  const body = await res.json().catch(() => null);
  if (res.status !== 200 || !body) fail(`${method} → HTTP ${res.status}`);
  return body;
}
async function tool(name, args = {}) {
  const body = await rpc("tools/call", { name, arguments: args });
  if (body.error) fail(`tools/call ${name} → protocol error ${JSON.stringify(body.error)}`);
  const text = body.result?.content?.[0]?.text ?? "";
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { isError: body.result?.isError === true, text, data };
}
async function toolOk(name, args, what) {
  const r = await tool(name, args);
  if (r.isError) fail(`${what ?? name}: unexpected tool error: ${r.text}`);
  if (!r.data) fail(`${what ?? name}: tool returned non-JSON text: ${r.text}`);
  return r.data;
}

// --- 1. protocol plumbing -----------------------------------------------------
{
  const get = await fetch(`${SERVER}/mcp`);
  if (get.status !== 405) fail(`GET /mcp → ${get.status}, expected 405`);

  const unauth = await rpc("initialize", {}, { auth: null, raw: true });
  if (unauth.status !== 401) fail(`unauthenticated POST /mcp → ${unauth.status}, expected 401`);

  const init = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mcp-e2e", version: "0" },
  });
  if (init.result?.protocolVersion !== "2025-03-26") fail(`bad protocolVersion: ${JSON.stringify(init.result)}`);
  if (init.result?.serverInfo?.name !== "muesli") fail("serverInfo.name != muesli");
  if (!init.result?.capabilities?.tools) fail("no tools capability");

  const notif = await fetch(`${SERVER}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  if (notif.status !== 202) fail(`notifications/initialized → ${notif.status}, expected 202`);
  if ((await notif.text()) !== "") fail("notification ack has a body");

  const pong = await rpc("ping");
  if (pong.error) fail("ping errored");

  const unknown = await rpc("bogus/method");
  if (unknown.error?.code !== -32601) fail(`unknown method → ${JSON.stringify(unknown)}`);
  ok("plumbing: 405 GET, 401 unauth, initialize, 202 notification, ping, -32601 unknown");
}

// --- 2. tools/list --------------------------------------------------------------
const EXPECTED_TOOLS = [
  "list_documents", "read_document", "get_history", "create_document", "edit_document",
  "add_comment", "reply_comment", "list_comments", "list_suggestions", "resolve_comment",
  "accept_suggestion", "reject_suggestion", "accept_change_set", "reject_change_set",
];
{
  const body = await rpc("tools/list");
  const names = (body.result?.tools ?? []).map((t) => t.name);
  for (const t of EXPECTED_TOOLS) if (!names.includes(t)) fail(`tools/list missing ${t}`);
  for (const t of body.result.tools)
    if (!t.inputSchema?.type) fail(`${t.name} has no input schema`);
  ok(`tools/list: all ${EXPECTED_TOOLS.length} tools with schemas`);
}

// --- 3. create + direct edit + read + history ------------------------------------
const BASE = "# MCP Doc\n\nhello brave world, this stays.\n";
{
  const created = await toolOk("create_document", { slug, markdown: BASE });
  if (!created.document_id) fail("create_document returned no document_id");
  if (created.seq !== 1) fail(`fresh doc should be at seq 1, got ${created.seq}`);

  const read0 = await toolOk("read_document", { slug });
  if (read0.markdown !== BASE) fail(`read_document mismatch: ${JSON.stringify(read0.markdown)}`);
  if (read0.title !== "MCP Doc") fail(`title extraction: ${read0.title}`);
  const seqBefore = read0.seq;

  const edited = await toolOk("edit_document", {
    slug,
    mode: "direct",
    edits: [{ anchor_text: "brave", insert: " new" }], // insert AFTER the anchor
    base_seq: seqBefore,
  });
  if (edited.applied_mode !== "direct") fail(`expected direct, got ${JSON.stringify(edited)}`);
  if (!edited.change_set_id) fail("direct edit has no change_set_id");

  // read by document_id too
  const read1 = await toolOk("read_document", { document_id: created.document_id });
  if (!read1.markdown.includes("brave new world")) fail(`edit did not land: ${read1.markdown}`);

  // point-in-time read
  const old = await toolOk("read_document", { slug, version: seqBefore });
  if (old.markdown !== BASE) fail("historical read is not the pre-edit text");

  const docs = await toolOk("list_documents", { query: slug });
  if (!docs.documents?.some((d) => d.slug === slug)) fail("list_documents missing the doc");

  const hist = await toolOk("get_history", { slug });
  const agentEntries = (hist.entries ?? []).filter((e) => e.origin === "agent");
  if (!agentEntries.length) fail(`no agent-origin history: ${JSON.stringify(hist)}`);
  if (!agentEntries.every((e) => e.author?.kind === "agent")) fail("agent entry not attributed to an agent identity");
  if (!agentEntries.some((e) => e.change_set_id === edited.change_set_id)) fail("edit's change set missing from history");
  ok("create_document + direct anchor_text edit + reads + attributed agent history");
}

// --- 4. ambiguous anchors and stale base_seq are clear errors ---------------------
{
  const amb = await tool("edit_document", {
    slug,
    mode: "direct",
    edits: [{ anchor_text: "l", insert: "!" }], // many matches
  });
  if (!amb.isError) fail("ambiguous anchor_text did not error");
  if (!/ambiguous/.test(amb.text) || !/byte \d+/.test(amb.text)) fail(`ambiguity error lacks offsets: ${amb.text}`);

  const missing = await tool("edit_document", {
    slug,
    mode: "direct",
    edits: [{ anchor_text: "no such text anywhere", delete: true }],
  });
  if (!missing.isError || !/not found/.test(missing.text)) fail(`missing-anchor error: ${missing.text}`);

  const { seq } = await toolOk("read_document", { slug });
  const stale = await tool("edit_document", {
    slug,
    mode: "direct",
    edits: [{ anchor_text: "stays", insert: "!" }],
    base_seq: seq - 1,
  });
  if (!stale.isError) fail("stale base_seq did not error");
  if (!stale.text.includes(`seq ${seq}`)) fail(`stale error lacks current seq: ${stale.text}`);
  ok("ambiguous anchor (with offsets), missing anchor, stale base_seq all error clearly");
}

// --- 5. comments over MCP ----------------------------------------------------------
let threadId;
{
  const c = await toolOk("add_comment", { slug, anchor_text: "stays", body: "does it though?" });
  threadId = c.thread_id;
  if (!threadId) fail("add_comment returned no thread_id");
  await toolOk("reply_comment", { thread_id: threadId, body: "it does." });
  const list = await toolOk("list_comments", { slug, status: "open" });
  const t = list.threads?.find((x) => x.thread_id === threadId);
  if (!t || t.comments.length !== 2) fail(`expected the thread with 2 comments: ${JSON.stringify(list)}`);
  if (t.comments[0].author?.kind !== "agent") fail("comment not attributed to the agent");

  const resolveAttempt = await tool("resolve_comment", { thread_id: threadId });
  if (!resolveAttempt.isError || !resolveAttempt.text.includes("policy-disabled"))
    fail(`resolve_comment should be policy-disabled: ${resolveAttempt.text}`);
  ok("add/reply/list comments; resolve_comment is policy-disabled by default");
}

// --- 6. suggest-when-co-present: a live human downgrades direct → suggest ------------
class CookieWS extends WebSocket {
  constructor(url, protocols) {
    super(url, protocols, { headers: { cookie: sessionCookie } });
  }
}
function humanClient() {
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(WS_URL, slug, ydoc, {
    WebSocketPolyfill: CookieWS,
    disableBc: true,
  });
  provider.awareness.setLocalStateField("user", { name: "Dev Human", color: "#36f", kind: "human" });
  const synced = new Promise((resolve) => provider.on("sync", (s) => s && resolve()));
  return { ydoc, provider, synced, text: ydoc.getText("content") };
}

let suggestionId, downgradeChangeSet;
{
  const human = await (async () => {
    const h = humanClient();
    await h.synced;
    return h;
  })();
  await sleep(300); // let awareness reach the room

  const before = await toolOk("read_document", { slug });
  const r = await toolOk("edit_document", {
    slug,
    mode: "direct",
    edits: [{ anchor_text: "this stays.", insert: "this REMAINS.", delete: true }],
  });
  if (r.applied_mode !== "suggest") fail(`expected downgrade to suggest, got ${JSON.stringify(r)}`);
  if (r.downgraded !== true) fail("downgrade not flagged");
  if (!r.suggestion_ids?.length) fail("no suggestion rows created");
  suggestionId = r.suggestion_ids[0];
  downgradeChangeSet = r.change_set_id;

  const after = await toolOk("read_document", { slug });
  if (after.markdown !== before.markdown || after.seq !== before.seq)
    fail("downgraded edit touched the document!");
  if (human.text.toString() !== before.markdown) fail("downgraded edit reached the ws client!");

  const pending = await toolOk("list_suggestions", { slug, status: "pending" });
  if (!pending.suggestions?.some((s) => s.id === suggestionId)) fail("pending suggestion not listed");

  const denied = await tool("accept_suggestion", { suggestion_id: suggestionId });
  if (!denied.isError || !denied.text.includes("policy-disabled"))
    fail(`accept_suggestion should be policy-disabled: ${denied.text}`);
  ok("co-present human downgraded direct → suggest (doc untouched); accept is policy-disabled");

  human.provider.destroy();
  await sleep(200);
}

// --- 7. restart with gated actions on + MUESLI_AGENT_DIRECT=always -------------------
await stopServer(serverProc);
serverProc = await startServer({ MUESLI_AGENT_GATED_ACTIONS: "true", MUESLI_AGENT_DIRECT: "always" });
ok("server restarted (MUESLI_AGENT_GATED_ACTIONS=true, MUESLI_AGENT_DIRECT=always)");

{
  const accepted = await toolOk("accept_suggestion", { suggestion_id: suggestionId });
  if (accepted.status !== "accepted") fail(`accept failed: ${JSON.stringify(accepted)}`);
  const read = await toolOk("read_document", { slug });
  if (!read.markdown.includes("this REMAINS.") || read.markdown.includes("this stays."))
    fail(`accepted suggestion not applied: ${read.markdown}`);

  const hist = await toolOk("get_history", { slug });
  if (!hist.entries.some((e) => e.change_set_id === downgradeChangeSet && e.origin === "agent"))
    fail("accepted suggestion not attributed to the agent's change set in history");

  const resolved = await toolOk("resolve_comment", { thread_id: threadId });
  if (resolved.status !== "resolved") fail("resolve_comment failed with gating on");
  ok("gating on: accept_suggestion applied (attributed) and resolve_comment works");
}

// --- 8. change-set accept + pinned-direct presence under a co-present human -----------
{
  const sugg = await toolOk("edit_document", {
    slug,
    mode: "suggest",
    edits: [
      { anchor_text: "# MCP Doc", insert: "# MCP DOC", delete: true },
      { anchor_text: "REMAINS", insert: "remains", delete: true },
    ],
  });
  if (sugg.applied_mode !== "suggest" || sugg.suggestion_ids.length !== 2) fail("2-edit suggest failed");
  const set = await toolOk("accept_change_set", { change_set_id: sugg.change_set_id });
  if (set.accepted?.length !== 2 || set.conflicts?.length !== 0) fail(`change set accept: ${JSON.stringify(set)}`);
  const read = await toolOk("read_document", { slug });
  if (!read.markdown.includes("# MCP DOC") || !read.markdown.includes("remains"))
    fail("change set edits not applied");

  // Pinned direct: human co-present, MUESLI_AGENT_DIRECT=always → stays direct, and the
  // human sees both the live edit and the synthetic agent awareness entry.
  const human = humanClient();
  await human.synced;
  await sleep(300);
  const direct = await toolOk("edit_document", {
    slug,
    mode: "direct",
    edits: [{ anchor_text: "world", insert: "WORLD", delete: true }],
  });
  if (direct.applied_mode !== "direct") fail(`ALWAYS policy did not pin direct: ${JSON.stringify(direct)}`);
  let sawAgent = false;
  for (let i = 0; i < 30 && !sawAgent; i++) {
    sawAgent = [...human.provider.awareness.getStates().values()].some((s) => s.user?.kind === "agent");
    await sleep(100);
  }
  if (!sawAgent) fail("human never saw the agent's awareness presence");
  for (let i = 0; i < 30 && !human.text.toString().includes("WORLD"); i++) await sleep(100);
  if (!human.text.toString().includes("WORLD")) fail("direct edit did not reach the live human client");
  ok("accept_change_set atomic; MUESLI_AGENT_DIRECT=always pins direct + agent presence visible");
  human.provider.destroy();
  await sleep(200);
}

// --- 9. the stdio proxy: `muesli mcp` -------------------------------------------------
{
  const child = spawn(CLI_BIN, ["mcp", "--server", WS_URL], {
    env: { ...process.env, MUESLI_TOKEN: token, MUESLI_TOKEN_STORE: "file" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (c) => process.stderr.write(`[muesli mcp] ${c}`));
  let buffer = "";
  const responses = [];
  const waiters = [];
  child.stdout.on("data", (c) => {
    buffer += c.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      responses.push(msg);
      waiters.splice(0).forEach((w) => w());
    }
  });
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
  const waitFor = async (id, what) => {
    for (let i = 0; i < 100; i++) {
      const found = responses.find((r) => r.id === id);
      if (found) return found;
      await new Promise((r) => {
        waiters.push(r);
        setTimeout(r, 100);
      });
    }
    fail(`stdio proxy: no response for ${what}`);
  };

  send({ jsonrpc: "2.0", id: 101, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "stdio-e2e", version: "0" } } });
  const init = await waitFor(101, "initialize");
  if (init.result?.serverInfo?.name !== "muesli") fail(`stdio initialize: ${JSON.stringify(init)}`);

  send({ jsonrpc: "2.0", method: "notifications/initialized" }); // must produce NO stdout line

  send({ jsonrpc: "2.0", id: 102, method: "tools/list", params: {} });
  const list = await waitFor(102, "tools/list");
  const names = (list.result?.tools ?? []).map((t) => t.name);
  if (EXPECTED_TOOLS.some((t) => !names.includes(t))) fail("stdio tools/list incomplete");

  send({ jsonrpc: "2.0", id: 103, method: "tools/call", params: { name: "read_document", arguments: { slug } } });
  const read = await waitFor(103, "read_document");
  const payload = JSON.parse(read.result?.content?.[0]?.text ?? "{}");
  if (!payload.markdown?.includes("# MCP DOC")) fail(`stdio read_document: ${JSON.stringify(read)}`);

  await sleep(300); // give a stray notification response a chance to (wrongly) appear
  if (responses.length !== 3) fail(`stdio proxy wrote ${responses.length} lines, expected 3 (notification must be silent)`);
  child.kill();
  ok("stdio proxy: initialize, silent notification, tools/list, read_document");
}

await stopServer(serverProc);
serverProc = null;
console.log("ALL MCP CHECKS PASSED");
process.exit(0);
