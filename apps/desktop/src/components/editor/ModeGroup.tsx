// Segmented [ Edit | Read | Suggest ] radiogroup: the single control for the
// open document's mode. Port of src/lib/ModeGroup.svelte.
//
// State split (invariant): read mode lives on the TAB (tabs.setMode) so it
// survives the editor lifecycle; suggest mode lives on the doc's CollabStore,
// which is torn down with the editor while Reading. Suggest mode therefore
// does NOT survive a Reading round-trip: leaving Reading lands in Editing
// unless the Suggesting segment itself is chosen (the pending intent below
// re-applies that choice once a healthy store exists).
//
// The ⌘E shortcut and the "Toggle reading view" palette command flip the same
// tabs mode, so the checked segment tracks them with no extra wiring.
import { useEffect, useRef, useState } from "react";

import { tabsStore, useTabs } from "@/state/tabs";
import { useDocCollab } from "@/state/docCollab";
// Sibling module still being built by the state agent — import by contract.
import { useCollabSnapshot, type Availability } from "@/state/collabStore";
import { cn } from "@/lib/utils";

type DocMode = "editing" | "reading" | "suggesting";

function degraded(a: Availability | null): boolean {
  return a === "auth" || a === "volatile";
}

export default function ModeGroup() {
  const collab = useDocCollab((s) => s.store);
  const isRemote = useDocCollab((s) => s.isRemote);
  const wireFailures = useDocCollab((s) => s.wireFailures);
  const activeId = useTabs((s) => s.activeId);
  const isReading = useTabs((s) => s.active()?.mode === "read");
  // Subscribe to the collab store's reactive fields (availability/suggestMode).
  useCollabSnapshot(collab);
  const availability: Availability | null = collab?.availability ?? null;
  const suggestModeOn: boolean = collab?.suggestMode ?? false;

  // Availability carried across Reading's store teardown: the last value the
  // active tab's store reported keeps gating the Suggesting segment while the
  // store is gone, so a doc that was auth/volatile-degraded before entering
  // Reading cannot offer Suggesting from inside it.
  const [lastAvailability, setLastAvailability] = useState<{
    tab: string;
    value: Availability;
  } | null>(null);
  useEffect(() => {
    if (collab && activeId) {
      setLastAvailability({ tab: activeId, value: collab.availability });
    }
  }, [collab, activeId, availability]);
  const rememberedAvailability =
    lastAvailability !== null && lastAvailability.tab === activeId ? lastAvailability.value : null;

  // Suggesting needs a synced doc whose server is reachable and authorized:
  // with a live store that is its current availability; while Reading (store
  // torn down) it is the last availability this tab's store reported. Outside
  // those two cases (no store, not Reading — e.g. mid-remount) the segment
  // stays unavailable until a store materializes.
  const canSuggest =
    isRemote && (collab ? !degraded(availability) : isReading && !degraded(rememberedAvailability));

  // A Suggesting choice made while the store doesn't exist yet (Reading view
  // tears it down). Lifecycle: armed on selectMode("suggesting") with no
  // store; applied once a store exists for the same tab and is NOT
  // auth/volatile ("unknown" must count as applicable — refresh() keeps the
  // last state on network errors, so an intent gated on "ok" would deadlock);
  // dropped when the active tab changes, the tab's mode becomes "read" again,
  // another segment is chosen, the store lands already degraded, or the mount
  // that should have produced the store completes without one (wireFailures).
  const [pendingSuggestTab, setPendingSuggestTab] = useState<string | null>(null);
  // wireFailures baseline captured at arm time: a later bump means the mount
  // the intent was waiting on finished with no store.
  const armedWireFailuresRef = useRef(0);
  useEffect(() => {
    if (pendingSuggestTab === null) return;
    if (
      activeId !== pendingSuggestTab ||
      isReading ||
      wireFailures !== armedWireFailuresRef.current
    ) {
      setPendingSuggestTab(null);
      return;
    }
    if (!collab) return;
    if (!degraded(collab.availability)) collab.suggestMode = true;
    setPendingSuggestTab(null); // applied, or dropped on a degraded store
  }, [pendingSuggestTab, activeId, isReading, wireFailures, collab, availability]);

  // Reading wins while read mode is on; otherwise a live store's suggestMode
  // OR a pending intent picks Suggesting. The intent counts regardless of
  // store presence, so the checked segment never flickers through Editing
  // while a fresh store (suggestMode still false) is being wired up.
  const mode: DocMode = isReading
    ? "reading"
    : suggestModeOn || pendingSuggestTab !== null
      ? "suggesting"
      : "editing";

  function selectMode(next: DocMode): void {
    const id = tabsStore.getState().activeId;
    if (!id) return;
    if (next === "reading") {
      setPendingSuggestTab(null);
      // EditorPane's unmount cleanup flushes the pending autosave — the same
      // path the ⌘E toggle has always taken.
      tabsStore.getState().setMode(id, "read");
      return;
    }
    tabsStore.getState().setMode(id, "edit");
    if (next === "suggesting") {
      if (collab) {
        collab.suggestMode = true;
      } else {
        armedWireFailuresRef.current = wireFailures;
        setPendingSuggestTab(id);
      }
    } else {
      setPendingSuggestTab(null);
      if (collab) collab.suggestMode = false;
    }
  }

  type Segment = {
    id: DocMode;
    label: string;
    disabled: boolean;
    title: string | undefined;
  };
  // Short text labels: the full "Editing | Reading | Suggesting" set plus
  // presence chips overflowed the toolbar row at everyday window widths.
  const segments: Segment[] = [
    { id: "editing", label: "Edit", disabled: false, title: undefined },
    { id: "reading", label: "Read", disabled: false, title: undefined },
    {
      id: "suggesting",
      label: "Suggest",
      disabled: !canSuggest,
      title: canSuggest ? undefined : "Suggesting needs a synced document with a reachable server",
    },
  ];

  // Roving tabindex (WAI-ARIA APG radiogroup), with selection deliberately NOT
  // following focus: choosing Reading tears the whole editor down (and with it
  // any queued suggestion drafts), so arrows/Home/End move focus only and
  // Space/Enter/click commit. Focus MAY land on an aria-disabled segment: that
  // is the point of aria-disabled over the disabled attribute — perceivable
  // (its title/reason reachable by keyboard and hover) but never operable.
  const segmentEls = useRef<(HTMLButtonElement | null)[]>([]);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const checkedIndex = segments.findIndex((s) => s.id === mode);
  const checkedDisabled = checkedIndex !== -1 && segments[checkedIndex].disabled;
  // The group's single Tab stop rides the checked segment; when that segment
  // is unavailable (a checked Suggesting degrading to auth/volatile) it falls
  // back to the first enabled segment so Tab always lands on an operable
  // control. Editing is never disabled, so a fallback always exists.
  useEffect(() => {
    if (checkedIndex === -1) return;
    setFocusedIndex(checkedDisabled ? segments.findIndex((s) => !s.disabled) : checkedIndex);
    // segments is rebuilt per render; its inputs are checkedIndex/checkedDisabled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkedIndex, checkedDisabled]);

  function focusSegment(i: number): void {
    segmentEls.current[(i + segments.length) % segments.length]?.focus();
  }

  function activate(i: number): void {
    if (segments[i].disabled) return; // aria-disabled: focusable, never operable
    selectMode(segments[i].id);
  }

  function onKeydown(e: React.KeyboardEvent, i: number): void {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      focusSegment(i + 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      focusSegment(i - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusSegment(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusSegment(segments.length - 1);
    } else if (e.key === " " || e.key === "Enter") {
      // Explicit so activation cannot double-fire through the native button
      // click that would otherwise follow the key.
      e.preventDefault();
      activate(i);
    }
  }

  // Segmented control: recessed muted track, raised active pill (the design
  // system's pattern). Radio semantics stay: these are modes with exactly one
  // active, not tab panels. Geometry pinned to the toolbar row: 1.75rem
  // segments + 0.125rem track padding = the 2rem the neighbors render at.
  return (
    <div
      className="flex items-center rounded-lg bg-muted p-0.5"
      role="radiogroup"
      aria-label="Document mode"
    >
      {segments.map((seg, i) => (
        <button
          key={seg.id}
          ref={(el) => {
            segmentEls.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={mode === seg.id}
          aria-disabled={seg.disabled ? "true" : undefined}
          className={cn(
            "h-7 rounded-md px-2.5 text-[0.8rem] outline-none transition-colors select-none",
            "focus-visible:ring-2 focus-visible:ring-ring/50",
            mode === seg.id
              ? "bg-background font-semibold text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
            // Unavailable = aria-disabled, NEVER the disabled attribute: the
            // segment stays focusable and keeps pointer-events, so keyboard
            // and screen-reader users can reach it and mouse users still get
            // the title explaining why. Activation is ignored in the handlers.
            seg.disabled &&
              "cursor-not-allowed text-muted-foreground opacity-55 hover:text-muted-foreground",
          )}
          title={seg.title}
          tabIndex={focusedIndex === i ? 0 : -1}
          onClick={() => activate(i)}
          onKeyDown={(e) => onKeydown(e, i)}
          onFocus={() => setFocusedIndex(i)}
        >
          {seg.label}
        </button>
      ))}
    </div>
  );
}
