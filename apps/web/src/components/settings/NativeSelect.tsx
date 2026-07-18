// Thin styled wrapper over a native <select> for the settings pages (workspace
// selector, language, member roles, token expiry). The native element keeps
// OS-level affordances (type-ahead, mobile pickers) that the option lists here
// benefit from; styling matches the Multica h-8 control density.
import type { SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function NativeSelect({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-8 rounded-lg border border-surface-border bg-transparent px-2 text-sm text-foreground outline-none transition-colors",
        "hover:bg-surface-hover focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export default NativeSelect;
