// Link-graph e2e (ADR 0015; docs/design/wikilinks-and-link-graph.md): drives the EXACT
// fetch layer the UI uses (src/graphApi.ts, node 22 type-stripping) against a live server:
//   1. three docs created over ws with wikilinks ([[target]] / [[target|label]]), a
//      relative md link ([x](./target.md)) and an unresolved [[Ghost]]
//   2. after the ~2s extraction debounce, GET /api/graph holds exactly those
//      nodes/edges/unresolved (scoped to this run's slug prefix — open mode sees all)
//   3. GET /api/documents/{slug}/links returns the right outgoing + incoming sets
//   4. creating the ghost document re-resolves the dangling edge (dst gets set)
//   5. editing a doc to remove a link deletes its row
//   6. code-fence negative: a doc whose only [[link]] is inside a fence produces no edge
//
//   node scripts/graph-e2e.mjs
//
// Spawns its OWN muesli-server on :8794 in OPEN mode unless MUESLI_HTTP is set.
import { spawn } from "node:child_process";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";
import { createGraphApi } from "../src/graphApi.ts";

const OWN_SERVER = !process.env.MUESLI_HTTP;
const SERVER = process.env.MUESLI_HTTP ?? "http://127.0.0.1:8794";
const WS_URL = process.env.MUESLI_WS ?? "ws://localhost:8794/ws";
const BINARY = new URL("../../../target/debug/muesli-server", import.meta.url).pathname;

// Unique per-run prefix: slugs are global, the DB persists across runs, and open mode's
// graph shows everything — assertions are exact within this run's namespace.
const P = `g${Date.now()}`;
const ALPHA = `${P}-alpha`;
const BETA = `${P}-beta`;
const GAMMA = `${P}-gamma`;
const GHOST = `${P}-ghost`;
const CFNEG = `${P}-cfneg`;

let serverProc = null;
const providers = [];
const cleanup = () => {
  for (const p of providers) p.destroy();
  if (serverProc && serverProc.exitCode === null) serverProc.kill("SIGTERM");
};
process.on("exit", cleanup);

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`OK: ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => fail("global timeout"), 120_000).unref();

// --- 0. our own server on :8794, OPEN mode (no OIDC env) ----------------------
if (OWN_SERVER) {
  serverProc = spawn(BINARY, [], {
    env: {
      PATH: process.env.PATH,
      DATABASE_URL:
        process.env.DATABASE_URL ?? "postgres://muesli:muesli@localhost:5433/muesli",
      MUESLI_LISTEN: "127.0.0.1:8794",
      RUST_LOG: "warn",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  serverProc.on("exit", (code, signal) => {
    if (code !== null && code !== 0) fail(`server exited early (code ${code}, signal ${signal})`);
  });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await sleep(150);
    up = await fetch(`${SERVER}/api/me`).then((r) => r.ok, () => false);
  }
  if (!up) fail("server on :8794 did not become ready");
  ok("own server up on :8794 (open mode)");
}

const api = createGraphApi({ httpBase: SERVER });

// --- ws helpers ----------------------------------------------------------------
async function openDoc(slug, text) {
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(WS_URL, slug, ydoc, {
    WebSocketPolyfill: WebSocket,
    // Same-process clients would otherwise sync over BroadcastChannel, bypassing the server.
    disableBc: true,
  });
  providers.push(provider);
  const ytext = ydoc.getText("content");
  await new Promise((resolve) => provider.on("sync", (s) => s && resolve()));
  if (text) ytext.insert(0, text);
  return ytext;
}

/// The graph filtered to this run's namespace: nodes by slug prefix, edges/unresolved by
/// src (and dst) membership. Returns { nodes: Map(slug -> node), edges, unresolved, byId }.
async function ourGraph() {
  const g = await api.getGraph();
  const nodes = new Map(g.nodes.filter((n) => n.slug.startsWith(P)).map((n) => [n.slug, n]));
  const ids = new Map([...nodes.values()].map((n) => [n.document_id, n.slug]));
  const edges = g.edges.filter((e) => ids.has(e.src) || ids.has(e.dst));
  const unresolved = g.unresolved.filter((u) => ids.has(u.src));
  return { nodes, ids, edges, unresolved };
}

/// Poll ourGraph() until `predicate` holds (extraction is debounced ~2s server-side).
async function waitForGraph(what, predicate) {
  for (let i = 0; i < 60; i++) {
    const g = await ourGraph();
    if (predicate(g)) return g;
    await sleep(500);
  }
  const g = await ourGraph();
  fail(`${what}: timed out; last graph = ${JSON.stringify({
    nodes: [...g.nodes.keys()],
    edges: g.edges,
    unresolved: g.unresolved,
  })}`);
}

const edgeSet = (g) =>
  g.edges
    .map((e) => `${g.ids.get(e.src)}->${g.ids.get(e.dst)}:${e.raw_target}`)
    .sort()
    .join("|");

// --- 1. three linked docs + the code-fence negative -----------------------------
const ALPHA_TEXT = `# Alpha

See [[${BETA}]] and [a guide](./${GAMMA}.md).

