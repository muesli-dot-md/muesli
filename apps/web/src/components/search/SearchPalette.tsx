// Center-screen search palette (Drive/Spotlight hybrid). React port of
// SearchPalette.svelte, rendered in desktop SearchModal's CommandDialog shell
// but keeping the web data layer: live server-side search (GET /api/search via
// workspaceApi) with a 150ms debounce and stale-request cancellation
// (AbortController), results grouped by SOURCE — Muesli Cloud first, then each
// connected service — with the server ranking kept within each group. Yjs-free.
//
// Contract (wave): <SearchPalette open onClose />. The Svelte module-level
// open flag becomes searchPaletteStore below, so any header affordance (Home's
// pill, DocApp's button) can summon the single mounted instance without prop
// drilling — App can either mount <SearchPaletteHost /> (store + global ⌘K/'/'
// shortcuts, mirroring the old module semantics) or wire the controlled
// component itself.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Cloud,
  CornerDownLeft,
  Database,
  FileText,
  GitBranch,
  HardDrive,
  Search,
  Users,
} from "lucide-react";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

import { CommandDialog } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { errMsg } from "@/services/apiError";
import { httpBase } from "@/services/identity";
import { driveDate } from "@/services/time";
import { createWorkspaceApi, type FolderSummary, type SearchResult } from "@/services/workspaceApi";
import { useT } from "@/state/i18n";
import { gotoDoc } from "@/state/route";

// --- module-level open flag (Svelte `<script module>` equivalent) ---------------

export const searchPaletteStore = createStore<{ open: boolean }>(() => ({ open: false }));

export function openSearchPalette(): void {
  searchPaletteStore.setState({ open: true });
}

export function closeSearchPalette(): void {
  searchPaletteStore.setState({ open: false });
}

export function searchPaletteOpen(): boolean {
  return searchPaletteStore.getState().open;
}

export const useSearchPaletteOpen = () => useStore(searchPaletteStore, (s) => s.open);

/** "⌘K" on Apple platforms, "Ctrl K" elsewhere — for header hints. */
export const searchShortcutHint = /Mac|iPhone|iPad/.test(
  typeof navigator === "undefined" ? "" : navigator.platform,
)
  ? "⌘K"
  : "Ctrl K";

// --- data -----------------------------------------------------------------------

const api = createWorkspaceApi({ httpBase });

const DEBOUNCE_MS = 150;

// Grouping: Muesli Cloud first, then each connected service.
const GROUP_ORDER: Record<string, number> = { native: 0, gdrive: 1, github: 2, s3: 3 };

type Group = { kind: SearchResult["source"]["kind"]; label: string; items: SearchResult[] };

function groupResults(results: SearchResult[]): Group[] {
  const map = new Map<string, Group>();
  for (const r of results) {
    const key = `${r.source.kind} ${r.source.label}`;
    let g = map.get(key);
    if (!g) {
      g = { kind: r.source.kind, label: r.source.label, items: [] };
      map.set(key, g);
    }
    g.items.push(r); // insertion order keeps the server ranking within the group
  }
  return [...map.values()].sort(
    (a, b) =>
      (GROUP_ORDER[a.kind] ?? 9) - (GROUP_ORDER[b.kind] ?? 9) || a.label.localeCompare(b.label),
  );
}

/** Split around the first case-insensitive occurrence of the answered query. */
function highlightSplit(
  text: string,
  needle: string,
): { pre: string; hit: string; post: string } | null {
  const n = needle.trim().toLowerCase();
  if (!n) return null;
  const i = text.toLowerCase().indexOf(n);
  if (i < 0) return null;
  return {
    pre: text.slice(0, i),
    hit: text.slice(i, i + n.length),
    post: text.slice(i + n.length),
  };
}

/** First-occurrence highlight: <mark> around the matched span, plain otherwise. */
function Highlighted({ text, needle }: { text: string; needle: string }) {
  const h = highlightSplit(text, needle);
  if (!h) return <>{text}</>;
  return (
    <>
      {h.pre}
      <mark className="rounded-sm bg-primary/20 font-semibold text-inherit">{h.hit}</mark>
      {h.post}
    </>
  );
}

