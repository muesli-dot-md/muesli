<script lang="ts" module>
  import type { Component } from "svelte";

  /** One entry of a context menu; "separator" draws a divider. */
  // `icon` is an optional leading Lucide component (e.g. the Starred toggle).
  export type MenuItem =
    | {
        label: string;
        action: () => void;
        disabled?: boolean;
        danger?: boolean;
        icon?: Component;
      }
    | "separator";
</script>

<script lang="ts">
  // Reusable fixed-position context menu (Drive-style). Closes on click-away,
  // Escape, scroll, and resize; ArrowUp/Down + Home/End move focus, Enter
  // activates (native buttons). The caller owns position + items.
  let { x, y, items, onclose }: { x: number; y: number; items: MenuItem[]; onclose: () => void } =
    $props();

  let el: HTMLDivElement | undefined = $state();
  // Clamp into the viewport after first render (menu size is content-driven).
  let left = $state(0);
  let top = $state(0);
  $effect(() => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
  });

  $effect(() => {
    const away = (e: Event) => {
      if (el && !el.contains(e.target as Node)) onclose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onclose();
      }
    };
    const close = () => onclose();
    // capture-phase so a scroll inside any container closes the menu too
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  });

  function buttons(): HTMLButtonElement[] {
    return el ? [...el.querySelectorAll<HTMLButtonElement>("button:not([disabled])")] : [];
  }

  // Focus the first item on open so Enter/arrows work immediately.
  $effect(() => {
    void items;
    queueMicrotask(() => buttons()[0]?.focus());
  });

  function onkeydown(e: KeyboardEvent) {
    const bs = buttons();
    if (bs.length === 0) return;
    const i = bs.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (e.key === "ArrowDown") next = i < 0 ? 0 : (i + 1) % bs.length;
    else if (e.key === "ArrowUp") next = i < 0 ? bs.length - 1 : (i - 1 + bs.length) % bs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = bs.length - 1;
    else if (e.key === "Tab") {
      onclose();
      return;
    } else return;
    e.preventDefault();
    bs[next]?.focus();
  }

  function run(item: Exclude<MenuItem, "separator">) {
    onclose();
    item.action();
  }
</script>

<div
  bind:this={el}
  class="fixed z-50 min-w-52 rounded-box border border-base-300 bg-base-100 py-1.5 shadow-lg"
  style:left="{left}px"
  style:top="{top}px"
  role="menu"
  tabindex="-1"
  {onkeydown}
  oncontextmenu={(e) => e.preventDefault()}
>
  {#each items as item, i (i)}
    {#if item === "separator"}
      <div class="my-1.5 border-t border-base-300/60" role="separator"></div>
    {:else}
      <button
        class="flex w-full items-center px-4 py-1.5 text-left text-sm hover:bg-base-200 focus:bg-base-200 focus:outline-none disabled:opacity-40 disabled:hover:bg-transparent {item.danger
          ? 'text-error'
          : ''}"
        role="menuitem"
        disabled={item.disabled}
        onclick={() => run(item)}
      >
        {#if item.icon}
          {@const Icon = item.icon}
          <Icon class="mr-2 h-4 w-4 shrink-0 opacity-70" aria-hidden="true" />
        {/if}
        {item.label}
      </button>
    {/if}
  {/each}
</div>
