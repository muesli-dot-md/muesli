<script lang="ts">
  // First-login onboarding (BYO storage phase 3, spec 2026-07-02): three static
  // Multica screens + a context fork. Skip is visible on EVERY screen (plain
  // link, never guilt-tripped) and Escape = skip; completing or skipping stamps
  // the flag via host.finish — skip is a decision, not a snooze. Screen 3's
  // primary actions stamp FIRST (finish(false)) and then hand over to the host:
  // an abandoned creation wizard must not re-trigger onboarding.
  import {
    createOnboardingFlow,
    splitAtParam,
    type OnboardingAction,
    type OnboardingHost,
  } from "./onboarding";
  import { makeT, type WizardKey } from "./copy";
  import StepHeader from "./StepHeader.svelte";
  import ChoiceCard from "./ChoiceCard.svelte";
  import "./wizard.css";

  let { host }: { host: OnboardingHost } = $props();

  // svelte-ignore state_referenced_locally -- host is a stable adapter, wired once
  const t = makeT(host.t);
  const flow = createOnboardingFlow();
  // Mirror the rune-free flow into a rune so Svelte re-renders on transitions.
  let view = $state({ ...flow.state });
  function sync() {
    view = { ...flow.state };
  }

  // finish/primaryAction fire at most once per mount (Escape + click races).
  let finishing = $state(false);

  /** Skip from any screen (button or Escape): stamp + close, fail-quiet. */
  function skip() {
    if (finishing) return;
    finishing = true;
    void host.finish(true);
  }

  /** Screen-3 primary action: stamp FIRST (spec §3, stamp-at-wizard-open), then
   *  hand over. finish() closes the flow synchronously before its first await,
   *  so primaryAction may immediately open the follow-up surface. */
  function act(action: OnboardingAction) {
    if (finishing) return;
    finishing = true;
    void host.finish(false);
    host.primaryAction(action);
  }

  function next() {
    if (flow.next()) sync();
  }
  function back() {
    if (flow.back()) sync();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      skip();
    }
  }

  // Icon discriminant for the concept cards' tile — kept as a plain string key
  // (not a component import) so this shared package gains no icon dependency;
  // see the conceptIcon snippet below for the actual inline glyphs.
  type ConceptIcon = "workspace" | "document" | "storage" | "sharing";
  const concepts: { title: WizardKey; body: WizardKey; icon: ConceptIcon }[] = [
    {
      title: "onboarding.conceptWorkspace",
      body: "onboarding.conceptWorkspaceBody",
      icon: "workspace",
    },
    {
      title: "onboarding.conceptDocument",
      body: "onboarding.conceptDocumentBody",
      icon: "document",
    },
    { title: "onboarding.conceptStorage", body: "onboarding.conceptStorageBody", icon: "storage" },
    { title: "onboarding.conceptSharing", body: "onboarding.conceptSharingBody", icon: "sharing" },
  ];

  // Invited headline: split the RAW template (t without params leaves
  // {workspace} intact) so the name lands inside <em> — Multica's italic serif —
  // in any word order a translation chooses.
  const invitedParts = $derived(
    host.context.kind === "invited"
      ? splitAtParam(t("onboarding.invitedTitle"), "workspace")
      : null,
  );
</script>

<svelte:window onkeydown={onKeydown} />

