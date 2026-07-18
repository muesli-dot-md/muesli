// One setting inside a SettingsCard: a title (+ optional description) on the
// left, the control right-aligned (Multica settings-row density: min-h-16
// px-4 py-3.5). Rows stack with hairline dividers drawn by the parent card's
// divide-y. When `stacked` is set the control drops to its own full-width
// line below the label — used by wide forms (e.g. the server URL input).
// Rows auto-save through their own controls; there are no submit buttons.
// Presentational only.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Props {
  title?: string;
  description?: string;
  /** Put the control on its own line under the label (wide forms). */
  stacked?: boolean;
  /** Optional leading icon/avatar node, vertically centered. */
  leading?: ReactNode;
  /** The right-aligned (or, when stacked, below-the-label) control. */
  control?: ReactNode;
  /** Free-form body when a row is more than a label+control. */
  children?: ReactNode;
  className?: string;
}

export function SettingsRow({
  title,
  description,
  stacked = false,
  leading,
  control,
  children,
  className,
}: Props) {
  return (
    <div
      className={cn(
        "min-h-16 px-4 py-3.5",
        !stacked && "flex flex-wrap items-center gap-x-4 gap-y-3",
        className,
      )}
    >
      {leading ? <div className="shrink-0">{leading}</div> : null}

      {title || description ? (
        <div className="min-w-0 flex-1">
          {title ? <p className="text-sm font-medium">{title}</p> : null}
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground [text-wrap:pretty]">
              {description}
            </p>
          ) : null}
        </div>
      ) : null}

      {control ? (
        <div
          className={cn(
            stacked ? "mt-3" : "shrink-0",
            "flex items-center gap-2",
          )}
        >
          {control}
        </div>
      ) : null}

      {children}
    </div>
  );
}
