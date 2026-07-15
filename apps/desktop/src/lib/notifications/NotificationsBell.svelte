<script lang="ts">
  // Notification bell + unread badge + inbox panel (sub-project ④c), desktop edition.
  // Routes through the authenticated `api_request` Tauri command (token stays in the
  // Keychain). Polls the unread-count for the badge; opening the panel loads the list;
  // clicking a row marks it read. Desktop deep-linking from a notification is a later nicety
  // (per the spec, inbox links target the webapp), so a click marks-read only — it does not
  // navigate. Shown only when signed in (the caller gates on workspaces.identity).
  import { Bell, BellOff, LogIn, TriangleAlert } from "lucide-svelte";
  import { onDestroy } from "svelte";
  import { relativeTime } from "$lib/collab/collabStore.svelte";
  import { ApiError } from "$lib/collab/apiRequest";
  import { colorFromId } from "$lib/presence";
  import { sidebars } from "$lib/sidebars.svelte";
  import { createNotificationsApi, type Notification } from "./notificationsApi";
  import { clampPanelLeft, clampPanelMaxHeight, clampPanelTop } from "./panelPosition";

  let {
    server,
    /** Opens AppShell's sign-in dialog — reused verbatim from WorkspaceMenu's
     *  `onsignin` prop so there is exactly one sign-in entry point in the app. */
    onsignin,
  }: { server: string; onsignin: () => void } = $props();

  const api = $derived(createNotificationsApi(server));

  let unread = $state(0);
  let items: Notification[] = $state([]);
  let open = $state(false);
  let loading = $state(false);
  let errored = $state(false);
  // A 403 specifically means the stored Bearer token is not (or no longer) recognized
  // as the desktop's own device-login token (auth.rs's TokenKind — a pre-migration
  // token, or one somehow revoked/reissued as delegated). Retrying won't help; only a
  // fresh sign-in mints a new token. Kept distinct from `errored` so the panel can point
  // at the fix instead of a generic "couldn't load" dead end.
  let forbidden = $state(false);
  let root: HTMLDivElement | undefined = $state();
  let panel: HTMLDivElement | undefined = $state();

  // The bell lives in the sidebar header, near the window's left edge, so a fixed-width
  // panel right-aligned under it (the old `dropdown-end` look) can extend past the left
  // edge of the window. Position it ourselves and clamp into the viewport instead — same
  // fix as ContextMenu.svelte's viewport clamp, both horizontal (left) and vertical (top):
  // a short window can otherwise push the panel below the bottom edge just as easily as a
  // narrow one pushes it past the left edge. `panelMaxHeight` is the same idea applied to
  // height instead of position: a static max-h-96 still overflows an unreachable amount in
  // a short window (the fixed panel has no page scroll to fall back on), so clamp it to
  // whatever room is actually left below `panelTop`.
  let panelLeft = $state(0);
  let panelTop = $state(0);
  let panelMaxHeight = $state(384);

  function reposition() {
    if (!root || !panel) return;
    const anchor = root.getBoundingClientRect();
    const size = panel.getBoundingClientRect();
    panelLeft = clampPanelLeft(anchor.right - size.width, size.width, window.innerWidth);
    panelTop = clampPanelTop(anchor.bottom + 4, size.height, window.innerHeight);
    panelMaxHeight = clampPanelMaxHeight(panelTop, window.innerHeight);
  }

  $effect(() => {
    if (!open || !root || !panel) return;
    // Track the left sidebar's width too: dragging ResizeHandle (sidebars.setLeft) moves
    // the bell itself (AppShell.svelte binds the aside's width to sidebars.left), so this
    // effect must re-run and re-measure the anchor when that happens, not just on open —
    // otherwise the panel is stranded at the coordinates computed before the drag.
    void sidebars.left;
    reposition();
  });

  // The measurement above can run while the loading skeleton is still showing (loadList
  // isn't awaited from `toggle`) and never again once the real list swaps in — so a
  // panel that grows taller than the skeleton (or shrinks/grows again on a later
  // refresh) drifts out of its clamped position/height. A ResizeObserver re-measures
  // whenever the panel's own content changes size, independent of what caused it.
  $effect(() => {
    if (!open || !panel) return;
    const ro = new ResizeObserver(() => reposition());
    ro.observe(panel);
    return () => ro.disconnect();
  });

  // Subtle staggered enter for list rows — skipped under reduced-motion so the panel
  // just appears. ~60ms/row, capped so a long list never feels slow.
  const reducedMotion =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function rowIn(_node: Element, { index }: { index: number }) {
    if (reducedMotion) return {};
    return { delay: Math.min(index, 6) * 60, duration: 160, y: 4 };
  }

  async function refreshCount() {
    try {
      unread = (await api.unreadCount()).count;
    } catch {
      // silent — transient failures leave the badge as-is.
    }
  }

  async function loadList() {
    loading = true;
    errored = false;
    forbidden = false;
    try {
      items = (await api.list()).notifications;
    } catch (e) {
      items = [];
      if (e instanceof ApiError && e.status === 403) {
        forbidden = true;
      } else {
        errored = true;
      }
    } finally {
      loading = false;
    }
  }

  function toggle() {
    open = !open;
    if (open) void loadList();
  }

  // While open, close on outside-click, Escape, an outside scroll, or a window resize. We
  // can't rely on focus/blur because WebKit (the WKWebView) doesn't focus a <button> on
  // click, so the panel is driven purely by `open`. Listener style matches
  // ContextMenu.svelte (capture-phase pointerdown/keydown/scroll, close outright on
  // resize rather than reposition) for consistency, with one deliberate difference: the
  // scroll listener ignores scrolls that originate inside the panel itself, because unlike
  // the context menu this panel has genuine scrollable content (`overflow-y-auto` over a
  // long notification list) — closing on every internal scroll tick would make the list
  // unusable.
  $effect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (root && !root.contains(e.target as Node)) open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") open = false;
    };
    const onScroll = (e: Event) => {
      if (panel && !panel.contains(e.target as Node)) open = false;
    };
    const onResize = () => {
      open = false;
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  });

  function actorOf(n: Notification): string {
    return n.payload.actor_name || "Someone";
  }
  function docOf(n: Notification): string {
    return n.payload.doc_title || n.payload.doc_slug || "";
  }

  async function activate(n: Notification) {
    if (n.read) return;
    items = items.map((x) => (x.id === n.id ? { ...x, read: true } : x));
    unread = Math.max(0, unread - 1);
    try {
      await api.markRead(n.id);
    } catch {
      void refreshCount();
    }
  }

  async function markAll() {
    try {
      await api.markAllRead();
      items = items.map((x) => ({ ...x, read: true }));
      unread = 0;
    } catch {
      void refreshCount();
    }
  }

  // Badge polling on the same cadence the collab layer uses.
  void refreshCount();
  const timer = setInterval(refreshCount, 5000);
  onDestroy(() => clearInterval(timer));
