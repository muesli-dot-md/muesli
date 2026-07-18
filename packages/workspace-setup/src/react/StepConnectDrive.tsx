// Google Drive connect: opens the OAuth dance, then either polls the storage
// status until the callback binds the workspace (host.driveFlow === "poll",
// desktop) or full-page-navigates away and resumes via the wizard's `resume`
// payload (host.driveFlow === "redirect", web). React sibling of
// StepConnectDrive.svelte, promoted from apps/desktop.

import { useEffect, useRef, useState } from "react";

import { Button, Spinner } from "./ui";
import { StepHeader } from "./StepHeader";
import type { ConnectStepProps } from "./wizard-common";

export function StepConnectDrive({
  host,
  t,
  ensureWorkspace,
  onConnected,
  onBack,
  resumeError = false,
  stepIndex,
  totalSteps,
}: ConnectStepProps & { resumeError?: boolean }) {
  const [waiting, setWaiting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  // Seeds the banner once from the OAuth-return flag (web resume path).
  const [error, setError] = useState<string | null>(() =>
    resumeError ? t("wizard.error", { detail: "Google" }) : null,
  );
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => () => clearInterval(timerRef.current), []);

  const hint =
    elapsed >= 90
      ? t("wizard.driveHint90")
      : elapsed >= 45
        ? t("wizard.driveHint45")
        : elapsed >= 15
          ? t("wizard.driveHint15")
          : "";

  async function go() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const ws = await ensureWorkspace();
      host.startDriveOAuth(ws);
      if (host.driveFlow === "redirect") return; // web: full-page nav; never returns
      // desktop: poll the storage status until the callback binds the workspace.
      setWaiting(true);
      setElapsed(0);
      timerRef.current = setInterval(() => {
        setElapsed((s) => s + 2);
        void (async () => {
          try {
            const status = await host.getStorageStatus(ws);
            if (status.bound) {
              clearInterval(timerRef.current);
              setWaiting(false);
              onConnected(ws);
            }
          } catch {
            // transient poll errors are expected mid-dance; keep waiting
          }
        })();
      }, 2000);
    } catch (e2) {
      setError(t("wizard.error", { detail: e2 instanceof Error ? e2.message : String(e2) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <StepHeader
        stepIndex={stepIndex}
        totalSteps={totalSteps}
        title={t("wizard.driveConnectTitle")}
        body={t("wizard.driveLead")}
        t={t}
      />
      {waiting ? (
        <>
          <p className="flex items-center gap-2 text-sm">
            <span className="inline-block size-2 animate-pulse rounded-full bg-brand" />
            {t("wizard.driveWaiting")}{" "}
            <span className="font-mono text-xs opacity-60">{elapsed}s</span>
          </p>
          {hint ? (
            <p className="mt-2 text-xs text-muted-foreground" style={{ textWrap: "pretty" }}>
              {hint}
            </p>
          ) : null}
        </>
      ) : (
        <>
          {error ? <p className="mb-2 text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-between">
            <Button variant="ghost" type="button" onClick={onBack}>
              {t("wizard.back")}
            </Button>
            <Button variant="brand" type="button" onClick={() => void go()} disabled={busy}>
              {busy ? <Spinner className="size-3.5" /> : null}
              {t("wizard.driveGo")}
            </Button>
          </div>
        </>
      )}
    </>
  );
}
