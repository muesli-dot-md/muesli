// First-launch onboarding (BYO storage phase 3): three Multica screens + a
// context fork, rendered as a FULL-WINDOW overlay (Multica's WindowOverlay
// pattern) with a 48px top drag strip. Driven by the package's rune-free flow
// (@muesli/workspace-setup/onboarding). React port of
// packages/workspace-setup/src/OnboardingFlow.svelte.
//
// Skip is visible on EVERY screen (plain link, never guilt-tripped) and
// Escape = skip; completing or skipping stamps the flag via host.finish —
// skip is a decision, not a snooze. Screen 3's primary actions stamp FIRST
// (finish(false)) and then hand over to the host: an abandoned creation
// wizard must not re-trigger onboarding.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Database, LayoutGrid, SquarePen, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  createOnboardingFlow,
  splitAtParam,
  type OnboardingAction,
  type OnboardingContext,
} from "@muesli/workspace-setup/onboarding";
import { makeT, type WizardKey } from "@muesli/workspace-setup/copy";
import { ChoiceCard } from "./ChoiceCard";
import { StepDots, StepHeader } from "./StepHeader";
import { STEP_FADE_CLASS, WIZARD_SERIF } from "./wizard-common";

/** The host adapter the shell injects — an exact mirror of the workspace-setup
 *  OnboardingHost contract (@muesli/workspace-setup/onboarding), except that
 *  CLOSING the overlay is the overlay's own job via the separate onFinish
 *  callback: finish() only stamps the onboarded flag(s), fail-quiet. */
export type OnboardingOverlayHost = {
  /** Which Screen 3 fork to show; the desktop shell passes { kind: "desktop" }. */
  context: OnboardingContext;
  /** Stamp the onboarded flag(s). skipped=true when the user bailed early
   *  (skip is a decision, not a snooze — it stamps too). Errors must stay
   *  console.warn-level; the overlay has already closed via onFinish. */
  finish(skipped: boolean): Promise<void>;
  /** Screen-3 fork handover: open the wizard / picker / login. Called AFTER
   *  finish(false) (stamp-at-wizard-open) and after onFinish closed the overlay,
   *  so it may immediately open the follow-up surface. */
  primaryAction(action: OnboardingAction): void;
  /** Optional i18n override; defaults to built-in English (copy.ts). */
  t?: (key: string, params?: Record<string, string | number>) => string;
};

type ConceptIcon = "workspace" | "document" | "storage" | "sharing";

const CONCEPTS: { title: WizardKey; body: WizardKey; icon: ConceptIcon }[] = [
  { title: "onboarding.conceptWorkspace", body: "onboarding.conceptWorkspaceBody", icon: "workspace" },
  { title: "onboarding.conceptDocument", body: "onboarding.conceptDocumentBody", icon: "document" },
  { title: "onboarding.conceptStorage", body: "onboarding.conceptStorageBody", icon: "storage" },
  { title: "onboarding.conceptSharing", body: "onboarding.conceptSharingBody", icon: "sharing" },
];

