// Muesli presence for VS Code (ADR 0014, Tier 2) — thin glue over src/core.ts.
//
// When the active markdown file is muesli-linked (per the CLI's links.json),
// join the doc's room as a presence-only participant: publish our cursor,
// render other participants as decorations + a status bar item. Content keeps
// flowing through `muesli open` / the file on disk — we never edit the buffer
// and never write to the ytext.

import * as os from "node:os";
import * as vscode from "vscode";
import { PresenceSession, findLink, httpBase, loadToken, wsBase, type Link, type Participant } from "./core";

const CURSOR_DEBOUNCE_MS = 250;

const PALETTE = ["#f59e0b", "#10b981", "#3b82f6", "#ef4444", "#8b5cf6", "#ec4899"];

// ---------------------------------------------------------------------------
// Decoration types, recycled per participant color for the extension lifetime.
// ---------------------------------------------------------------------------

interface DecoPair {
  caret: vscode.TextEditorDecorationType;
  selection: vscode.TextEditorDecorationType;
}

const decoCache = new Map<string, DecoPair>();

function decosFor(color: string): DecoPair {
  let pair = decoCache.get(color);
  if (!pair) {
    pair = {
      // A 2px colored left border on a zero-width range reads as a remote caret.
      caret: vscode.window.createTextEditorDecorationType({
        borderColor: color,
        borderStyle: "solid",
        borderWidth: "0 0 0 2px",
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      }),
      selection: vscode.window.createTextEditorDecorationType({
        backgroundColor: `${color}33`,
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      }),
    };
    decoCache.set(color, pair);
  }
  return pair;
}

// ---------------------------------------------------------------------------
// Active presence (one session, for the active editor's linked document).
// ---------------------------------------------------------------------------

interface ActivePresence {
  session: PresenceSession;
  link: Link;
  /** fsPath of the document this session belongs to. */
  fsPath: string;
  disposables: (() => void)[];
  cursorTimer: ReturnType<typeof setTimeout> | undefined;
}

let active: ActivePresence | undefined;
let statusBar: vscode.StatusBarItem;

function config() {
  return vscode.workspace.getConfiguration("muesli");
}

/** ws://host:8787/ws → http://host:8787 is the API base; in local dev the web
 *  app lives elsewhere (vite on :5173), so a localhost server defers to the
 *  muesli.webOrigin setting. */
function webOriginFor(server: string): string {
  const http = httpBase(server);
  let host = "";
  try {
    host = new URL(http).hostname;
  } catch {
    /* fall through */
  }
  if (host === "localhost" || host === "127.0.0.1") {
    return config().get<string>("webOrigin", "http://localhost:5173").replace(/\/+$/, "");
  }
  return http;
}

function displayName(): string {
  const fromConfig = config().get<string>("displayName", "").trim();
  if (fromConfig) return fromConfig;
  try {
    return os.userInfo().username;
  } catch {
    return "vscode user";
  }
}

/** Offset (UTF-16, into `text`) → editor position, clamped to the buffer.
 *  Line/col are computed against the YTEXT's string, then validated against the
 *  (possibly drifted) buffer — the file bridge keeps them close. */
function ytextOffsetToEditorPos(editor: vscode.TextEditor, text: string, offset: number): vscode.Position {
  const off = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < off; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line++;
      lineStart = i + 1;
    }
  }
  return editor.document.validatePosition(new vscode.Position(line, off - lineStart));
}

function renderPresence(): void {
  if (!active) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.fsPath !== active.fsPath) return;

  const remotes = active.session.participants();

  // Status bar.
  const n = remotes.length;
  statusBar.text = `$(organization) muesli: ${n} here`;
  statusBar.tooltip =
    n === 0
      ? `No one else in "${active.link.doc}"`
      : remotes.map((p) => `${p.name} (${p.kind})`).join("\n");
  statusBar.show();

  // Decorations: group cursor/selection ranges per color so each decoration
  // type is set exactly once per render.
  const text = active.session.text();
  const carets = new Map<string, vscode.DecorationOptions[]>();
  const selections = new Map<string, vscode.DecorationOptions[]>();
  for (const p of remotes) {
    if (!p.cursor) continue;
    const color = PALETTE.includes(p.color) || /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : PALETTE[0];
    const head = ytextOffsetToEditorPos(editor, text, p.cursor.head);
    const hover = new vscode.MarkdownString(`**${p.name}** · ${p.kind}`);
    (carets.get(color) ?? carets.set(color, []).get(color)!).push({
      range: new vscode.Range(head, head),
      hoverMessage: hover,
    });
    if (p.cursor.anchor !== p.cursor.head) {
      const anchor = ytextOffsetToEditorPos(editor, text, p.cursor.anchor);
      const [start, end] = anchor.isBefore(head) ? [anchor, head] : [head, anchor];
      (selections.get(color) ?? selections.set(color, []).get(color)!).push({
        range: new vscode.Range(start, end),
        hoverMessage: hover,
      });
    }
  }
  // Apply, clearing colors that no longer have ranges.
  for (const [color, pair] of decoCache) {
    editor.setDecorations(pair.caret, carets.get(color) ?? []);
    editor.setDecorations(pair.selection, selections.get(color) ?? []);
  }
  for (const [color, opts] of carets) editor.setDecorations(decosFor(color).caret, opts);
  for (const [color, opts] of selections) editor.setDecorations(decosFor(color).selection, opts);
}

