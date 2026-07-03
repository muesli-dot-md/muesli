<script lang="ts">
  // Reusable, on-brand error shell (Commit 2). A blank centered page — Muesli
  // mark, a title, a short message, and one action — used for not-found,
  // no-access, and generic-crash surfaces instead of dumping raw errors or a
  // white screen. Clear props so callers stay declarative. Yjs-free, DOM-free
  // aside from the optional reload action.
  import { gotoHome } from "./route.svelte";
  import { t } from "./i18n/index.svelte";

  let {
    title,
    message,
    /** Which action button to show. "home" routes to the dashboard; "reload"
     *  does a hard reload (for the generic crash boundary); "none" shows none. */
    action = "home",
    /** Optional custom handler; overrides the built-in "home"/"reload" behavior. */
    onaction,
  }: {
    title: string;
    message: string;
    action?: "home" | "reload" | "none";
    onaction?: () => void;
  } = $props();

  function runAction() {
    if (onaction) return onaction();
    if (action === "reload") location.reload();
    else gotoHome();
  }
</script>

<main
  class="flex min-h-screen flex-col items-center justify-center bg-base-200 px-6 text-base-content antialiased"
>
  <div class="flex w-full max-w-sm flex-col items-center gap-5 text-center">
    <span class="text-5xl leading-none" aria-hidden="true">🥣</span>
    <div class="flex flex-col gap-2">
      <h1 class="text-xl font-semibold tracking-tight" style="text-wrap: balance;">{title}</h1>
      <p class="text-sm opacity-60" style="text-wrap: pretty;">{message}</p>
    </div>
    {#if action !== "none"}
      <button
        class="btn btn-primary rounded-field transition-transform active:scale-[0.96]"
        onclick={runAction}
      >
        {action === "reload" ? t("error.reload") : t("error.backHome")}
      </button>
    {/if}
  </div>
</main>