{#snippet skipLink()}
  <button class="mws-skip" type="button" onclick={skip}>
    {t("onboarding.skip")}
  </button>
{/snippet}

{#snippet conceptIcon(icon: ConceptIcon)}
  <!-- Inline lucide-style glyphs (copied path data, not the lucide-svelte package —
       the shared wizard package stays dependency-free). 16px, matching lucide's
       stroke conventions: viewBox 0 0 24 24, currentColor stroke, round caps/joins. -->
  {#if icon === "workspace"}
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect width="7" height="7" x="3" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="14" rx="1" />
      <rect width="7" height="7" x="3" y="14" rx="1" />
    </svg>
  {:else if icon === "document"}
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path
        d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"
      />
    </svg>
  {:else if icon === "storage"}
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5V19A9 3 0 0 0 21 19V5" />
      <path d="M3 12A9 3 0 0 0 21 12" />
    </svg>
  {:else}
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <path d="M16 3.128a4 4 0 0 1 0 7.744" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <circle cx="9" cy="7" r="4" />
    </svg>
  {/if}
{/snippet}

<div class="mws-root flex flex-col">
  {#if view.screen === "welcome"}
    <StepHeader
      stepIndex={view.screenIndex}
      totalSteps={view.totalScreens}
      title={t("onboarding.welcomeTitle")}
      body={t("onboarding.welcomeBody")}
      {t}
    />
    <div class="mt-2 flex items-center justify-between">
      {@render skipLink()}
      <button class="btn btn-primary" type="button" onclick={next}>
        {t("wizard.next")}
      </button>
    </div>
  {:else if view.screen === "concepts"}
    <StepHeader
      stepIndex={view.screenIndex}
      totalSteps={view.totalScreens}
      title={t("onboarding.conceptsTitle")}
      {t}
    />
    <div class="flex flex-col gap-2">
      {#each concepts as c (c.title)}
        <div class="mws-card mws-concept flex items-start gap-3 border border-base-300 p-3">
          <div class="mws-concept-icon">
            {@render conceptIcon(c.icon)}
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium">{t(c.title)}</p>
            <p class="mt-0.5 text-xs text-base-content/60">{t(c.body)}</p>
          </div>
        </div>
      {/each}
    </div>
    <div class="mt-4 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <button class="btn btn-ghost" type="button" onclick={back}>{t("wizard.back")}</button>
        {@render skipLink()}
      </div>
      <button class="btn btn-primary" type="button" onclick={next}>
        {t("wizard.next")}
      </button>
    </div>
  {:else if host.context.kind === "create"}
    <StepHeader
      stepIndex={view.screenIndex}
      totalSteps={view.totalScreens}
      title={t("onboarding.createTitle")}
      body={t("onboarding.createBody")}
      {t}
    />
    <div class="mt-2 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <button class="btn btn-ghost" type="button" onclick={back}>{t("wizard.back")}</button>
        {@render skipLink()}
      </div>
      <button class="btn btn-primary" type="button" onclick={() => act("create")}>
        {t("onboarding.createButton")}
      </button>
    </div>
  {:else if host.context.kind === "invited"}
    <!-- StepHeader's header, inlined: this headline wraps the workspace name in
         <em> (Multica italic serif), which a plain title string cannot carry. -->
    <div class="mb-5 flex flex-col gap-3">
      <div
        class="flex items-center gap-2"
        role="progressbar"
        aria-valuemin="1"
        aria-valuemax={view.totalScreens}
        aria-valuenow={view.screenIndex + 1}
        aria-label={t("wizard.stepOf", { n: view.screenIndex + 1, total: view.totalScreens })}
      >
        {#each Array(view.totalScreens) as _, i (i)}
          <span
            class="mws-dot {i < view.screenIndex
              ? 'bg-base-content'
              : i === view.screenIndex
                ? 'bg-base-content ring-2 ring-base-content/25 ring-offset-1'
                : 'border border-base-content/30'}"
          ></span>
        {/each}
        <span class="ml-1 text-xs text-base-content/60">
          {t("wizard.stepOf", { n: view.screenIndex + 1, total: view.totalScreens })}
        </span>
      </div>
      <h3 class="mws-headline">
        {invitedParts?.[0]}<em>{host.context.workspaceName}</em>{invitedParts?.[1]}
      </h3>
      <p class="text-sm text-base-content/70" style="text-wrap: pretty;">
        {t("onboarding.invitedBody")}
      </p>
    </div>
    <div class="mt-2 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <button class="btn btn-ghost" type="button" onclick={back}>{t("wizard.back")}</button>
        {@render skipLink()}
      </div>
      <button class="btn btn-primary" type="button" onclick={() => act("open-invited")}>
        {t("onboarding.invitedButton")}
      </button>
    </div>
  {:else}
    <StepHeader
      stepIndex={view.screenIndex}
      totalSteps={view.totalScreens}
      title={t("onboarding.desktopTitle")}
      body={t("onboarding.desktopBody")}
      {t}
    />
    <div class="flex flex-col gap-2">
      <ChoiceCard
        title={t("onboarding.localCard")}
        body={t("onboarding.localCardBody")}
        onclick={() => act("local")}
      />
      <ChoiceCard
        title={t("onboarding.serverCard")}
        body={t("onboarding.serverCardBody")}
        onclick={() => act("server")}
      />
    </div>
    <div class="mt-4 flex items-center justify-between">
      <button class="btn btn-ghost" type="button" onclick={back}>{t("wizard.back")}</button>
      {@render skipLink()}
    </div>
  {/if}
</div>
