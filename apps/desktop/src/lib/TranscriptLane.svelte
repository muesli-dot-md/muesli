<script lang="ts">
  import type { TranscriptLine } from './types';

  interface Props {
    title: string;
    lines: TranscriptLine[];
  }

  let { title, lines }: Props = $props();
</script>

<div class="lane">
  <h2 class="lane-title">{title}</h2>
  <div class="lane-body">
    {#if lines.length === 0}
      <p class="empty">No transcription yet…</p>
    {:else}
      {#each lines as line (line.utteranceId)}
        <p class="line" class:partial={!line.final} class:final={line.final}>
          {line.text}
        </p>
      {/each}
    {/if}
  </div>
</div>

<style>
  .lane {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--arc-border);
    border-radius: var(--radius-box);
    overflow: hidden;
  }

  .lane-title {
    margin: 0;
    padding: 0.5rem 1rem;
    background: var(--color-base-200);
    font-size: 1rem;
    font-weight: 600;
    border-bottom: 1px solid var(--arc-border);
    color: var(--color-base-content);
  }

  .lane-body {
    flex: 1;
    padding: 0.75rem 1rem;
    overflow-y: auto;
    max-height: 60vh;
    background: var(--color-base-100);
  }

  .empty {
    color: var(--text-muted);
    font-style: italic;
    margin: 0;
  }

  .line {
    margin: 0.25rem 0;
    line-height: 1.5;
    color: var(--color-base-content);
  }

  .partial {
    opacity: 0.6;
    color: var(--text-muted);
  }

  .final {
    opacity: 1;
    color: inherit;
  }
</style>
