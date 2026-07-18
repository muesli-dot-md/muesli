// Multica-style Theme picker: three preview cards (Light / Dark / System)
// that each paint a tiny mock window with a traffic-light dot row and skeleton
// lines, tinted with the theme they represent. The System card splits
// diagonally to hint "follows your OS". Bound to the theme store.
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { themeStore, useTheme } from "@/state/theme";

type ThemeMode = "light" | "dark" | "system";

const MODES: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

function Preview({ kind }: { kind: "light" | "dark" }) {
  const dark = kind === "dark";
  return (
    <div
      className="flex h-full w-full flex-col gap-1.5 p-2"
      style={{ background: dark ? "oklch(0.21 0.004 285)" : "oklch(0.985 0 0)" }}
    >
      <div className="flex gap-1">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: "oklch(0.7 0.16 25)" }}
        />
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: "oklch(0.82 0.15 85)" }}
        />
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: "oklch(0.78 0.16 145)" }}
        />
      </div>
      <div className="flex flex-1 gap-1.5">
        <div
          className="w-1/3 rounded-sm"
          style={{ background: dark ? "oklch(0.28 0.004 285)" : "oklch(0.93 0 0)" }}
        />
        <div className="flex flex-1 flex-col gap-1 pt-0.5">
          {[0.9, 0.7, 0.8].map((w, i) => (
            <div
              key={i}
              className="h-1 rounded-full"
              style={{
                width: `${w * 100}%`,
                background: dark ? "oklch(0.42 0.004 285)" : "oklch(0.85 0 0)",
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function ThemePreviewCards() {
  const mode = useTheme((s: { mode: ThemeMode }) => s.mode);

  return (
    <div className="grid grid-cols-3 gap-3">
      {MODES.map((m) => {
        const selected = mode === m.value;
        return (
          <button
            key={m.value}
            type="button"
            className={cn(
              "group flex flex-col gap-2 rounded-xl p-1.5 text-left transition-colors active:translate-y-px",
              selected ? "bg-surface-selected" : "hover:bg-surface-hover",
            )}
            aria-pressed={selected}
            onClick={() => themeStore.getState().setMode(m.value)}
          >
            <div
              className={cn(
                "relative aspect-[4/3] w-full overflow-hidden rounded-lg ring-1",
                selected ? "ring-primary" : "ring-surface-border",
              )}
            >
              {m.value === "system" ? (
                <>
                  {/* diagonal split: light top-left, dark bottom-right */}
                  <div
                    className="absolute inset-0"
                    style={{ clipPath: "polygon(0 0, 100% 0, 0 100%)" }}
                  >
                    <Preview kind="light" />
                  </div>
                  <div
                    className="absolute inset-0"
                    style={{ clipPath: "polygon(100% 0, 100% 100%, 0 100%)" }}
                  >
                    <Preview kind="dark" />
                  </div>
                </>
              ) : (
                <Preview kind={m.value} />
              )}
              {selected ? (
                <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground shadow">
                  <Check className="size-2.5" aria-hidden="true" />
                </span>
              ) : null}
            </div>
            <span
              className={cn(
                "px-1 text-center text-xs font-medium",
                selected ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {m.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
