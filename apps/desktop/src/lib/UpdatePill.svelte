<script lang="ts">
  // Arc-style "update ready" pill at the bottom of the left sidebar with a
  // popover on hover/click/focus (spec 2026-07-02 §3). AppShell renders this
  // only while `updates.pillVisible` is true, so mounting doubles as the
  // slide-up entrance. Dismissal mirrors WorkspaceMenu's <svelte:window>
  // pattern (outside pointerdown + Escape), plus mouse-leave since the popover
  // is hover-driven. keymap.ts is untouched: this popover is not an
  // EscapeLayers target, and the window-Escape fallback no-ops when no tracked
  // overlay is open.
  import { updates } from "$lib/updates.svelte";
  import { settings } from "$lib/settings.svelte";

  let open = $state(false);
  let installing = $state(false);

  const label = $derived.by(() => {
    if (updates.failureMessage) return "Update failed";
    if (updates.state === "downloading") {
      const p = updates.progress;
      return p?.total
        ? `Downloading… ${Math.min(100, Math.round((p.downloaded / p.total) * 100))}%`
        : "Downloading…";
    }
    return "New Muesli version available";
  });

  function onWindowPointerDown(e: PointerEvent) {
    if (!open) return;
    if (!(e.target as HTMLElement)?.closest?.("[data-update-pill]")) open = false;
  }
  function onWindowKeydown(e: KeyboardEvent) {
    if (open && e.key === "Escape") {
      e.preventDefault();
      open = false;
    }
  }

  async function restartAndUpdate() {
    if (installing) return;
    installing = true;
    try {
      await updates.installAndRelaunch();
    } finally {
      installing = false;
    }
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="relative shrink-0 px-2 pb-2"
  data-update-pill
  onmouseenter={() => (open = true)}
  onmouseleave={() => (open = false)}
>
  <!-- The pill: full sidebar width minus padding, subtle raised background,
       slide-up entrance. Focus/click open the same popover for keyboard users.
       The trigger sits FIRST in document order so forward Tab reaches the
       popover controls (checkbox → Restart); the popover still renders
       visually above via its absolute bottom-full anchoring. -->
  <button
    class="update-pill arc-tap w-full truncate rounded-full px-3 py-1.5 text-left text-xs font-medium"
    onclick={() => (open = true)}
    onfocus={() => (open = true)}
    aria-haspopup="dialog"
    aria-expanded={open}
  >
    {label}
  </button>
  {#if open}
    <!-- Popover anchored above the pill: version title, Automatic Updates
         checkbox, primary Restart and Update. -->
    <div
      class="absolute inset-x-2 bottom-full z-50 mb-1.5 rounded-xl bg-base-100 p-3 shadow-[var(--shadow-overlay)] ring-1 ring-base-content/10"
      role="dialog"
      aria-label="Update Muesli"
    >
      <p class="text-sm font-medium">Muesli {updates.version ?? ""}</p>
      {#if updates.failureMessage}
        <p class="mt-1 text-xs text-error">{updates.failureMessage}</p>
      {/if}
      <label class="mt-2 flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          class="checkbox checkbox-xs"
          checked={settings.autoUpdate}
          onchange={(e) => settings.setAutoUpdate(e.currentTarget.checked)}
        />
        Automatic Updates
      </label>
      <button
        class="btn btn-primary btn-xs mt-2 w-full"
        onclick={restartAndUpdate}
        disabled={installing || updates.state === "downloading" || updates.state === "checking"}
      >
        Restart and Update
      </button>
    </div>
  {/if}
</div>

<style>
  .update-pill {
    background: var(--lift);
    box-shadow: var(--shadow-lift);
    animation: update-pill-in 160ms ease-out;
  }
  @keyframes update-pill-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
</style>
