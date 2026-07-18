// Section header for a settings page (Multica pattern): the page-level title
// (h2, semibold, tight tracking) with an optional description, followed by the
// section's SettingsCards. Each settings tab renders one of these at the top.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Props {
  title: string;
  description?: string;
  children?: ReactNode;
  className?: string;
}

export function SettingsSection({ title, description, children, className }: Props) {
  return (
    <section className={cn("flex flex-col", className)}>
      <header className="mb-5">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground [text-wrap:pretty]">{description}</p>
        ) : null}
      </header>
      {children}
    </section>
  );
}
