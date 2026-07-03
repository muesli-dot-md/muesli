// `muesli sync` folder-daemon e2e (Phase 5, ADR 0014; docs/design/local-agent-cli.md).
// Starts its OWN muesli-server in OPEN mode on port 8795 (postgres from docker-compose must
// be up) and drives a folder-sync daemon against a temp tree with an isolated HOME:
//   1. discovery: nested .md files linked (hidden dirs/node_modules skipped), summary printed
//   2. each file's room carries its content; a web edit lands in the RIGHT file (and only it)
//   3. an external append is ingested into the right room
//   4. a NEW .md dropped into the tree is auto-linked within ~3s
//   5. a deleted file stops its session; the room text and index entry are KEPT (never destructive)
//   6. a rename with identical content re-binds to the SAME doc id (index.db checked via sqlite3)
//   7. SIGINT: dirty buffers are flushed to disk before exit
//   8. links.json migration: a pre-SQLite index is imported into index.db, the original kept
//      as links.json.migrated, and the legacy links.json mirror regenerated (vscode ext compat)
// Usage: node sync-daemon-e2e.mjs   (run `cargo build --workspace` first)
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const SERVER_BIN = join(repoRoot, "target", "debug", "muesli-server");
const CLI_BIN = join(repoRoot, "target", "debug", "muesli");
const SERVER = "http://localhost:8795";
const WS_URL = "ws://localhost:8795/ws";
const RUN = `e2e${Date.now()}`; // --prefix → unique rooms per run (the DB persists rooms)

let serverProc = null;
let cli = null;
const tmpHome = mkdtempSync(join(tmpdir(), "muesli-sync-home-"));
const tmpHome2 = mkdtempSync(join(tmpdir(), "muesli-sync-home2-"));
const tree = mkdtempSync(join(tmpdir(), "muesli-sync-tree-"));
const providers = [];

