<script lang="ts">
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import { onMount } from "svelte";
  import { authorName, relativeTime } from "./collabStore.svelte";
  import type { Thread } from "./collabApi";
  import MentionText from "./MentionText.svelte";
  import { mentionAutocomplete } from "./mentionAction.svelte";
  import { createGraphApi, type IncomingLink } from "./graphApi";
  import { t } from "./i18n/index.svelte";
  import { httpBase } from "./identity";
  import { gotoDoc } from "./route.svelte";
  import { useDocSession } from "./session.svelte";

  const { docId, shareToken, store: collab } = useDocSession();

  let replyDrafts: Record<string, string> = $state({});

  async function sendReply(thread: Thread) {
    const body = (replyDrafts[thread.id] ?? "").trim();
    if (!body) return;
    if (await collab.reply(thread.id, body)) replyDrafts[thread.id] = "";
  }

  // Linked mentions (ADR 0015): documents whose wikilinks / relative md links point at
  // this one. Loaded once when the panel mounts; errors (volatile / signed out) just
  // hide the section — the comments UI above already explains those states.
  let backlinks: IncomingLink[] = $state([]);
  let backlinksLoaded = $state(false);

  onMount(async () => {
    try {
      const api = createGraphApi({ httpBase, shareToken });
      backlinks = (await api.getDocumentLinks(docId)).incoming;
      backlinksLoaded = true;
    } catch {
      backlinksLoaded = false;
    }
  });

  function openDoc(slug: string) {
    if (!slug || slug === docId) return;
    gotoDoc(slug); // SPA hash navigation; DocApp remounts on the new slug
  }

  // Editor → sidebar: clicking a comment highlight sets revealThreadId; scroll
  // its card into view and flash it so the thread (and replies) are obvious.
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const threadId = collab.revealThreadId;
    if (!threadId) return;
    collab.revealThreadId = null;
    const el = document.getElementById(`muesli-thread-${threadId}`);
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    el.classList.add("muesli-thread-flash");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove("muesli-thread-flash"), 1600);
  });
</script>

{#snippet threadCard(thread: Thread, orphaned: boolean)}
  <!-- card-border is too faint (daisyUI uses base-200): real base-300 border +
       the search-pill's soft shadow so each thread reads as its own surface -->
  <div
    id="muesli-thread-{thread.id}"
    class="card border border-base-300 bg-base-100 shadow-sm transition-shadow hover:shadow {orphaned
      ? 'opacity-80'
      : ''}"
    role="button"
    tabindex="0"
    onclick={() => !orphaned && collab.focusRange(thread.range)}
    onkeydown={(e) => e.key === "Enter" && !orphaned && collab.focusRange(thread.range)}
  >
    <div class="card-body gap-2 p-3">
      {#each thread.comments as comment, i (comment.id)}
        <!-- replies (i > 0) indent + a thread spine so they read as answers to the first comment -->
        <div class={i > 0 ? "border-l border-base-300 pl-3 ml-1" : ""}>
          <div class="flex items-baseline justify-between gap-2">
            <span class="text-xs font-semibold">{authorName(comment.author)}</span>
            <div class="flex items-center gap-1">
              <span class="text-xs opacity-50">{relativeTime(comment.created_at)}</span>
              {#if i === 0}
                {#if thread.status === "resolved"}
                  <!-- Reopen, NOT another checkmark: a second ✓ here read as
                       "this is resolved" and nobody guessed it undoes it. -->
                  <button
                    class="btn btn-ghost btn-xs btn-circle min-h-0 h-6 w-6 active:scale-[0.96]"
                    title={t("comments.reopenThread")}
                    aria-label={t("comments.reopenThread")}
                    onclick={(e) => {
                      e.stopPropagation();
                      collab.reopenThread(thread.id);
                    }}
                  >
                    <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                {:else}
                  <button
                    class="btn btn-ghost btn-xs btn-circle min-h-0 h-6 w-6 active:scale-[0.96]"
                    title={t("comments.resolveThread")}
                    aria-label={t("comments.resolveThread")}
                    onclick={(e) => {
                      e.stopPropagation();
                      collab.resolveThread(thread.id);
                    }}
                  >
                    ✓
                  </button>
                {/if}
              {/if}
            </div>
          </div>
          <p class="mt-0.5 text-sm">
            <MentionText body={comment.body} knownIds={collab.mentionableIds} />
          </p>
        </div>
      {/each}
      <div class="mt-1 flex items-center gap-1">
        <input
          class="input input-xs flex-1"
          placeholder={t("comments.replyPlaceholder")}
          bind:value={replyDrafts[thread.id]}
          use:mentionAutocomplete={{ members: collab.members }}
          onclick={(e) => e.stopPropagation()}
          onkeydown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") sendReply(thread);
          }}
        />
      </div>
    </div>
  </div>
{/snippet}

<div class="flex flex-col gap-3 p-3">
  {#if collab.availability === "auth"}
    <p class="px-1 py-6 text-center text-sm opacity-60">{t("comments.signInToView")}</p>
  {:else}
    <p class="px-1 text-xs opacity-60">
      {t("comments.hintPre")}
      <span class="font-medium">{t("editor.commentAction")}</span>
      {t("comments.hintPost")}
    </p>

    {#if collab.openThreads.length === 0 && collab.orphanedThreads.length === 0 && collab.resolvedThreads.length === 0}
      <p class="px-1 py-4 text-center text-sm opacity-50">{t("comments.none")}</p>
    {/if}

    {#each collab.openThreads as thread (thread.id)}
      {@render threadCard(thread, false)}
    {/each}

    {#if collab.orphanedThreads.length > 0}
      <div class="divider my-1 text-xs opacity-70">{t("comments.onDeletedText")}</div>
      <p class="-mt-2 px-1 text-xs opacity-50">
        {t("comments.orphanNote")}
      </p>
      {#each collab.orphanedThreads as thread (thread.id)}
        {@render threadCard(thread, true)}
      {/each}
    {/if}

    {#if collab.resolvedThreads.length > 0}
      <div class="collapse-arrow collapse rounded-box border border-base-300 bg-base-100">
        <input type="checkbox" />
        <div class="collapse-title min-h-0 px-3 py-2 text-sm font-medium">
          {t("comments.resolvedCount", { count: collab.resolvedThreads.length })}
        </div>
        <div class="collapse-content flex flex-col gap-2 px-2">
          {#each collab.resolvedThreads as thread (thread.id)}
            {@render threadCard(thread, false)}
          {/each}
        </div>
      </div>
    {/if}

    {#if backlinksLoaded}
      <div class="collapse-arrow collapse rounded-box border border-base-300 bg-base-100">
        <input type="checkbox" checked={backlinks.length > 0} />
        <div class="collapse-title min-h-0 px-3 py-2 text-sm font-medium">
          {t("comments.linkedMentions", { count: backlinks.length })}
        </div>
        <div class="collapse-content px-2">
          {#if backlinks.length === 0}
            <p class="px-1 pb-2 text-xs opacity-50">
              {t("comments.noBacklinksPre")}
              <span class="font-mono">[[{docId}]]</span>
              {t("comments.noBacklinksPost")}
            </p>
          {:else}
            <ul class="menu menu-sm w-full p-0">
              {#each backlinks as link (link.document_id + link.raw_target)}
                <li>
                  <button
                    onclick={() => openDoc(link.slug)}
                    title={t("comments.openDoc", { slug: link.slug })}
                  >
                    <span class="truncate font-mono text-xs">{link.slug}.md</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</div>
