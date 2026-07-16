<script lang="ts">
  // One chip per *person* (already deduped/grouped upstream), with a 2-chip + ⊕N
  // overflow that opens a roster popover. Mirrors the webapp header presence stack.
  import { initials, splitForStack, type PresencePerson } from "$lib/presence";

  let { people }: { people: PresencePerson[] } = $props();

  const stack = $derived(splitForStack(people));

  let rosterOpen = $state(false);
  let rootEl: HTMLDivElement | null = $state(null);

  function onPointer(e: PointerEvent) {
    if (rosterOpen && rootEl && !rootEl.contains(e.target as Node)) rosterOpen = false;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && rosterOpen) {
      e.preventDefault();
      rosterOpen = false;
    }
  }
  $effect(() => {
    if (!rosterOpen) return;
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
    };
  });
</script>

{#if people.length > 0}
  <div class="relative flex items-center" bind:this={rootEl}>
    {#each stack.visible as p (p.key)}
      <div class="tooltip tooltip-bottom -ml-1.5 first:ml-0" data-tip={p.name}>
        {#if p.avatar}
          <img
            class="presence-avatar h-7 w-7 rounded-full ring-2 ring-base-100"
            src={p.avatar}
            alt={p.name}
            referrerpolicy="no-referrer"
          />
        {:else}
          <span
            class="flex h-7 w-7 items-center justify-center rounded-full text-[0.65rem] font-semibold text-white ring-2 ring-base-100"
            style:background-color={p.color}
            aria-label={p.name}
          >
            {p.kind === "agent" ? "✦" : initials(p.name)}
          </span>
        {/if}
      </div>
    {/each}
    {#if stack.overflow > 0}
      <button
        type="button"
        class="-ml-1.5 flex h-7 min-w-7 items-center justify-center rounded-full ring-2 ring-base-100 transition-transform active:scale-[0.96]"
        title={`${stack.overflow} more`}
        aria-haspopup="true"
        aria-expanded={rosterOpen}
        onclick={() => (rosterOpen = !rosterOpen)}
      >
        <span
          class="flex h-7 min-w-7 items-center justify-center rounded-full bg-base-300 px-1 text-[0.65rem] font-semibold"
        >
          ⊕{stack.overflow}
        </span>
      </button>
    {/if}
    {#if rosterOpen}
      <div
        class="absolute right-0 top-full z-20 mt-1.5 max-h-80 w-56 overflow-y-auto rounded-box border border-base-300 bg-base-100 p-2 shadow"
        role="menu"
      >
        <p class="px-1.5 pb-1 text-xs font-semibold opacity-60">People here</p>
        <ul class="flex flex-col gap-0.5">
          {#each people as p (p.key)}
            <li class="flex items-center gap-2 rounded px-1.5 py-1">
              {#if p.avatar}
                <img
                  class="presence-avatar h-6 w-6 shrink-0 rounded-full"
                  src={p.avatar}
                  alt={p.name}
                  referrerpolicy="no-referrer"
                />
              {:else}
                <span
                  class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[0.6rem] font-semibold text-white"
                  style:background-color={p.color}
                  aria-hidden="true"
                >
                  {p.kind === "agent" ? "✦" : initials(p.name)}
                </span>
              {/if}
              <span class="truncate text-sm">{p.name}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Hairline outline keeps avatar photos from melting into the chrome on
     either theme. outline (not border) so it never shifts layout. */
  :global(.presence-avatar) {
    outline: 1px solid rgba(0, 0, 0, 0.1);
    outline-offset: -1px;
  }
  :global([data-theme="arc-dark"] .presence-avatar) {
    outline-color: rgba(255, 255, 255, 0.1);
  }
</style>
