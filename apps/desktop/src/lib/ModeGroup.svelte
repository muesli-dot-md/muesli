<script lang="ts">
  // Segmented [ Editing | Reading | Suggesting ] radiogroup: the single control
  // for the open document's mode.
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
  import { tabs } from "$lib/tabs.svelte";
  import { docCollab } from "$lib/collab/docCollab.svelte";
  import type { Availability } from "$lib/collab/collabStore.svelte";

  type DocMode = "editing" | "reading" | "suggesting";

  const collab = $derived(docCollab.store);
  const isReading = $derived(tabs.active()?.mode === "read");

  // Availability carried across Reading's store teardown: the last value the
  // active tab's store reported keeps gating the Suggesting segment while the
  // store is gone, so a doc that was auth/volatile-degraded before entering
  // Reading cannot offer Suggesting from inside it.
  let lastAvailability = $state<{ tab: string; value: Availability } | null>(null);
  $effect(() => {
    if (collab && tabs.activeId) {
      lastAvailability = { tab: tabs.activeId, value: collab.availability };
    }
  });
  const rememberedAvailability = $derived(
    lastAvailability !== null && lastAvailability.tab === tabs.activeId
      ? lastAvailability.value
      : null,
  );

  function degraded(a: Availability | null): boolean {
    return a === "auth" || a === "volatile";
  }

  // Suggesting needs a synced doc whose server is reachable and authorized:
  // with a live store that is its current availability; while Reading (store
  // torn down) it is the last availability this tab's store reported. Outside
  // those two cases (no store, not Reading — e.g. mid-remount) the segment
  // stays unavailable until a store materializes.
  const canSuggest = $derived(
    docCollab.isRemote &&
      (collab ? !degraded(collab.availability) : isReading && !degraded(rememberedAvailability)),
  );

  // A Suggesting choice made while the store doesn't exist yet (Reading view
  // tears it down). The intent's full lifecycle:
  //   armed   — selectMode("suggesting") with no store;
  //   applied — a store exists for the same tab and is NOT auth/volatile —
  //             the SAME availability gate a direct Suggesting click passes.
  //             "unknown" must count as applicable: refresh() keeps the last
  //             state on network errors and unexpected statuses, so a server
  //             that never answers cleanly leaves availability "unknown"
  //             forever, and an intent gated on "ok" would deadlock there
  //             while the direct click path worked fine.
  //   dropped — the active tab changes, the tab's mode becomes "read" again
  //             (any path: segment click, ⌘E, palette), another segment is
  //             chosen, the store lands already degraded, or the editor
  //             mount that should have produced the store completes without
  //             one (docCollab.wireFailures).
  // The intent can therefore never apply suggest mode to a different document,
  // from a pure ⌘E round-trip, or against a store known to be refused — and
  // it can never wait forever on a store (or an availability) that is not
  // coming.
  let pendingSuggestTab = $state<string | null>(null);
  // wireFailures baseline captured at arm time: a later bump means the mount
  // the intent was waiting on finished with no store.
  let armedWireFailures = 0;
  $effect(() => {
    if (pendingSuggestTab === null) return;
    if (
      tabs.activeId !== pendingSuggestTab ||
      isReading ||
      docCollab.wireFailures !== armedWireFailures
    ) {
      pendingSuggestTab = null;
      return;
    }
    if (!collab) return;
    if (!degraded(collab.availability)) collab.suggestMode = true;
    pendingSuggestTab = null; // applied, or dropped on a degraded store
  });

  // Reading wins while read mode is on; otherwise a live store's suggestMode
  // OR a pending intent picks Suggesting. The intent counts regardless of
  // store presence, so the checked segment never flickers through Editing
  // while a fresh store (suggestMode still false) is being wired up.
  const mode = $derived<DocMode>(
    isReading
      ? "reading"
      : collab?.suggestMode || pendingSuggestTab !== null
        ? "suggesting"
        : "editing",
  );

  function selectMode(next: DocMode): void {
    const id = tabs.activeId;
    if (!id) return;
    if (next === "reading") {
      pendingSuggestTab = null;
      // EditorPane's unmount cleanup flushes the pending autosave — the same
      // path the ⌘E toggle has always taken.
      tabs.setMode(id, "read");
      return;
    }
    tabs.setMode(id, "edit");
    if (next === "suggesting") {
      if (collab) {
        collab.suggestMode = true;
      } else {
        armedWireFailures = docCollab.wireFailures;
        pendingSuggestTab = id;
      }
    } else {
      pendingSuggestTab = null;
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
  // presence chips overflowed the toolbar row at everyday window widths,
  // wrapping the whole group onto a second line.
  const segments = $derived<Segment[]>([
    { id: "editing", label: "Edit", disabled: false, title: undefined },
    { id: "reading", label: "Read", disabled: false, title: undefined },
    {
      id: "suggesting",
      label: "Suggest",
      disabled: !canSuggest,
      title: canSuggest ? undefined : "Suggesting needs a synced document with a reachable server",
    },
  ]);

  // Roving tabindex (WAI-ARIA APG radiogroup), with selection deliberately NOT
  // following focus: choosing Reading tears the whole editor down (and with it
  // any queued suggestion drafts), so arrows/Home/End move focus only and
  // Space/Enter/click commit — the APG model for radiogroups whose selection
  // has side effects. Focus MAY land on an aria-disabled segment: that is the
  // point of aria-disabled over the disabled attribute — perceivable (its
  // title/reason reachable by keyboard and hover) but never operable.
  let segmentEls: (HTMLButtonElement | undefined)[] = $state([]);
  let focusedIndex = $state(0);
  const checkedIndex = $derived(segments.findIndex((s) => s.id === mode));
  // The group's single Tab stop rides the checked segment; when that segment
  // is unavailable (a checked Suggesting degrading to auth/volatile) it falls
  // back to the first enabled segment so Tab always lands on an operable
  // control. Editing is never disabled, so a fallback always exists.
  $effect(() => {
    if (checkedIndex === -1) return;
    focusedIndex = segments[checkedIndex].disabled
      ? segments.findIndex((s) => !s.disabled)
      : checkedIndex;
  });

  function focusSegment(i: number): void {
    segmentEls[(i + segments.length) % segments.length]?.focus();
  }

  function activate(i: number): void {
    if (segments[i].disabled) return; // aria-disabled: focusable, never operable
    selectMode(segments[i].id);
  }

  function onKeydown(e: KeyboardEvent, i: number): void {
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
</script>

<!-- daisyUI boxed tabs (recessed track, raised active pill) — the design
     system's own segmented-control pattern. Radio semantics stay: these are
     modes with exactly one active, not tab panels. -->
<div class="mode-group tabs tabs-box tabs-sm" role="radiogroup" aria-label="Document mode">
  {#each segments as seg, i (seg.id)}
    <button
      bind:this={segmentEls[i]}
      type="button"
      role="radio"
      aria-checked={mode === seg.id}
      aria-disabled={seg.disabled ? "true" : undefined}
      class="tab {mode === seg.id ? 'tab-active font-semibold' : ''}"
      title={seg.title}
      tabindex={focusedIndex === i ? 0 : -1}
      onclick={() => activate(i)}
      onkeydown={(e) => onKeydown(e, i)}
      onfocus={() => (focusedIndex = i)}
    >
      {seg.label}
    </button>
  {/each}
</div>

<style>
  /* The active pill's raised card + shadow is tabs-box's selected cue; the
     semibold label adds the non-color reinforcement (matching the pattern's
     use elsewhere in the product family). */
  /* Geometry pinned to the toolbar row: tabs-sm tabs are 2rem tall and the
     boxed track adds 0.25rem padding around them (~2.5rem total), towering
     over the row's 2rem btn-sm controls. 1.75rem tabs + 0.125rem track
     padding = exactly the 2rem the neighbors render at. */
  .mode-group {
    padding: 0.125rem;
    --tab-height: 1.75rem;
  }
  /* Unavailable = aria-disabled, NEVER the disabled attribute: the segment
     stays focusable and keeps pointer-events, so keyboard and screen-reader
     users can reach it and mouse users still get the title explaining why
     (a natively disabled control drops both). Activation is ignored in the
     handlers instead. */
  .mode-group .tab[aria-disabled="true"] {
    color: var(--text-muted);
    opacity: 0.55;
    cursor: not-allowed;
  }
</style>
