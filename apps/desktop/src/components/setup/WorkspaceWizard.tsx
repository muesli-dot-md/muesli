// The create-workspace wizard: name → storage → connect → done. Pure
// orchestration: all IO goes through the injected WizardHost. React port of
// packages/workspace-setup/src/WorkspaceWizard.svelte driven by the package's
// rune-free machine.

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createWizardMachine, type BackendKind } from "@muesli/workspace-setup/machine";
import {
  ALL_STORAGE_AVAILABLE,
  type StorageCapabilities,
} from "@muesli/workspace-setup/capabilities";
import { makeT } from "@muesli/workspace-setup/copy";
import type { WizardHost } from "@muesli/workspace-setup/host";
import { ChoiceCard } from "./ChoiceCard";
import { StepHeader } from "./StepHeader";
import { StepConnectS3 } from "./StepConnectS3";
import { StepConnectGithub } from "./StepConnectGithub";
import { StepConnectDrive } from "./StepConnectDrive";
import { StepConnectSharePoint } from "./StepConnectSharePoint";
import { STEP_FADE_CLASS } from "./wizard-common";

export function WorkspaceWizard({
  host,
  resume,
}: {
  host: WizardHost;
  /** OAuth return (web flow): jump straight to done, or back to the Drive step
   *  with an error. One-shot payload consumed at mount. */
  resume?: { workspaceId: string; outcome: "connected" | "error" };
}) {
  // host is a stable adapter, wired once — matching the Svelte component.
  const t = useMemo(() => makeT(host.t), [host]);
  const [machine] = useState(() => {
    const m = createWizardMachine();
    if (resume) {
      m.resume({
        step: resume.outcome === "connected" ? "done" : "connect",
        name: "",
        backend: "gdrive",
        workspaceId: resume.workspaceId,
      });
    }
    return m;
  });
  // Mirror the machine into React state so we re-render on transitions.
  const [view, setView] = useState({ ...machine.state });
  const sync = () => setView({ ...machine.state });

  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<BackendKind | null>(null);
  // Optimistic until the host answers: a stale "everything available" only
  // means the pre-capabilities behavior (the connect step reports honest errors).
  const [caps, setCaps] = useState<StorageCapabilities>({ ...ALL_STORAGE_AVAILABLE });
  const [driveResumeError] = useState(() => resume?.outcome === "error");

  useEffect(() => {
    let cancelled = false;
    void host.storageCapabilities().then((c) => {
      if (!cancelled) setCaps(c);
    });
    return () => {
      cancelled = true;
    };
  }, [host]);

  /** The pending workspace is created lazily, at first connect attempt, so a
   *  user backing out of the name/storage steps creates nothing server-side. */
  const createdWorkspaceIdRef = useRef<string | null>(resume?.workspaceId ?? null);
  async function ensureWorkspace(): Promise<string> {
    if (createdWorkspaceIdRef.current) return createdWorkspaceIdRef.current;
    const ws = await host.createWorkspace(machine.state.name);
    createdWorkspaceIdRef.current = ws.id;
    return ws.id;
  }

  function submitName(e: FormEvent) {
    e.preventDefault();
    if (machine.next({ name })) sync();
  }
  function pickBackend(kind: BackendKind) {
    if (!caps[kind]) return; // disabled cards don't fire, but belt-and-braces
    setChosen(kind);
    if (machine.next({ backend: kind })) sync();
  }
  function connected(workspaceId: string) {
    if (machine.next({ workspaceId })) sync();
  }
  function back() {
    machine.back();
    sync();
  }

  const stepProps = {
    t,
    workspaceId: createdWorkspaceIdRef.current,
    ensureWorkspace,
    onConnected: connected,
    onBack: back,
    stepIndex: view.stepIndex,
    totalSteps: view.totalSteps,
  };

  return (
    <div className="flex flex-col text-foreground">
      <div key={view.step} className={`flex flex-col ${STEP_FADE_CLASS}`}>
        {view.step === "name" ? (
          <>
            <StepHeader
              stepIndex={view.stepIndex}
              totalSteps={view.totalSteps}
              title={t("wizard.nameTitle")}
              body={t("wizard.nameBody")}
              t={t}
            />
            <form className="flex flex-col gap-3" onSubmit={submitName}>
              <Input
                placeholder={t("wizard.namePlaceholder")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
              <div className="mt-2 flex justify-end gap-2">
                <Button variant="ghost" type="button" onClick={() => host.onCancel()}>
                  {t("wizard.cancel")}
                </Button>
                <Button variant="brand" type="submit" disabled={!name.trim()}>
                  {t("wizard.next")}
                </Button>
              </div>
            </form>
          </>
        ) : view.step === "storage" ? (
          <>
            <StepHeader
              stepIndex={view.stepIndex}
              totalSteps={view.totalSteps}
              title={t("wizard.storageTitle")}
              body={t("wizard.storageBody")}
              t={t}
            />
            {/* Backends the server can't serve (GET /api/me `storage`) render
                disabled with an honest note, instead of letting the connect
                step fail on a config error. */}
            <div className="flex flex-col gap-2">
              <ChoiceCard
                title={t("wizard.s3Card")}
                body={caps.s3 ? t("wizard.s3CardBody") : t("wizard.backendUnavailable")}
                selected={chosen === "s3"}
                disabled={!caps.s3}
                badge={caps.s3 ? undefined : t("wizard.notEnabled")}
                onClick={() => pickBackend("s3")}
              />
              <ChoiceCard
                title={t("wizard.gdriveCard")}
                body={caps.gdrive ? t("wizard.gdriveCardBody") : t("wizard.gdriveUnavailable")}
                selected={chosen === "gdrive"}
                disabled={!caps.gdrive}
                badge={caps.gdrive ? undefined : t("wizard.notEnabled")}
                onClick={() => pickBackend("gdrive")}
              />
              <ChoiceCard
                title={t("wizard.githubCard")}
                body={caps.github ? t("wizard.githubCardBody") : t("wizard.backendUnavailable")}
                selected={chosen === "github"}
                disabled={!caps.github}
                badge={caps.github ? undefined : t("wizard.notEnabled")}
                onClick={() => pickBackend("github")}
              />
              <ChoiceCard
                title={t("wizard.sharepointCard")}
                body={
                  caps.sharepoint ? t("wizard.sharepointCardBody") : t("wizard.backendUnavailable")
                }
                selected={chosen === "sharepoint"}
                disabled={!caps.sharepoint}
                badge={caps.sharepoint ? undefined : t("wizard.notEnabled")}
                onClick={() => pickBackend("sharepoint")}
              />
            </div>
            <div className="mt-4 flex justify-between">
              <Button variant="ghost" type="button" onClick={back}>
                {t("wizard.back")}
              </Button>
            </div>
          </>
        ) : view.step === "connect" ? (
          view.backend === "s3" ? (
            <StepConnectS3 host={host} {...stepProps} />
          ) : view.backend === "github" ? (
            <StepConnectGithub host={host} {...stepProps} />
          ) : view.backend === "sharepoint" ? (
            <StepConnectSharePoint host={host} {...stepProps} />
          ) : (
            <StepConnectDrive host={host} {...stepProps} resumeError={driveResumeError} />
          )
        ) : (
          <>
            <StepHeader
              stepIndex={view.stepIndex}
              totalSteps={view.totalSteps}
              title={t("wizard.doneTitle")}
              body={t("wizard.doneBody")}
              t={t}
            />
            <div className="flex justify-end">
              <Button
                variant="brand"
                type="button"
                onClick={() => view.workspaceId && host.onDone(view.workspaceId)}
              >
                {t("wizard.open")}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
