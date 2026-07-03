<script lang="ts">
  // The create-workspace wizard: name → storage → connect → done (spec §6).
  // Pure orchestration: all IO goes through the injected WizardHost.
  import { createWizardMachine, type BackendKind } from "./machine";
  import { ALL_STORAGE_AVAILABLE, type StorageCapabilities } from "./capabilities";
  import { makeT } from "./copy";
  import type { WizardHost } from "./host";
  import StepHeader from "./StepHeader.svelte";
  import ChoiceCard from "./ChoiceCard.svelte";
  import StepConnectS3 from "./StepConnectS3.svelte";
  import StepConnectGithub from "./StepConnectGithub.svelte";
  import StepConnectDrive from "./StepConnectDrive.svelte";
  import StepConnectSharePoint from "./StepConnectSharePoint.svelte";
  import "./wizard.css";

  let {
    host,
    resume,
  }: {
    host: WizardHost;
    resume?: { workspaceId: string; outcome: "connected" | "error" };
  } = $props();

  // svelte-ignore state_referenced_locally -- host is a stable adapter, wired once
  const t = makeT(host.t);
  const machine = createWizardMachine();
  // Mirror the machine into a rune so Svelte re-renders on transitions.
  let view = $state({ ...machine.state });
  function sync() {
    view = { ...machine.state };
  }

  let name = $state("");
  let chosen: BackendKind | null = $state(null);
  // Optimistic until the host answers: a stale "everything available" only means
  // the pre-capabilities behavior (the connect step reports honest errors).
  let caps: StorageCapabilities = $state({ ...ALL_STORAGE_AVAILABLE });
  let driveResumeError = $state(false);

  $effect(() => {
    void host.storageCapabilities().then((c) => (caps = c));
  });

  // OAuth return (web): jump straight to done, or back to the Drive step with
  // an error. The pending workspace already exists server-side. `resume` is a
  // one-shot payload consumed at mount, so initial-value captures are the point.
  // svelte-ignore state_referenced_locally
  if (resume) {
    if (resume.outcome === "connected") {
      machine.resume({
        step: "done",
        name: "",
        backend: "gdrive",
        workspaceId: resume.workspaceId,
      });
    } else {
      machine.resume({
        step: "connect",
        name: "",
        backend: "gdrive",
        workspaceId: resume.workspaceId,
      });
      driveResumeError = true;
    }
    sync();
  }

  /** The pending workspace is created lazily, at first connect attempt, so a
   *  user backing out of the name/storage steps creates nothing server-side. */
  // svelte-ignore state_referenced_locally -- seeds once from the one-shot resume payload
  let createdWorkspaceId: string | null = $state(resume?.workspaceId ?? null);
  async function ensureWorkspace(): Promise<string> {
    if (createdWorkspaceId) return createdWorkspaceId;
    const ws = await host.createWorkspace(view.name);
    createdWorkspaceId = ws.id;
    return ws.id;
  }

  function submitName(e: SubmitEvent) {
    e.preventDefault();
    if (machine.next({ name })) sync();
  }
  function pickBackend(kind: BackendKind) {
    if (!caps[kind]) return; // disabled cards don't fire, but belt-and-braces
    chosen = kind;
    if (machine.next({ backend: kind })) sync();
  }
  function connected(workspaceId: string) {
    if (machine.next({ workspaceId })) sync();
  }
  function back() {
    machine.back();
    sync();
  }
</script>

