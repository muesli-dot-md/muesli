// ⌘K search palette — Spotlight/Drive-style overlay over the local workspace
// (`search_workspace`, local-first, no server round-trip). Full port of the
// Svelte SearchModal: 160ms debounced search with request-id cancellation,
// results grouped by containing folder with breadcrumbs (services/
// searchGrouping), first-occurrence highlight-split match rendering, and
// custom keyboard nav (the grouped list is not a cmdk surface). Rendered in
// the shadcn CommandDialog shell so it sits at top-1/3 like the other
// palettes (Multica placement).
import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, FileText, Folder, Search } from "lucide-react";
import { CommandDialog } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { flattenGroups, groupHits, highlightSplit } from "@/services/searchGrouping";
import { searchWorkspace, type SearchHit } from "@/services/tauri";
import { tabsStore } from "@/state/tabs";
import { workspaceStore } from "@/state/workspace";

const DEBOUNCE_MS = 160;

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

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SearchModal({ open, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  /** The query the current `results` answer — "" until the first response lands. */
  const [answered, setAnswered] = useState("");
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reqIdRef = useRef(0);

  // Grouped + flattened views derived from the ranked backend hits.
  const groups = useMemo(() => groupHits(results), [results]);
  const flat = useMemo(() => flattenGroups(groups), [groups]);

  // Reset on open; cancel any in-flight request/timer on close.
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setAnswered("");
      setSearched(false);
      setLoading(false);
      setHighlightIdx(0);
    } else {
      if (timerRef.current) clearTimeout(timerRef.current);
      reqIdRef.current++;
    }
  }, [open]);

  // Clamp the highlight when the list shrinks under it.
  useEffect(() => {
    if (highlightIdx >= flat.length) {
      setHighlightIdx(Math.max(0, flat.length - 1));
    }
  }, [flat.length, highlightIdx]);

  function runSearch(raw: string) {
    if (timerRef.current) clearTimeout(timerRef.current);
    const q = raw.trim();
    if (!q) {
      reqIdRef.current++; // supersede any pending request
      setResults([]);
      setAnswered("");
      setSearched(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    const myId = ++reqIdRef.current;
    timerRef.current = setTimeout(async () => {
      const root: string | null = workspaceStore.getState().root;
      if (!root) return;
      try {
        const r = await searchWorkspace(root, q);
        if (myId !== reqIdRef.current) return; // a newer query superseded this one
        setResults(r);
        setAnswered(q);
        setHighlightIdx(0);
      } catch (e) {
        console.error("[search] failed", e);
        if (myId === reqIdRef.current) {
          setResults([]);
          setAnswered(q);
        }
      } finally {
        if (myId === reqIdRef.current) {
          setLoading(false);
          setSearched(true);
        }
      }
    }, DEBOUNCE_MS);
  }

  function openHit(hit: SearchHit) {
    tabsStore.getState().open(hit.path, hit.name);
    onClose();
  }

  function moveSelection(delta: number) {
    if (flat.length === 0) return;
    const next = (highlightIdx + delta + flat.length) % flat.length;
    setHighlightIdx(next);
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
      const h = flat[highlightIdx];
      if (h) openHit(h);
    }
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) onClose();
      }}
      className="max-w-2xl"
      title="Search files & content"
      description="Search filenames and contents in the open workspace…"
    >
      <div className="flex max-h-[60vh] flex-col overflow-hidden" onKeyDown={handleKeyDown}>
        {/* Search input row */}
        <label className="flex items-center gap-3 border-b border-surface-border px-4 py-3">
          <Search className="size-4.5 shrink-0 opacity-50" aria-hidden="true" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              runSearch(e.currentTarget.value);
            }}
            type="text"
            placeholder="Search files & content…"
            className="grow bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
          />
          {loading && answered ? <Spinner className="size-4 opacity-40" /> : null}
          <Kbd>Esc</Kbd>
        </label>

        {/* Results */}
        <div ref={listRef} className="min-h-0 overflow-y-auto overscroll-contain py-1">
          {loading && results.length === 0 ? (
            // Shimmer only while there is nothing to show; stale results stay
            // on screen during a refresh so typing never flickers.
            <div className="flex flex-col gap-2 px-5 py-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : searched && results.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">
              No matches for &quot;{answered}&quot;
            </p>
          ) : results.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground/80">
              Type to search filenames and contents.
            </p>
          ) : (
            <>
              {groups.map((g) => (
                <div key={g.key}>
                  <div className="flex items-center gap-1.5 px-5 pt-3 pb-1 text-xs font-medium text-muted-foreground">
                    <Folder className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">
                      My documents
                      {g.crumb.map((part, i) => (
                        <span key={i}> › {part}</span>
                      ))}
                    </span>
                  </div>
                  {g.items.map((hit) => {
                    const i = flat.indexOf(hit);
                    const active = i === highlightIdx;
                    return (
                      <button
                        key={hit.path}
                        type="button"
                        className={`flex min-h-10 w-full items-start gap-3 px-5 py-2 text-left transition-colors ${
                          active ? "bg-surface-selected" : "hover:bg-surface-hover"
                        }`}
                        data-result-index={i}
                        onMouseEnter={() => setHighlightIdx(i)}
                        onClick={() => openHit(hit)}
                      >
                        <FileText
                          className="mt-0.5 size-4 shrink-0 text-primary"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-2">
                            <span className="truncate text-sm font-medium text-foreground">
                              <Highlighted text={hit.name} needle={answered} />
                            </span>
                            {hit.matches > 0 ? (
                              <span className="ml-auto shrink-0 rounded-sm bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
                                {hit.matches}
                              </span>
                            ) : null}
                          </span>
                          {hit.snippet ? (
                            <span className="block truncate text-xs text-muted-foreground">
                              <Highlighted text={hit.snippet} needle={answered} />
                            </span>
                          ) : null}
                          <span className="block truncate text-xs text-muted-foreground/60">
                            {hit.display}
                          </span>
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

export default SearchModal;
