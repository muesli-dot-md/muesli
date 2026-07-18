// A Multica option card: quiet ring-1 hairline at rest, background tint on
// hover, brand ring when selected; the disabled variant is dashed, dimmed and
// non-interactive with a static uppercase badge ("NOT ENABLED").
// React port of packages/workspace-setup/src/ChoiceCard.svelte.

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function ChoiceCard({
  title,
  body,
  selected = false,
  disabled = false,
  badge,
  icon,
  onClick,
}: {
  title: string;
  body: string;
  selected?: boolean;
  disabled?: boolean;
  badge?: string;
  icon?: ReactNode;
  onClick?: () => void;
}) {
  const text = (
    <div className="min-w-0 flex-1">
      <p className="text-sm font-medium">
        {title}
        {disabled && badge ? (
          <span className="ml-2 align-middle text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            {badge}
          </span>
        ) : null}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{body}</p>
    </div>
  );

  if (disabled) {
    return (
      <div
        aria-disabled="true"
        className="flex w-full items-start gap-3 rounded-lg border border-dashed border-foreground/25 p-3 text-left opacity-70"
      >
        {icon}
        {text}
      </div>
    );
  }

  return (
    <button
      type="button"
      data-selected={selected}
      onClick={onClick}
      className={cn(
        "flex w-full cursor-pointer items-start gap-3 rounded-lg p-3 text-left outline-none transition-[background-color,box-shadow] duration-100 hover:bg-surface-hover focus-visible:ring-3 focus-visible:ring-ring/50",
        selected ? "bg-brand/5 ring-2 ring-brand" : "ring-1 ring-surface-border",
      )}
    >
      {icon}
      {text}
    </button>
  );
}
