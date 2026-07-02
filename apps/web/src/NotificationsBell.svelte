<script lang="ts">
  // Notification bell + unread badge + inbox panel (sub-project ④c). Lives in the doc top bar.
  // Polls the unread-count for the badge; opening the panel loads the list. Clicking a
  // notification marks it read and navigates to its document. In-app delivery IS this panel —
  // the rows are the notifications the server enqueued. Auth-only: the caller renders this only
  // when signed in.
  import Bell from "@lucide/svelte/icons/bell";
  import BellOff from "@lucide/svelte/icons/bell-off";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import { onDestroy } from "svelte";
  import { relativeTime } from "./collabStore.svelte";
  import { t } from "./i18n/index.svelte";
  import { httpBase } from "./identity";
  import { createNotificationsApi, type Notification } from "./notificationsApi";
  import { colorFromId } from "./presence";
  import { gotoDoc } from "./route.svelte";

  const api = createNotificationsApi({ httpBase });

  let unread = $state(0);
  let items: Notification[] = $state([]);
  let open = $state(false);
  let loading = $state(false);
  let errored = $state(false);
  let root: HTMLDivElement | undefined = $state();

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
      // silent — the badge just stays put on a transient failure.
    }
  }

  async function loadList() {
    loading = true;
    errored = false;
    try {
      items = (await api.list()).notifications;
    } catch {
      items = [];
      errored = true;
    } finally {
      loading = false;
    }
  }

  function toggle() {
    open = !open;
    if (open) void loadList();
  }

  // While open, close on outside-click or Escape. We can't rely on focus/blur because
  // WebKit doesn't focus a <button> on click, so the panel is driven purely by `open`.
  $effect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (root && !root.contains(e.target as Node)) open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") open = false;
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  });

  function actorOf(n: Notification): string {
    return n.payload.actor_name || t("notifications.someone");
  }
  function docOf(n: Notification): string {
    return n.payload.doc_title || n.payload.doc_slug || "";
  }

  async function activate(n: Notification) {
    open = false;
    if (!n.read) {
      // Optimistic local read; the badge reflects it immediately.
      items = items.map((x) => (x.id === n.id ? { ...x, read: true } : x));
      unread = Math.max(0, unread - 1);
      try {
        await api.markRead(n.id);
      } catch {
        void refreshCount();
      }
    }
    const slug = n.payload.doc_slug;
    if (slug) gotoDoc(slug);
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

  // Badge polling: piggy-backs the same cadence collab polling uses elsewhere (a few seconds).
  void refreshCount();
  const timer = setInterval(refreshCount, 5000);
  onDestroy(() => clearInterval(timer));
</script>

<div class="dropdown dropdown-end {open ? 'dropdown-open' : ''}" bind:this={root}>
  <button
    type="button"
    class="btn btn-circle btn-ghost btn-sm min-h-10 min-w-10 transition-transform active:scale-[0.96]"
    aria-label={t("notifications.title")}
    title={t("notifications.title")}
    onclick={toggle}
  >
    <div class="indicator">
      {#if unread > 0}
        <span class="indicator-item badge badge-primary badge-xs tabular-nums">
          {unread > 99 ? "99+" : unread}
        </span>
      {/if}
      <Bell class="h-4 w-4" aria-hidden="true" />
    </div>
  </button>

  {#if open}
    <div
      class="dropdown-content z-20 mt-1 max-h-96 w-80 overflow-y-auto rounded-box border border-base-300 bg-base-100 p-2 shadow"
    >
      <div class="flex items-center justify-between px-2 py-1">
        <span class="text-sm font-semibold">{t("notifications.title")}</span>
        {#if items.some((n) => !n.read)}
          <button
            class="btn btn-ghost btn-xs transition-transform active:scale-[0.96]"
            onclick={markAll}
          >
            {t("notifications.markAllRead")}
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
      {:else if errored}
        <div class="flex flex-col items-center gap-2 px-2 py-6 text-center text-sm opacity-60">
          <TriangleAlert class="h-5 w-5" aria-hidden="true" />
          <span>{t("notifications.loadError")}</span>
        </div>
      {:else if items.length === 0}
        <div class="flex flex-col items-center gap-2 px-2 py-6 text-center text-sm opacity-60">
          <BellOff class="h-5 w-5" aria-hidden="true" />
          <span>{t("notifications.empty")}</span>
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
                  <span class="block truncate text-sm whitespace-normal">
                    {t("notifications.mentionedYou", { actor: actorOf(n), doc: docOf(n) })}
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