function groupIcon(kind: string) {
  if (kind === "native") return <Cloud className="size-3.5 shrink-0" aria-hidden="true" />;
  if (kind === "gdrive") return <HardDrive className="size-3.5 shrink-0" aria-hidden="true" />;
  if (kind === "github") return <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />;
  return <Database className="size-3.5 shrink-0" aria-hidden="true" />;
}

// --- component ------------------------------------------------------------------

export function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  /** The query the current `results` answer — "" until the first response lands. */
  const [answered, setAnswered] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(0);
  // Folder names for the path crumb, fetched once per open (cosmetic — failures
  // just leave crumbs at "My documents").
  const [folderById, setFolderById] = useState<Map<string, FolderSummary>>(new Map());
  const listRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inflightRef = useRef<AbortController | null>(null);

  const groups = useMemo(() => groupResults(results), [results]);
  /** Render order flattened — ArrowUp/Down move `selected` through this list. */
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // Reset on open + fetch folder crumbs; cancel any in-flight work on close.
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setAnswered("");
      setError("");
      setLoading(false);
      setSelected(0);
      void api
        .listDocuments()
        .then((r) => setFolderById(new Map((r.folders ?? []).map((f) => [f.id, f]))))
        .catch(() => {});
    } else {
      clearTimeout(timerRef.current);
      inflightRef.current?.abort();
      inflightRef.current = null;
    }
  }, [open]);

  // Clamp the highlight when the list shrinks under it.
  useEffect(() => {
    if (selected >= flat.length) setSelected(Math.max(0, flat.length - 1));
  }, [flat.length, selected]);

  async function run(q: string) {
    inflightRef.current?.abort();
    const ac = new AbortController();
    inflightRef.current = ac;
    try {
      const r = await api.search(q, { limit: 30, signal: ac.signal });
      if (ac.signal.aborted) return; // a newer keystroke superseded this request
      setResults(r.results);
      setAnswered(q);
      setSelected(0);
      setError("");
      setLoading(false);
    } catch (e) {
      if (ac.signal.aborted) return;
      setError(errMsg(e));
      setLoading(false);
    }
  }

  function onInput(raw: string) {
    setQuery(raw);
    const q = raw.trim();
    clearTimeout(timerRef.current);
    if (!q) {
      inflightRef.current?.abort();
      inflightRef.current = null;
      setResults([]);
      setAnswered("");
      setError("");
      setLoading(false);
      return;
    }
    setLoading(true);
    timerRef.current = setTimeout(() => void run(q), DEBOUNCE_MS);
  }

  function openResult(r: SearchResult) {
    onClose();
    gotoDoc(r.slug);
  }

  function moveSelection(delta: number) {
    if (flat.length === 0) return;
    const next = (selected + delta + flat.length) % flat.length;
    setSelected(next);
    listRef.current
      ?.querySelector(`[data-result-index="${next}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = flat[selected];
      if (hit) openResult(hit);
    }
  }

  /** Folder chain (root-first) for the path crumb. */
  function crumb(folderId: string | null): string[] {
    const chain: string[] = [];
    let cur = folderId ? folderById.get(folderId) : undefined;
    let guard = 0;
    while (cur && guard++ < 100) {
      chain.unshift(cur.name);
      cur = cur.parent_id ? folderById.get(cur.parent_id) : undefined;
    }
    return chain;
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) onClose();
      }}
      className="max-w-2xl"
      title={t("search.dialogLabel")}
      description={t("search.hint")}
    >
      <div className="flex max-h-[60vh] flex-col overflow-hidden" onKeyDown={handleKeyDown}>
        {/* Search input row */}
        <label className="flex items-center gap-3 border-b border-surface-border px-4 py-3">
          <Search className="size-4.5 shrink-0 opacity-50" aria-hidden="true" />
          <input
            autoFocus
            value={query}
            onChange={(e) => onInput(e.currentTarget.value)}
            type="text"
            placeholder={t("search.placeholder")}
            className="grow bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
          />
          {loading && answered ? <Spinner className="size-4 opacity-40" /> : null}
          <Kbd>Esc</Kbd>
        </label>

        {/* Results */}
        <div ref={listRef} className="min-h-0 overflow-y-auto overscroll-contain py-1">
          {error ? (
            <p className="px-5 py-6 text-sm text-destructive">{error}</p>
          ) : loading && results.length === 0 ? (
            // Shimmer only while there is nothing to show; stale results stay
            // on screen during a refresh so typing never flickers.
            <div className="flex flex-col gap-2 px-5 py-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : answered && results.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">
              {t("search.noResults", { query: answered })}
            </p>
          ) : results.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground/80">{t("search.hint")}</p>
          ) : (
            <>
              {groups.map((g) => (
                <div key={`${g.kind}:${g.label}`}>
                  <div className="flex items-center gap-1.5 px-5 pt-3 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {groupIcon(g.kind)}
                    <span className="truncate">{g.label}</span>
                  </div>
                  {g.items.map((r) => {
                    const i = flat.indexOf(r);
                    const active = i === selected;
                    return (
                      <button
                        key={r.document_id}
                        type="button"
                        className={`flex min-h-10 w-full items-start gap-3 px-5 py-2 text-left transition-colors ${
                          active ? "bg-surface-selected" : "hover:bg-surface-hover"
                        }`}
                        data-result-index={i}
                        onMouseEnter={() => setSelected(i)}
                        onClick={() => openResult(r)}
                      >
                        <FileText
                          className="mt-0.5 size-4 shrink-0 text-primary"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-2">
                            <span className="truncate text-sm font-medium text-foreground">
                              <Highlighted text={r.title} needle={answered} />
                            </span>
                            {!r.is_owner && r.owner ? (
                              <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                                <Users className="size-3" aria-hidden="true" />
                                {r.owner.display_name ?? t("common.shared")}
                              </span>
                            ) : null}
                          </span>
                          {r.match.field === "content" ? (
                            <span className="block truncate text-xs text-muted-foreground">
                              <Highlighted text={r.match.snippet} needle={answered} />
                            </span>
                          ) : null}
                          <span className="block truncate text-xs text-muted-foreground/60">
                            {t("home.myDocuments")}
                            {crumb(r.folder_id)
                              .map((n) => ` › ${n}`)
                              .join("")}
                          </span>
                        </span>
                        <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">
                          {driveDate(r.updated_at)}
                        </span>
                        {active ? (
                          <CornerDownLeft
                            className="mt-1 size-3.5 shrink-0 opacity-40"
                            aria-hidden="true"
                          />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ))}
              <div className="h-2" />
            </>
          )}
        </div>
      </div>
    </CommandDialog>
  );
}

/** Single-instance host: wires the module store to the controlled component
 *  and owns the global shortcuts (⌘K / Ctrl+K toggle, '/' opens — never stolen
 *  from typing surfaces), mirroring the Svelte module semantics. App mounts
 *  this once when the gate says "app". */
export function SearchPaletteHost() {
  const open = useSearchPaletteOpen();

  useEffect(() => {
    function onGlobalKeydown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchPaletteStore.setState((s) => ({ open: !s.open }));
        return;
      }
      if (searchPaletteStore.getState().open) {
        // Focus can stray off the input (e.g. after a click) — keep Escape working.
        if (e.key === "Escape") closeSearchPalette();
        return;
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const el = e.target as HTMLElement | null;
        // Never steal '/' from typing surfaces: inputs, textareas, and any
        // contenteditable (CodeMirror's editor surface is contenteditable).
        if (
          el &&
          (el.tagName === "INPUT" ||
            el.tagName === "TEXTAREA" ||
            el.isContentEditable ||
            el.closest(".cm-editor") !== null)
        )
          return;
        e.preventDefault();
        openSearchPalette();
      }
    }
    window.addEventListener("keydown", onGlobalKeydown);
    return () => window.removeEventListener("keydown", onGlobalKeydown);
  }, []);

  return <SearchPalette open={open} onClose={closeSearchPalette} />;
}

// Keep both import styles working across the wave (contract convention).
export default SearchPalette;
