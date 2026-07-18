import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface IconButtonProps {
  /** Accessible name; doubles as the tooltip text. */
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Pressed/toggled state — lifts the button like the Svelte graph toggle. */
  active?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * The shell's standard icon button: shadcn ghost button (icon-xs = 24px, the
 * old daisyUI `btn-xs btn-square` footprint) wrapped in a Tooltip — the Multica
 * idiom replacing bare `title` attributes.
 */
export function IconButton({ label, onClick, disabled, active, className, children }: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className={className}
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            aria-pressed={active || undefined}
            style={active ? { background: "var(--lift)", boxShadow: "var(--shadow-lift)" } : undefined}
          >
            {children}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