function cleanup() {
  for (const p of providers) try { p.destroy(); } catch {}
  if (cli && cli.exitCode === null) cli.kill("SIGKILL");
  if (serverProc && serverProc.exitCode === null) serverProc.kill("SIGKILL");
  for (const d of [tmpHome, tmpHome2, tree]) rmSync(d, { recursive: true, force: true });
}
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  console.error("--- cli output tail ---\n" + cliOut.slice(-3000));
  cleanup();
  process.exit(1);
};
const ok = (msg) => console.log(`OK: ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => fail("global timeout"), 180_000).unref();

async function until(desc, fn, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) {
      ok(desc);
      return;
    }
    await sleep(150);
  }
  fail(`timeout: ${desc}`);
}

// macOS dirs::data_dir() = $HOME/Library/Application Support
const dataDir = (home) => join(home, "Library", "Application Support", "muesli");
const indexDb = (home) => join(dataDir(home), "index.db");
const sql = (home, query) => execFileSync("sqlite3", [indexDb(home), query], { encoding: "utf8" }).trim();

// --- server (OPEN mode: no OIDC_ISSUER) -----------------------------------------
{
  const env = { ...process.env };
  delete env.OIDC_ISSUER; // open mode, whatever the parent shell has
  serverProc = spawn(SERVER_BIN, [], {
    env: {
      ...env,
      DATABASE_URL: "postgres://muesli:muesli@localhost:5433/muesli", // .env.example
      MUESLI_LISTEN: "127.0.0.1:8795",
      RUST_LOG: "muesli_server=info",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let tail = "";
  serverProc.stderr.on("data", (c) => (tail = (tail + c).slice(-4000)));
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await sleep(100);
    if (serverProc.exitCode !== null) fail(`server exited ${serverProc.exitCode}: ${tail}`);
    up = await fetch(`${SERVER}/healthz`).then((r) => r.ok).catch(() => false);
  }
  if (!up) fail(`server did not come up: ${tail}`);
  ok("server up (open mode, port 8795)");
}

// --- the tree --------------------------------------------------------------------
writeFileSync(join(tree, "notes.md"), "# Notes\n\nHello notes\n");
mkdirSync(join(tree, "sub"));
writeFileSync(join(tree, "sub", "deep.md"), "# Deep\n\nDeep content\n");
mkdirSync(join(tree, ".hidden"));
writeFileSync(join(tree, ".hidden", "skip.md"), "must not sync\n");
mkdirSync(join(tree, "node_modules"));
writeFileSync(join(tree, "node_modules", "skip.md"), "must not sync\n");

// --- the daemon --------------------------------------------------------------------
let cliOut = "";
cli = spawn(CLI_BIN, ["sync", tree, "--server", WS_URL, "--prefix", RUN], {
  env: { ...process.env, HOME: tmpHome, MUESLI_TOKEN_STORE: "file" },
  stdio: ["ignore", "pipe", "pipe"],
});
cli.stdout.on("data", (c) => {
  cliOut += c.toString();
  process.stdout.write(`  [sync] ${c.toString().trimEnd().replaceAll("\n", "\n  [sync] ")}\n`);
});
cli.stderr.on("data", (c) => (cliOut += c.toString()));
cli.on("exit", (code, sig) => (cliExited = { code, sig }));
let cliExited = null;

const room = (slug) => `${RUN}-${slug}`;
function client(slug) {
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(WS_URL, room(slug), ydoc, {
    WebSocketPolyfill: WebSocket,
    disableBc: true,
  });
  providers.push(provider);
  return { text: ydoc.getText("content"), provider };
}

// 1. discovery + summary (hidden + node_modules skipped)
await until("summary: 2 files linked, skip dirs excluded", () =>
  cliOut.includes("muesli sync — 2 file(s) linked") && !cliOut.includes("skip.md"));

// 2. disk → room, per file
const notes = client("notes");
const deep = client("sub-deep");
await until("room #notes carries notes.md content", () => notes.text.toString().includes("Hello notes"));
await until("room #sub-deep carries sub/deep.md content", () => deep.text.toString().includes("Deep content"));

// 2b. web edit → the RIGHT file
deep.text.insert(deep.text.length, "\nWEB-EDIT-DEEP from the browser\n");
await until("web edit materialized into sub/deep.md", () =>
  readFileSync(join(tree, "sub", "deep.md"), "utf8").includes("WEB-EDIT-DEEP"));
if (readFileSync(join(tree, "notes.md"), "utf8").includes("WEB-EDIT-DEEP")) fail("edit leaked into notes.md");
ok("web edit did not leak into other files");

// 3. external edit → the right room
appendFileSync(join(tree, "notes.md"), "\nDISK-EDIT-NOTES appended externally\n");
await until("external append ingested into #notes", () => notes.text.toString().includes("DISK-EDIT-NOTES"));
if (deep.text.toString().includes("DISK-EDIT-NOTES")) fail("disk edit leaked into #sub-deep");

// 4. a new file is auto-linked within ~3s
writeFileSync(join(tree, "sub", "fresh.md"), "# Fresh\n\nBrand new file\n");
await until("new file auto-linked (stdout)", () =>
  cliOut.includes(`new file linked: sub/fresh.md → #${room("sub-fresh")}`), 8_000);
const fresh = client("sub-fresh");
await until("room #sub-fresh carries the new file's content", () => fresh.text.toString().includes("Brand new file"));

// 5. delete: session stops, room text + index entry KEPT
const notesTextBefore = notes.text.toString();
unlinkSync(join(tree, "notes.md"));
await until("removal logged, doc retained", () => cliOut.includes("file removed: notes.md"), 8_000);
await sleep(1500); // give a buggy flush a chance to resurrect the file / clear the room
if (notes.text.toString() !== notesTextBefore) fail("room #notes changed after the file was deleted");
if (existsSync(join(tree, "notes.md"))) fail("deleted file was resurrected on disk");
const keptRow = sql(tmpHome, `SELECT doc_id FROM links WHERE file_path LIKE '%notes.md'`);
if (keptRow !== room("notes")) fail(`index entry for the deleted file gone (got '${keptRow}')`);
ok("deleted file: room text intact, file stays deleted, index entry retained");

// 6. rename with identical content → SAME doc id (ADR 0009 re-bind)
writeFileSync(join(tree, "rn-a.md"), "# Rename me\n\nStable unique content for the rename test\n");
await until("rename source linked + synced", () => cliOut.includes(`✓ synced rn-a.md ⇄ #${room("rn-a")}`), 8_000);
renameSync(join(tree, "rn-a.md"), join(tree, "rn-b.md"));
await until("rename re-bind logged", () => cliOut.includes(`re-linked (rename): rn-b.md → #${room("rn-a")}`), 8_000);
const dstDoc = sql(tmpHome, `SELECT doc_id FROM links WHERE file_path LIKE '%rn-b.md'`);
if (dstDoc !== room("rn-a")) fail(`renamed file bound to '${dstDoc}', expected '${room("rn-a")}'`);
if (sql(tmpHome, `SELECT count(*) FROM links WHERE file_path LIKE '%rn-a.md'`) !== "0")
  fail("stale index entry for the old path survived the re-bind");
ok("rename re-bound the path to the same doc id in index.db");

// last-synced surfaced (the daemon stamps sync activity for `muesli status`)
if (sql(tmpHome, `SELECT count(*) FROM links WHERE last_synced_at IS NOT NULL`) === "0")
  fail("no last_synced_at stamps in index.db");
ok("index.db carries last_synced_at stamps");

// 7. SIGINT → dirty buffers flushed (edit sent, debounce not yet fired)
fresh.text.insert(fresh.text.length, "\nFLUSH-ME: typed right before ctrl-c\n");
await sleep(250); // reach the CLI replica, but stay inside the 500ms materialize debounce
cli.kill("SIGINT");
await until("daemon exited cleanly on SIGINT", () => cliExited !== null && cliExited.code === 0, 15_000);
if (!cliOut.includes("sync stopped")) fail("missing clean-shutdown line");
if (!readFileSync(join(tree, "sub", "fresh.md"), "utf8").includes("FLUSH-ME"))
  fail("dirty buffer was not flushed to disk on SIGINT");
ok("SIGINT: clean shutdown, dirty buffer flushed to sub/fresh.md");

// 8. links.json migration (fresh HOME pre-seeded with the old JSON index)
{
  mkdirSync(dataDir(tmpHome2), { recursive: true });
  writeFileSync(
    join(dataDir(tmpHome2), "links.json"),
    JSON.stringify([{ file: "/tmp/legacy.md", doc: `legacy-${RUN}`, server: SERVER }]),
  );
  const out = execFileSync(CLI_BIN, ["status", "--server", WS_URL], {
    env: { ...process.env, HOME: tmpHome2, MUESLI_TOKEN_STORE: "file" },
    encoding: "utf8",
  });
  if (!existsSync(indexDb(tmpHome2))) fail("migration did not create index.db");
  if (sql(tmpHome2, `SELECT doc_id FROM links WHERE file_path = '/tmp/legacy.md'`) !== `legacy-${RUN}`)
    fail("legacy entry not imported into index.db");
  if (!existsSync(join(dataDir(tmpHome2), "links.json.migrated"))) fail("links.json not renamed to .migrated");
  const mirror = JSON.parse(readFileSync(join(dataDir(tmpHome2), "links.json"), "utf8"));
  if (!mirror[0]?._generated) fail("regenerated links.json mirror lacks the generated marker");
  if (!mirror.some((e) => e.doc === `legacy-${RUN}` && e.file === "/tmp/legacy.md"))
    fail("regenerated links.json mirror lacks the migrated entry");
  if (!out.includes(`legacy-${RUN}`)) fail("`muesli status` does not list the migrated link");
  ok("links.json migrated → index.db (+ .migrated kept, mirror regenerated, status lists it)");
}

cleanup();
console.log("SYNC DAEMON E2E PASSED");
process.exit(0);