<div class="mws-root flex flex-col">
  {#if view.step === "name"}
    <StepHeader
      stepIndex={view.stepIndex}
      totalSteps={view.totalSteps}
      title={t("wizard.nameTitle")}
      body={t("wizard.nameBody")}
      {t}
    />
    <form class="flex flex-col gap-3" onsubmit={submitName}>
      <input class="input w-full" placeholder={t("wizard.namePlaceholder")} bind:value={name} />
      <div class="mt-2 flex justify-end gap-2">
        <button class="btn btn-ghost" type="button" onclick={() => host.onCancel()}>
          {t("wizard.cancel")}
        </button>
        <button class="btn btn-primary" type="submit" disabled={!name.trim()}>
          {t("wizard.next")}
        </button>
      </div>
    </form>
  {:else if view.step === "storage"}
    <StepHeader
      stepIndex={view.stepIndex}
      totalSteps={view.totalSteps}
      title={t("wizard.storageTitle")}
      body={t("wizard.storageBody")}
      {t}
    />
    <!-- Backends the server can't serve (GET /api/me `storage`) render disabled with
         an honest note, instead of letting the connect step fail on a config error. -->
    <div class="flex flex-col gap-2">
      <ChoiceCard
        title={t("wizard.s3Card")}
        body={caps.s3 ? t("wizard.s3CardBody") : t("wizard.backendUnavailable")}
        selected={chosen === "s3"}
        disabled={!caps.s3}
        badge={caps.s3 ? undefined : t("wizard.notEnabled")}
        onclick={() => pickBackend("s3")}
      />
      <ChoiceCard
        title={t("wizard.gdriveCard")}
        body={caps.gdrive ? t("wizard.gdriveCardBody") : t("wizard.gdriveUnavailable")}
        selected={chosen === "gdrive"}
        disabled={!caps.gdrive}
        badge={caps.gdrive ? undefined : t("wizard.notEnabled")}
        onclick={() => pickBackend("gdrive")}
      />
      <ChoiceCard
        title={t("wizard.githubCard")}
        body={caps.github ? t("wizard.githubCardBody") : t("wizard.backendUnavailable")}
        selected={chosen === "github"}
        disabled={!caps.github}
        badge={caps.github ? undefined : t("wizard.notEnabled")}
        onclick={() => pickBackend("github")}
      />
      <ChoiceCard
        title={t("wizard.sharepointCard")}
        body={caps.sharepoint ? t("wizard.sharepointCardBody") : t("wizard.backendUnavailable")}
        selected={chosen === "sharepoint"}
        disabled={!caps.sharepoint}
        badge={caps.sharepoint ? undefined : t("wizard.notEnabled")}
        onclick={() => pickBackend("sharepoint")}
      />
    </div>
    <div class="mt-4 flex justify-between">
      <button class="btn btn-ghost" type="button" onclick={back}>{t("wizard.back")}</button>
    </div>
  {:else if view.step === "connect"}
    {#if view.backend === "s3"}
      <StepConnectS3
        {host}
        {t}
        workspaceId={createdWorkspaceId}
        {ensureWorkspace}
        onconnected={connected}
        onback={back}
        stepIndex={view.stepIndex}
        totalSteps={view.totalSteps}
      />
    {:else if view.backend === "github"}
      <StepConnectGithub
        {host}
        {t}
        workspaceId={createdWorkspaceId}
        {ensureWorkspace}
        onconnected={connected}
        onback={back}
        stepIndex={view.stepIndex}
        totalSteps={view.totalSteps}
      />
    {:else if view.backend === "sharepoint"}
      <StepConnectSharePoint
        {host}
        {t}
        workspaceId={createdWorkspaceId}
        {ensureWorkspace}
        onconnected={connected}
        onback={back}
        stepIndex={view.stepIndex}
        totalSteps={view.totalSteps}
      />
    {:else}
      <StepConnectDrive
        {host}
        {t}
        workspaceId={createdWorkspaceId}
        {ensureWorkspace}
        onconnected={connected}
        onback={back}
        resumeError={driveResumeError}
        stepIndex={view.stepIndex}
        totalSteps={view.totalSteps}
      />
    {/if}
  {:else}
    <StepHeader
      stepIndex={view.stepIndex}
      totalSteps={view.totalSteps}
      title={t("wizard.doneTitle")}
      body={t("wizard.doneBody")}
      {t}
    />
    <div class="flex justify-end">
      <button
        class="btn btn-primary"
        type="button"
        onclick={() => view.workspaceId && host.onDone(view.workspaceId)}
      >
        {t("wizard.open")}
      </button>
    </div>
  {/if}
</div>
