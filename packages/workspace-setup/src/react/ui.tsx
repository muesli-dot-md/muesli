// Minimal, app-agnostic primitives for the package's React wizard components.
//
// The package ships raw .tsx source that BOTH apps compile with their own
// Tailwind (each app's globals.css carries an @source scan over
// packages/workspace-setup/src/**), and both apps share the same token system
// (desktop tokens.css copied verbatim to web). So the way to keep the wizard
// pixel-identical in both apps with the least surface is to inline the exact
// class strings of the apps' shadcn button/input/textarea/spinner primitives
// here, on plain elements — no shadcn import, no injected context, no cva/clsx
// dependency. The only runtime dependency of the react layer is `react` itself
// (peer), matching the Svelte components' dependency-free philosophy.
//
// If an app ever restyles its shadcn primitives, mirror the class strings here
// (single source: apps/desktop/src/components/ui/{button,input,textarea,spinner}.tsx).

import type { ComponentProps } from "react";

/** Tiny truthy class join — enough for these components (no conflicting
 *  utilities are ever merged, so tailwind-merge would be dead weight). */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

type ButtonVariant = "brand" | "ghost" | "outline";
type ButtonSize = "default" | "xs";

const BUTTON_BASE =
  "group/button inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  /* Filled brand blue — the primary CTA color regardless of accent overrides. */
  brand: "bg-brand text-brand-foreground hover:bg-brand/85 aria-expanded:bg-brand/85",
  ghost:
    "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
  outline:
    "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  default: "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
  xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
};

export function Button({
  variant = "brand",
  size = "default",
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      data-slot="button"
      type={type}
      className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)}
      {...props}
    />
  );
}

const INPUT_CLASS =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input data-slot="input" className={cx(INPUT_CLASS, className)} {...props} />;
}

const TEXTAREA_CLASS =
  "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cx(TEXTAREA_CLASS, className)} {...props} />;
}

/** Inline lucide loader-circle (copied path data, not the lucide package — the
 *  shared wizard package stays dependency-free, like the Svelte components'
 *  inline glyphs before it). */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="status"
      aria-label="Loading"
      data-slot="spinner"
      className={cx("size-4 animate-spin", className)}
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
