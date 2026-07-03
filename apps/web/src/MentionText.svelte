<script lang="ts">
  // Renders a comment/reply body with @mention chips (sub-project ④b). Plain runs keep
  // their whitespace; each `@[Name](muesli:user/<id>)` becomes a colored chip whose color
  // comes from colorFromId (sub-project ⑤) so it matches the person's presence color.
  // Unknown/removed users (id not in `knownIds`) render muted. Keep this component in sync
  // with apps/desktop/src/lib/collab/MentionText.svelte.
  import { renderMentions } from "./mentions";

  const { body, knownIds }: { body: string; knownIds?: Set<string> } = $props();

  const segments = $derived(renderMentions(body, knownIds));
</script>

<span class="whitespace-pre-wrap">{#each segments as seg, i (i)}{#if seg.kind === "text"}{seg.text}{:else if seg.known}<span
        class="tooltip mx-0.5 inline-flex items-center rounded px-1 align-baseline text-xs font-medium text-white"
        style:background-color={seg.color}
        data-tip={seg.name}>@{seg.name}</span
      >{:else}<span
        class="mx-0.5 inline-flex items-center rounded bg-base-300 px-1 align-baseline text-xs font-medium opacity-60"
        title={seg.name}>@{seg.name}</span
      >{/if}{/each}</span>
