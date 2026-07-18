// Desktop host for the shared first-launch onboarding: a FULL-WINDOW overlay
// (Multica's WindowOverlay pattern) with a 48px top drag strip, wrapping the
// package's OnboardingFlow (@muesli/workspace-setup/react). The flow content
// (three Multica screens + context fork, skip/Escape semantics, stamp-first
// primary actions) is the shared piece; only this Tauri shell is desktop's.

import { useMemo } from "react";

import { makeT } from "@muesli/workspace-setup/copy";
import { OnboardingFlow, type OnboardingFlowHost } from "@muesli/workspace-setup/react";

/** The host adapter the shell injects — desktop passes { kind: "desktop" }
 *  context and no translator (built-in English copy). Kept as a desktop-named
 *  alias so AppShell's existing prop type keeps compiling. */
export type OnboardingOverlayHost = OnboardingFlowHost;

export function OnboardingOverlay({
  host,
  onFinish,
}: {
  host: OnboardingOverlayHost;
  /** Close/unmount the overlay. Called synchronously BEFORE host.finish's
   *  stamping IO, so a Screen-3 primaryAction can open its follow-up surface
   *  without racing the overlay teardown. */
  onFinish: () => void;
}) {
  const t = useMemo(() => makeT(host.t), [host]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background text-foreground"
      role="dialog"
      aria-modal="true"
      aria-label={t("onboarding.welcomeTitle")}
    >
      {/* Window drag strip: the overlay covers the title bar, so the top 48px
          must stay draggable (Multica's DragStrip pattern). */}
      <div className="h-12 shrink-0" data-tauri-drag-region />
      <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-6 pt-[10vh] pb-12">
        <OnboardingFlow host={host} onFinish={onFinish} />
      </div>
    </div>
  );
}

// AppShell (F1) imports this as a default export; keep both forms.
export default OnboardingOverlay;
