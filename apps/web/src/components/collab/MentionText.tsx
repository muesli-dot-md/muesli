// Renders a comment/reply body with @mention chips (sub-project ④b). Plain runs
// keep their whitespace; each `@[Name](muesli:user/<id>)` becomes a colored chip
// whose color comes from colorFromId (sub-project ⑤) so it matches the person's
// presence color. Unknown/removed users (id not in `knownIds`) render muted.
// React port of MentionText.svelte.

import { renderMentions } from "@/services/mentions";

export function MentionText({ body, knownIds }: { body: string; knownIds?: Set<string> }) {
  const segments = renderMentions(body, knownIds);
  return (
    <span className="whitespace-pre-wrap">
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <span key={i}>{seg.text}</span>
        ) : seg.known ? (
          <span
            key={i}
            className="mx-0.5 inline-flex items-center rounded px-1 align-baseline text-xs font-medium text-white"
            style={{ backgroundColor: seg.color }}
            title={seg.name}
          >
            @{seg.name}
          </span>
        ) : (
          <span
            key={i}
            className="mx-0.5 inline-flex items-center rounded bg-muted px-1 align-baseline text-xs font-medium opacity-60"
            title={seg.name}
          >
            @{seg.name}
          </span>
        ),
      )}
    </span>
  );
}

export default MentionText;
