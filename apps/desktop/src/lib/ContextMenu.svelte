<script lang="ts" module>
  import type { Icon as LucideIcon } from 'lucide-svelte';

  /** A lucide-svelte icon component (legacy class-component constructor shape). */
  export type MenuIcon = typeof LucideIcon;

  /** One entry of a context menu; "separator" draws a divider between groups. */
  export type MenuItem =
    | {
        label: string;
        action: () => void;
        disabled?: boolean;
        danger?: boolean;
        icon?: MenuIcon;
      }
    | 'separator';
</script>

<script lang="ts">
  // Reusable fixed-position context menu (Drive-style), adapted from the webapp's
  // ContextMenu.svelte for the desktop. Closes on click-away, Escape, scroll, and
  // resize; ArrowUp/Down + Home/End move focus, Enter activates. The caller owns
  // position + items. Styled with the desktop's arc theme tokens (overlay surface,
  // soft shadow, concentric radius) and grouped via "separator" entries.
  let {
    x,
    y,
    items,
    onclose,
  }: { x: number; y: number; items: MenuItem[]; onclose: () => void } = $props();

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
      if (e.key === 'Escape') {
        e.stopPropagation();
        onclose();
      }
    };
    const close = () => onclose();
    // capture-phase so a scroll inside any container closes the menu too
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  });

  function buttons(): HTMLButtonElement[] {
    return el ? [...el.querySelectorAll<HTMLButtonElement>('button:not([disabled])')] : [];
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
    let next = -1;
    if (e.key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % bs.length;
    else if (e.key === 'ArrowUp') next = i < 0 ? bs.length - 1 : (i - 1 + bs.length) % bs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = bs.length - 1;
    else if (e.key === 'Tab') {
      onclose();
      return;
    } else return;
    e.preventDefault();
    bs[next]?.focus();
  }

  function run(item: Exclude<MenuItem, 'separator'>) {
    onclose();
    item.action();
  }
</script>

<div
  bind:this={el}
  class="ctx-menu fixed z-50 min-w-52 py-1.5"
  style:left="{left}px"
  style:top="{top}px"
  style="background: var(--overlay); box-shadow: var(--shadow-overlay); border-radius: var(--radius-overlay, 0.875rem);"
  role="menu"
  tabindex="-1"
  {onkeydown}
  oncontextmenu={(e) => e.preventDefault()}
>
  {#each items as item}
    {#if item === 'separator'}
      <div class="my-1.5 border-t border-base-300/60" role="separator"></div>
    {:else}
      <button
        class="ctx-item flex w-full items-center gap-2 px-3.5 text-left text-sm hover:bg-base-200 focus:bg-base-200 focus:outline-none disabled:opacity-40 disabled:hover:bg-transparent {item.danger
          ? 'text-error'
          : 'text-base-content'}"
        role="menuitem"
        disabled={item.disabled}
        onclick={() => run(item)}
      >
        {#if item.icon}
          {@const Icon = item.icon}
          <Icon size={15} class="shrink-0 opacity-70" aria-hidden="true" />
        {/if}
        {item.label}
      </button>
    {/if}
  {/each}
</div>

<style>
  /* ≥40px hit area per row; press feedback; no `transition: all`. */
  .ctx-item {
    min-height: 32px;
    padding-top: 0.3rem;
    padding-bottom: 0.3rem;
    transition: background-color 100ms ease, transform 70ms ease;
  }
  .ctx-item:active {
    transform: scale(0.985);
  }
  .ctx-menu {
    animation: ctx-pop 110ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes ctx-pop {
    from {
      opacity: 0;
      transform: translateY(-4px) scale(0.97);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ctx-menu {
      animation: none;
    }
    .ctx-item {
      transition: none;
    }
    .ctx-item:active {
      transform: none;
    }
  }
</style>
