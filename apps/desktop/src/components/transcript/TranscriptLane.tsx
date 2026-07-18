import { useEffect, useRef, type ReactNode, type UIEvent } from "react";
import type { TranscriptLine } from "@/services/types";

interface TranscriptLaneProps {
  title: string;
  lines: TranscriptLine[];
  /** Optional lane icon rendered before the title (e.g. Mic / MonitorSpeaker). */
  icon?: ReactNode;
}

/**
 * One transcript lane column ("Me" mic / "Them" system audio): title header +
 * scrolling line list. Auto-scrolls to the bottom as lines arrive unless the
 * user has scrolled up to read earlier lines; partial (non-final) lines render
 * muted/italic until the final commit replaces them.
 */
export default function TranscriptLane({ title, lines, icon }: TranscriptLaneProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // True while the view is pinned to the bottom (the default); a manual scroll
  // away from the bottom unpins until the user returns near the bottom.
  const pinnedRef = useRef(true);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  useEffect(() => {
    const el = bodyRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-surface shadow-(--surface-shadow) ring-1 ring-surface-border">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-surface-border px-3">
        {icon}
        <h2 className="text-sm font-semibold text-surface-foreground">{title}</h2>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {lines.length > 0 ? lines.length : null}
        </span>
      </header>
      <div
        ref={bodyRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 py-2.5"
      >
        {lines.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No transcription yet…</p>
        ) : (
          lines.map((line) => (
            <p
              key={line.utteranceId}
              className={
                line.final
                  ? "text-sm leading-relaxed text-surface-foreground"
                  : "text-sm leading-relaxed text-muted-foreground italic"
              }
            >
              {line.text}
            </p>
          ))
        )}
      </div>
    </section>
  );
}