const CONCEPT_GLYPHS: Record<ConceptIcon, ReactNode> = {
  workspace: <LayoutGrid className="size-4" aria-hidden="true" />,
  document: <SquarePen className="size-4" aria-hidden="true" />,
  storage: <Database className="size-4" aria-hidden="true" />,
  sharing: <Users className="size-4" aria-hidden="true" />,
};

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
  // host is a stable adapter, wired once — matching the Svelte component.
  const t = useMemo(() => makeT(host.t), [host]);
  const [flow] = useState(() => createOnboardingFlow());
  // Mirror the rune-free flow into React state so we re-render on transitions.
  const [view, setView] = useState({ ...flow.state });
  const sync = () => setView({ ...flow.state });

  // finish/primaryAction fire at most once per mount (Escape + click races).
  const finishingRef = useRef(false);

  /** Skip from any screen (button or Escape): close + stamp, fail-quiet. */
  function skip() {
    if (finishingRef.current) return;
    finishingRef.current = true;
    onFinish();
    void host.finish(true);
  }

  /** Screen-3 primary action: close + stamp FIRST (stamp-at-wizard-open), then
   *  hand over so the host may immediately open the follow-up surface. */
  function act(action: OnboardingAction) {
    if (finishingRef.current) return;
    finishingRef.current = true;
    onFinish();
    void host.finish(false);
    host.primaryAction(action);
  }

  const next = () => {
    if (flow.next()) sync();
  };
  const back = () => {
    if (flow.back()) sync();
  };

  useEffect(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        skip();
      }
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- skip only reads stable refs
  }, []);

  const skipLink = (
    <button
      type="button"
      className="cursor-pointer py-1 text-sm text-muted-foreground transition-colors hover:text-foreground hover:underline hover:underline-offset-3 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-brand"
      onClick={skip}
    >
      {t("onboarding.skip")}
    </button>
  );

  // Invited headline: split the RAW template (t without params leaves
  // {workspace} intact) so the name lands inside <em> — italic serif — in any
  // word order a translation chooses.
  const invitedParts =
    host.context.kind === "invited" ? splitAtParam(t("onboarding.invitedTitle"), "workspace") : null;

  let screen: ReactNode;
  if (view.screen === "welcome") {
    screen = (
      <>
        <StepHeader
          stepIndex={view.screenIndex}
          totalSteps={view.totalScreens}
          title={t("onboarding.welcomeTitle")}
          body={t("onboarding.welcomeBody")}
          t={t}
        />
        <div className="mt-2 flex items-center justify-between">
          {skipLink}
          <Button variant="brand" type="button" onClick={next}>
            {t("wizard.next")}
          </Button>
        </div>
      </>
    );
  } else if (view.screen === "concepts") {
    screen = (
      <>
        <StepHeader
          stepIndex={view.screenIndex}
          totalSteps={view.totalScreens}
          title={t("onboarding.conceptsTitle")}
          t={t}
        />
        <div className="flex flex-col gap-2">
          {CONCEPTS.map((c) => (
            <div
              key={c.title}
              className="flex items-start gap-3 rounded-lg p-3 ring-1 ring-surface-border transition-shadow hover:ring-brand/40"
            >
              <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-brand/15 text-brand">
                {CONCEPT_GLYPHS[c.icon]}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{t(c.title)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{t(c.body)}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" type="button" onClick={back}>
              {t("wizard.back")}
            </Button>
            {skipLink}
          </div>
          <Button variant="brand" type="button" onClick={next}>
            {t("wizard.next")}
          </Button>
        </div>
      </>
    );
  } else if (host.context.kind === "create") {
    screen = (
      <>
        <StepHeader
          stepIndex={view.screenIndex}
          totalSteps={view.totalScreens}
          title={t("onboarding.createTitle")}
          body={t("onboarding.createBody")}
          t={t}
        />
        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" type="button" onClick={back}>
              {t("wizard.back")}
            </Button>
            {skipLink}
          </div>
          <Button variant="brand" type="button" onClick={() => act("create")}>
            {t("onboarding.createButton")}
          </Button>
        </div>
      </>
    );
  } else if (host.context.kind === "invited") {
    // StepHeader's header, inlined: this headline wraps the workspace name in
    // <em> (italic serif), which a plain title string cannot carry.
    screen = (
      <>
        <div className="mb-5 flex flex-col gap-3">
          <StepDots stepIndex={view.screenIndex} totalSteps={view.totalScreens} t={t} />
          <h3
            className="text-2xl leading-tight font-semibold text-balance"
            style={{ fontFamily: WIZARD_SERIF }}
          >
            {invitedParts?.[0]}
            <em className="italic">{host.context.workspaceName}</em>
            {invitedParts?.[1]}
          </h3>
          <p className="text-sm text-muted-foreground" style={{ textWrap: "pretty" }}>
            {t("onboarding.invitedBody")}
          </p>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" type="button" onClick={back}>
              {t("wizard.back")}
            </Button>
            {skipLink}
          </div>
          <Button variant="brand" type="button" onClick={() => act("open-invited")}>
            {t("onboarding.invitedButton")}
          </Button>
        </div>
      </>
    );
  } else {
    screen = (
      <>
        <StepHeader
          stepIndex={view.screenIndex}
          totalSteps={view.totalScreens}
          title={t("onboarding.desktopTitle")}
          body={t("onboarding.desktopBody")}
          t={t}
        />
        <div className="flex flex-col gap-2">
          <ChoiceCard
            title={t("onboarding.localCard")}
            body={t("onboarding.localCardBody")}
            onClick={() => act("local")}
          />
          <ChoiceCard
            title={t("onboarding.serverCard")}
            body={t("onboarding.serverCardBody")}
            onClick={() => act("server")}
          />
        </div>
        <div className="mt-4 flex items-center justify-between">
          <Button variant="ghost" type="button" onClick={back}>
            {t("wizard.back")}
          </Button>
          {skipLink}
        </div>
      </>
    );
  }

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
        {/* Per-screen remount with a subtle fade (reduced-motion aware). */}
        <div key={view.screen} className={`flex w-full max-w-xl flex-col ${STEP_FADE_CLASS}`}>
          {screen}
        </div>
      </div>
    </div>
  );
}

// AppShell (F1) imports this as a default export; keep both forms.
export default OnboardingOverlay;
