<script lang="ts">
  // Ported from apps/web/src/CommentsPanel.svelte. Deltas:
  //   - explicit props (store) instead of useDocSession() context
  //   - literal strings instead of t(...)
  //   - the webapp's "linked mentions"/backlinks section (graphApi + SPA route
  //     navigation) is webapp-only and omitted here (out of scope for ④a)
  import { RotateCcw } from "lucide-svelte";
  import { authorName, relativeTime, type CollabStore } from "./collabStore.svelte";
  import type { Thread } from "./collabApi";
  import MentionText from "./MentionText.svelte";
  import { mentionAutocomplete } from "./mentionAction.svelte";

  const { store: collab }: { store: CollabStore } = $props();

  let replyDrafts: Record<string, string> = $state({});

  async function sendReply(thread: Thread) {
    const body = (replyDrafts[thread.id] ?? "").trim();
    if (!body) return;
    if (await collab.reply(thread.id, body)) replyDrafts[thread.id] = "";
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
      {#each thread.comments as comment, i}
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
                    title="Reopen this thread"
                    aria-label="Reopen this thread"
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
                    title="Resolve this thread"
                    aria-label="Resolve this thread"
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
          placeholder="Reply… (@ to mention)"
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
    <p class="px-1 py-6 text-center text-sm opacity-60">Sign in to view comments.</p>
  {:else}
    <p class="px-1 text-xs opacity-60">
      Select text and use the <span class="font-medium">Comment</span> action to start a thread.
    </p>

    {#if collab.openThreads.length === 0 && collab.orphanedThreads.length === 0 && collab.resolvedThreads.length === 0}
      <p class="px-1 py-4 text-center text-sm opacity-50">No comments yet.</p>
    {/if}

    {#each collab.openThreads as thread (thread.id)}
      {@render threadCard(thread, false)}
    {/each}

    {#if collab.orphanedThreads.length > 0}
      <div class="divider my-1 text-xs opacity-70">On deleted text</div>
      <p class="-mt-2 px-1 text-xs opacity-50">
        These threads were anchored to text that has since been removed.
      </p>
      {#each collab.orphanedThreads as thread (thread.id)}
        {@render threadCard(thread, true)}
      {/each}
    {/if}

    {#if collab.resolvedThreads.length > 0}
      <div class="collapse-arrow collapse rounded-box border border-base-300 bg-base-100">
        <input type="checkbox" />
        <div class="collapse-title min-h-0 px-3 py-2 text-sm font-medium">
          Resolved ({collab.resolvedThreads.length})
        </div>
        <div class="collapse-content flex flex-col gap-2 px-2">
          {#each collab.resolvedThreads as thread (thread.id)}
            {@render threadCard(thread, false)}
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>
