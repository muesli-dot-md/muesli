<script lang="ts">
  // The create-workspace wizard: name → storage → connect → done (spec §6).
  // Pure orchestration: all IO goes through the injected WizardHost.
  import { createWizardMachine, type BackendKind } from "./machine";
  import { makeT, type WizardKey } from "./copy";
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

  const t = makeT(host.t);
  const machine = createWizardMachine();
  // Mirror the machine into a rune so Svelte re-renders on transitions.
  let view = $state({ ...machine.state });
  function sync() {
    view = { ...machine.state };
  }

  let name = $state("");
  let chosen: BackendKind | null = $state(null);
  let driveConfigured = $state(true);
  let driveResumeError = $state(false);

  $effect(() => {
    void host.driveConfigured().then((ok) => (driveConfigured = ok));
  });

  // OAuth return (web): jump straight to done, or back to the Drive step with
  // an error. The pending workspace already exists server-side.
  if (resume) {
    if (resume.outcome === "connected") {
      machine.resume({ step: "done", name: "", backend: "gdrive", workspaceId: resume.workspaceId });
    } else {
      machine.resume({ step: "connect", name: "", backend: "gdrive", workspaceId: resume.workspaceId });
      driveResumeError = true;
    }
    sync();
  }

  /** The pending workspace is created lazily, at first connect attempt, so a
   *  user backing out of the name/storage steps creates nothing server-side. */
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
    <StepHeader stepIndex={view.stepIndex} totalSteps={view.totalSteps}
      title={t("wizard.nameTitle")} body={t("wizard.nameBody")} {t} />
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
    <StepHeader stepIndex={view.stepIndex} totalSteps={view.totalSteps}
      title={t("wizard.storageTitle")} body={t("wizard.storageBody")} {t} />
    <div class="flex flex-col gap-2">
      <ChoiceCard title={t("wizard.s3Card")} body={t("wizard.s3CardBody")}
        selected={chosen === "s3"} onclick={() => pickBackend("s3")} />
      <ChoiceCard title={t("wizard.gdriveCard")}
        body={driveConfigured ? t("wizard.gdriveCardBody") : t("wizard.gdriveUnavailable")}
        selected={chosen === "gdrive"} disabled={!driveConfigured}
        badge={driveConfigured ? undefined : t("wizard.comingSoon")}
        onclick={() => pickBackend("gdrive")} />
      <ChoiceCard title={t("wizard.githubCard")} body={t("wizard.githubCardBody")}
        selected={chosen === "github"} onclick={() => pickBackend("github")} />
      <ChoiceCard title={t("wizard.sharepointCard")} body={t("wizard.sharepointCardBody")}
        selected={chosen === "sharepoint"} onclick={() => pickBackend("sharepoint")} />
    </div>
    <div class="mt-4 flex justify-between">
      <button class="btn btn-ghost" type="button" onclick={back}>{t("wizard.back")}</button>
    </div>
  {:else if view.step === "connect"}
    {#if view.backend === "s3"}
      <StepConnectS3 {host} {t} workspaceId={createdWorkspaceId} {ensureWorkspace}
        onconnected={connected} onback={back}
        stepIndex={view.stepIndex} totalSteps={view.totalSteps} />
    {:else if view.backend === "github"}
      <StepConnectGithub {host} {t} workspaceId={createdWorkspaceId} {ensureWorkspace}
        onconnected={connected} onback={back}
        stepIndex={view.stepIndex} totalSteps={view.totalSteps} />
    {:else if view.backend === "sharepoint"}
      <StepConnectSharePoint {host} {t} workspaceId={createdWorkspaceId} {ensureWorkspace}
        onconnected={connected} onback={back}
        stepIndex={view.stepIndex} totalSteps={view.totalSteps} />
    {:else}
      <StepConnectDrive {host} {t} workspaceId={createdWorkspaceId} {ensureWorkspace}
        onconnected={connected} onback={back} resumeError={driveResumeError}
        stepIndex={view.stepIndex} totalSteps={view.totalSteps} />
    {/if}
  {:else}
    <StepHeader stepIndex={view.stepIndex} totalSteps={view.totalSteps}
      title={t("wizard.doneTitle")} body={t("wizard.doneBody")} {t} />
    <div class="flex justify-end">
      <button class="btn btn-primary" type="button"
        onclick={() => view.workspaceId && host.onDone(view.workspaceId)}>
        {t("wizard.open")}
      </button>
    </div>
  {/if}
</div>