Mystery link: [[${GHOST}]] — no such document yet.
`;
const alphaText = await openDoc(ALPHA, ALPHA_TEXT);
await openDoc(BETA, `# Beta\n\nBack to [[${ALPHA}|the alpha doc]].\n`);
await openDoc(GAMMA, `# Gamma\n\nNo links here.\n`);
await openDoc(
  CFNEG,
  "# Fenced\n\n```\n[[" + BETA + "]]\n```\n\nAnd `[[" + GAMMA + "]]` inline code.\n",
);
ok("4 docs created over ws (wikilink, labeled wikilink, relative md link, [[ghost]], fenced)");

// --- 2. the graph after the debounce ----------------------------------------------
const expectedEdges = [
  `${ALPHA}->${BETA}:${BETA}`,
  `${ALPHA}->${GAMMA}:./${GAMMA}.md`,
  `${BETA}->${ALPHA}:${ALPHA}`,
]
  .sort()
  .join("|");

{
  const g = await waitForGraph(
    "initial extraction",
    (g) => g.nodes.size === 4 && edgeSet(g) === expectedEdges && g.unresolved.length === 1,
  );
  const want = [ALPHA, BETA, GAMMA, CFNEG].sort().join(",");
  const got = [...g.nodes.keys()].sort().join(",");
  if (got !== want) fail(`nodes: ${got} != ${want}`);
  if (edgeSet(g) !== expectedEdges) fail(`edges: ${edgeSet(g)} != ${expectedEdges}`);
  const u = g.unresolved[0];
  if (g.ids.get(u.src) !== ALPHA || u.raw_target !== GHOST)
    fail(`unresolved: ${JSON.stringify(g.unresolved)}`);
  // Degree counts (resolved edges only).
  const deg = (slug) => {
    const n = g.nodes.get(slug);
    return `${n.links_out}/${n.links_in}`;
  };
  if (deg(ALPHA) !== "2/1") fail(`alpha degree ${deg(ALPHA)}, want 2/1`);
  if (deg(BETA) !== "1/1") fail(`beta degree ${deg(BETA)}, want 1/1`);
  if (deg(GAMMA) !== "0/1") fail(`gamma degree ${deg(GAMMA)}, want 0/1`);
  if (deg(CFNEG) !== "0/0") fail(`cfneg degree ${deg(CFNEG)}, want 0/0 (fence negative)`);
  ok("graph exact: 4 nodes, 3 edges (incl. labeled wikilink + relative md link), 1 unresolved");
  ok("code-fence negative: fenced [[wikilink]] and inline-code link produced no edges");
}

// --- 3. per-document links (the backlinks panel's endpoint) -------------------------
{
  const links = await api.getDocumentLinks(ALPHA);
  const out = links.outgoing
    .map((l) => `${l.raw_target}:${l.resolved ? l.slug : "unresolved"}`)
    .sort()
    .join("|");
  const wantOut = [`${BETA}:${BETA}`, `./${GAMMA}.md:${GAMMA}`, `${GHOST}:unresolved`]
    .sort()
    .join("|");
  if (out !== wantOut) fail(`alpha outgoing: ${out} != ${wantOut}`);
  const incoming = links.incoming.map((l) => `${l.slug}:${l.raw_target}`).join("|");
  if (incoming !== `${BETA}:${ALPHA}`) fail(`alpha incoming: ${incoming}`);
  ok("GET /links: alpha has 3 outgoing (1 unresolved) and exactly the beta backlink");
}

// --- 4. creating the ghost doc resolves the dangling link ----------------------------
{
  await openDoc(GHOST, "# Ghost\n\nNow I exist.\n");
  const g = await waitForGraph(
    "ghost re-resolution",
    (g) =>
      g.unresolved.length === 0 &&
      g.edges.some((e) => g.ids.get(e.src) === ALPHA && g.ids.get(e.dst) === GHOST),
  );
  const e = g.edges.find((e) => g.ids.get(e.dst) === GHOST);
  if (e.raw_target !== GHOST) fail(`resolved edge keeps raw_target: ${e.raw_target}`);
  if (g.nodes.get(GHOST).links_in !== 1) fail("ghost node should have links_in = 1");
  ok("creating the ghost document resolved the unresolved edge (dst now set)");
}

// --- 5. removing a link updates the rows ----------------------------------------------
{
  const needle = `[[${BETA}]]`;
  const at = alphaText.toString().indexOf(needle);
  if (at < 0) fail("alpha text lost its beta wikilink?");
  alphaText.delete(at, needle.length);
  const g = await waitForGraph(
    "link removal",
    (g) => !g.edges.some((e) => g.ids.get(e.src) === ALPHA && g.ids.get(e.dst) === BETA),
  );
  if (g.nodes.get(ALPHA).links_out !== 2)
    fail(`alpha links_out after removal: ${g.nodes.get(ALPHA).links_out}, want 2`);
  if (g.nodes.get(BETA).links_in !== 0)
    fail(`beta links_in after removal: ${g.nodes.get(BETA).links_in}, want 0`);
  // The other links must have survived the diff-update untouched.
  const still = g.edges.filter((e) => g.ids.get(e.src) === ALPHA).length;
  if (still !== 2) fail(`alpha should still have 2 outgoing edges, has ${still}`);
  ok("editing out the [[beta]] wikilink deleted exactly that row");
}

console.log("ALL GRAPH CHECKS PASSED");
cleanup();
process.exit(0);