function clearDecorations(editor: vscode.TextEditor | undefined): void {
  if (!editor) return;
  for (const pair of decoCache.values()) {
    editor.setDecorations(pair.caret, []);
    editor.setDecorations(pair.selection, []);
  }
}

function publishCursorDebounced(editor: vscode.TextEditor): void {
  if (!active) return;
  const a = active;
  if (a.cursorTimer) clearTimeout(a.cursorTimer);
  a.cursorTimer = setTimeout(() => {
    if (active !== a) return;
    const sel = editor.selection;
    // Buffer offsets ≈ ytext offsets (the file bridge keeps them close);
    // setCursor clamps against the ytext length.
    a.session.setCursor(editor.document.offsetAt(sel.anchor), editor.document.offsetAt(sel.active));
  }, CURSOR_DEBOUNCE_MS);
}

function stopPresence(): void {
  if (!active) return;
  const a = active;
  active = undefined;
  if (a.cursorTimer) clearTimeout(a.cursorTimer);
  for (const dispose of a.disposables) dispose();
  a.session.destroy();
  clearDecorations(vscode.window.activeTextEditor);
  statusBar.hide();
}

function startPresence(editor: vscode.TextEditor): void {
  const fsPath = editor.document.uri.fsPath;
  const link = findLink(fsPath);
  if (!link) return;

  const server = config().get<string>("serverOverride", "").trim() || link.server;
  const token = loadToken(server);
  const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  const session = new PresenceSession(
    wsBase(server),
    link.doc,
    { name: displayName(), color, kind: "vscode" },
    token,
  );

  const a: ActivePresence = { session, link, fsPath, disposables: [], cursorTimer: undefined };
  a.disposables.push(session.onAwarenessChange(() => renderPresence()));
  a.disposables.push(session.onTextChange(() => renderPresence()));
  active = a;

  statusBar.text = `$(organization) muesli: connecting…`;
  statusBar.show();
  void session.whenSynced.then(() => {
    if (active !== a) return;
    renderPresence();
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.uri.fsPath === fsPath) publishCursorDebounced(ed);
  });
}

function syncToActiveEditor(editor: vscode.TextEditor | undefined): void {
  if (editor && editor.document.languageId === "markdown") {
    if (active && active.fsPath === editor.document.uri.fsPath) {
      renderPresence();
      return;
    }
    stopPresence();
    startPresence(editor);
  } else if (editor) {
    // A different file took focus → tear down. `undefined` (focus moved to a
    // panel/terminal) keeps the session alive.
    stopPresence();
  }
}

async function showParticipants(): Promise<void> {
  if (!active) return;
  const a = active;
  const items: (vscode.QuickPickItem & { open?: boolean })[] = a.session.participants().map((p: Participant) => ({
    label: `$(circle-filled) ${p.name}`,
    description: p.kind + (p.cursor ? "" : " · no cursor"),
  }));
  items.push({ label: "$(globe) Open in browser", description: webOriginFor(a.link.server), open: true });
  const picked = await vscode.window.showQuickPick(items, {
    title: `Muesli — ${a.link.doc}`,
    placeHolder: "Participants in this document",
  });
  if (picked?.open) {
    const url = `${webOriginFor(a.link.server)}/#${encodeURIComponent(a.link.doc)}`;
    void vscode.env.openExternal(vscode.Uri.parse(url));
  }
}

export function activate(context: vscode.ExtensionContext): void {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "muesli.showParticipants";
  context.subscriptions.push(statusBar);

  context.subscriptions.push(vscode.commands.registerCommand("muesli.showParticipants", showParticipants));

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => syncToActiveEditor(editor)),
  );
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (active && e.textEditor.document.uri.fsPath === active.fsPath) {
        publishCursorDebounced(e.textEditor);
      }
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (active && doc.uri.fsPath === active.fsPath) stopPresence();
    }),
  );

  syncToActiveEditor(vscode.window.activeTextEditor);
}

export function deactivate(): void {
  stopPresence();
  for (const pair of decoCache.values()) {
    pair.caret.dispose();
    pair.selection.dispose();
  }
  decoCache.clear();
}