</script>

<div class="relative" bind:this={root}>
  <button
    type="button"
    class="btn btn-ghost btn-sm btn-square min-h-10 min-w-10 text-base-content/60 transition-transform hover:text-base-content active:scale-[0.96]"
    title="Notifications"
    aria-label="Notifications"
    onclick={toggle}
  >
    <div class="indicator">
      {#if unread > 0}
        <span class="indicator-item badge badge-primary badge-xs tabular-nums">
          {unread > 99 ? "99+" : unread}
        </span>
      {/if}
      <Bell size={16} />
    </div>
  </button>

  {#if open}
    <div
      bind:this={panel}
      class="fixed z-30 w-80 overflow-y-auto rounded-box border border-base-300 bg-base-100 p-2 shadow-lg"
      style:left="{panelLeft}px"
      style:top="{panelTop}px"
      style:max-width="calc(100vw - 16px)"
      style:max-height="{panelMaxHeight}px"
    >
      <div class="flex items-center justify-between px-2 py-1">
        <span class="text-sm font-semibold">Notifications</span>
        {#if items.some((n) => !n.read)}
          <button
            class="btn btn-ghost btn-xs transition-transform active:scale-[0.96]"
            onclick={markAll}
          >
            Mark all read
          </button>
        {/if}
      </div>

      {#if loading}
        <ul class="flex w-full flex-col gap-0.5" aria-hidden="true">
          {#each Array(4) as _, i (i)}
            <li class="flex items-start gap-2 rounded-md p-2">
              <span class="skeleton mt-0.5 h-6 w-6 shrink-0 rounded-full"></span>
              <span class="flex min-w-0 flex-1 flex-col gap-1.5">
                <span class="skeleton h-3.5 w-full rounded"></span>
                <span class="skeleton h-3 w-1/3 rounded"></span>
              </span>
            </li>
          {/each}
        </ul>
      {:else if forbidden}
        <div class="flex flex-col items-center gap-2 px-2 py-6 text-center text-sm opacity-60">
          <LogIn size={20} aria-hidden="true" />
          <span>Sign in again to see notifications.</span>
          <button
            type="button"
            class="btn btn-ghost btn-xs transition-transform active:scale-[0.96]"
            onclick={() => {
              open = false;
              onsignin();
            }}
          >
            Sign in
          </button>
        </div>
      {:else if errored}
        <div class="flex flex-col items-center gap-2 px-2 py-6 text-center text-sm opacity-60">
          <TriangleAlert size={20} aria-hidden="true" />
          <span>Couldn't load notifications.</span>
        </div>
      {:else if items.length === 0}
        <div class="flex flex-col items-center gap-2 px-2 py-6 text-center text-sm opacity-60">
          <BellOff size={20} aria-hidden="true" />
          <span>You're all caught up.</span>
        </div>
      {:else}
        <ul class="flex w-full flex-col gap-0.5">
          {#each items as n, i (n.id)}
            {@const color = n.actor_id ? colorFromId(n.actor_id).color : "var(--text-muted)"}
            <li in:rowIn={{ index: i }}>
              <button
                type="button"
                class="flex min-h-10 w-full items-start gap-2 rounded-md p-2 text-left transition-[transform,background-color] hover:bg-base-200 active:scale-[0.96] {n.read
                  ? 'opacity-70'
                  : 'bg-base-200/60 font-medium'}"
                onclick={() => activate(n)}
              >
                <span
                  class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[0.6rem] font-semibold text-white"
                  style:background-color={color}
                  aria-hidden="true"
                >
                  {actorOf(n).trim().charAt(0).toUpperCase()}
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block text-sm">
                    {actorOf(n)} mentioned you in «{docOf(n)}»
                  </span>
                  <span class="block text-xs opacity-50">{relativeTime(n.created_at)}</span>
                </span>
                {#if !n.read}
                  <span class="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden="true"
                  ></span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
