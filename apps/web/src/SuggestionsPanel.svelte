<script lang="ts">
  import X from "@lucide/svelte/icons/x";
  import { authorName, relativeTime, type SuggestionGroup } from "./collabStore.svelte";
  import { t } from "./i18n/index.svelte";
  import { useDocSession } from "./session.svelte";

  const collab = useDocSession().store;

  let note = $state("");

  const draftLabel = (d: { from: number; to: number; insert: string; oldText: string }) =>
    d.oldText && d.insert ? t("suggest.replace") : d.insert ? t("suggest.insert") : t("suggest.delete");

  async function submit() {
    if (await collab.submitDrafts(note)) note = "";
  }

  function groupRange(group: SuggestionGroup) {
    return group.items.find((s) => s.range)?.range ?? null;
  }
</script>

<div class="flex flex-col gap-3 p-3">
  {#if collab.availability === "auth"}
    <p class="px-1 py-6 text-center text-sm opacity-60">{t("suggest.signInToSuggest")}</p>
  {:else}
    <label class="flex cursor-pointer items-center gap-2 px-1">
      <input type="checkbox" class="toggle toggle-sm" bind:checked={collab.suggestMode} />
      <span class="text-sm font-medium">{t("suggest.mode")}</span>
    </label>
    <p class="-mt-1 px-1 text-xs opacity-60">
      {#if collab.suggestMode}
        {t("suggest.pausedPre")}
        <span class="font-medium">{t("editor.suggestAction")}</span>
        {t("suggest.pausedPost")}
      {:else}
        {t("suggest.offHint")}
      {/if}
    </p>

    {#if collab.suggestMode && collab.drafts.length > 0}
      <div class="card border border-warning/50 bg-base-100 shadow-sm">
        <div class="card-body gap-2 p-3">
          <span class="text-xs font-semibold uppercase tracking-wide opacity-60">
            {t("suggest.queued", { count: collab.drafts.length })}
          </span>
          {#each collab.drafts as draft, i}
            <div class="flex items-start justify-between gap-2 text-xs">
              <div class="min-w-0">
                <span class="badge badge-ghost badge-xs mr-1">{draftLabel(draft)}</span>
                {#if draft.oldText}
                  <span class="suggest-old">{draft.oldText.slice(0, 60)}</span>
                {/if}
                {#if draft.oldText && draft.insert}<span class="opacity-50"> → </span>{/if}
                {#if draft.insert}
                  <span class="suggest-new">{draft.insert.slice(0, 60)}</span>
                {/if}
              </div>
              <button
                class="btn btn-ghost btn-xs shrink-0"
                title={t("suggest.remove")}
                onclick={() => collab.removeDraft(i)}><X class="h-3 w-3" aria-hidden="true" /></button
              >
            </div>
          {/each}
          <input class="input input-xs w-full" placeholder={t("suggest.notePlaceholder")} bind:value={note} />
          <button class="btn btn-primary btn-xs" onclick={submit}>
            {t(collab.drafts.length > 1 ? "suggest.submit.other" : "suggest.submit.one")}
          </button>
        </div>
      </div>
    {/if}

    <div class="divider my-0 text-xs opacity-70">{t("suggest.pending")}</div>

    {#if collab.pendingGroups.length === 0}
      <p class="px-1 py-4 text-center text-sm opacity-50">{t("suggest.noPending")}</p>
    {/if}

    {#each collab.pendingGroups as group (group.changeSetId)}
      {@const first = group.items[0]}
      <div
        class="card border border-base-300 bg-base-100 shadow-sm"
        role="button"
        tabindex="0"
        onclick={() => collab.focusRange(groupRange(group))}
        onkeydown={(e) => e.key === "Enter" && collab.focusRange(groupRange(group))}
      >
        <div class="card-body gap-2 p-3">
          <div class="flex items-baseline justify-between gap-2">
            <span class="text-xs font-semibold">
              {first.author?.kind === "agent" ? "✦ " : ""}{authorName(first.author)}
            </span>
            <span class="text-xs opacity-50">{relativeTime(first.created_at)}</span>
          </div>
          {#if first.note}
            <p class="text-xs italic opacity-70">“{first.note}”</p>
          {/if}
          {#each group.items as s (s.id)}
            <div class="rounded bg-base-200/60 px-2 py-1 text-xs">
              {#if s.op.old_text}
                <span class="suggest-old">{s.op.old_text.slice(0, 120)}</span>
              {/if}
              {#if s.op.old_text && s.op.insert}<span class="opacity-50"> → </span>{/if}
              {#if s.op.insert}
                <span class="suggest-new">{s.op.insert.slice(0, 120)}</span>
              {:else if !s.op.old_text}
                <span class="opacity-50">{t("suggest.emptyEdit")}</span>
              {/if}
              {#if !s.range}
                <span class="ml-1 badge badge-ghost badge-xs" title={t("suggest.detachedTitle")}>
                  {t("suggest.detached")}
                </span>
              {/if}
            </div>
          {/each}
          {#if collab.conflicts[group.changeSetId]}
            <div class="alert alert-warning px-2 py-1 text-xs">
              {t("suggest.conflict", { detail: collab.conflicts[group.changeSetId] })}
            </div>
          {/if}
          <div class="card-actions justify-end">
            <button
              class="btn btn-ghost btn-xs"
              onclick={(e) => {
                e.stopPropagation();
                collab.rejectGroup(group);
              }}>{t("suggest.reject")}</button
            >
            <button
              class="btn btn-success btn-xs"
              onclick={(e) => {
                e.stopPropagation();
                collab.acceptGroup(group);
              }}>{t("suggest.accept")}</button
            >
          </div>
        </div>
      </div>
    {/each}
  {/if}
</div>
