// A card surface for the settings layout (Multica pattern): a shadowless Card
// with `gap-0 py-0` whose SettingsRow children are divided by hairlines
// (divide-y divide-surface-border). An optional small heading sits ABOVE the
// card as a section label, with an optional description under it.
// `tone="danger"` tints the ring for a danger zone. Purely presentational.
// Adapted from apps/desktop/src/components/settings/SettingsCard.tsx.
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Props {
  heading?: string;
  description?: string;
  tone?: "default" | "danger";
  children: ReactNode;
  className?: string;
}

export function SettingsCard({
  heading,
  description,
  tone = "default",
  children,
  className,
}: Props) {
  return (
    <section className="mt-6 first:mt-0">
      {heading ? (
        <h3
          className={cn(
            "mb-2 px-1 text-xs font-medium",
            tone === "danger" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {heading}
        </h3>
      ) : null}
      {description ? (
        <p className="mb-2 px-1 text-xs text-muted-foreground [text-wrap:pretty]">
          {description}
        </p>
      ) : null}
      <Card
        className={cn(
          "gap-0 divide-y divide-surface-border py-0 shadow-none ring-surface-border",
          tone === "danger" && "ring-destructive/25",
          className,
        )}
      >
        {children}
      </Card>
    </section>
  );
}

export default SettingsCard;
