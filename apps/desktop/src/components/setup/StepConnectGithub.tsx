// GitHub/Gitea/Forgejo connect. React port of
// packages/workspace-setup/src/StepConnectGithub.svelte.

import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { StepHeader } from "./StepHeader";
import type { ConnectStepProps } from "./wizard-common";

export function StepConnectGithub({
  host,
  t,
  ensureWorkspace,
  onConnected,
  onBack,
  stepIndex,
  totalSteps,
}: ConnectStepProps) {
  const [apiBase, setApiBase] = useState("https://api.github.com");
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [prefix, setPrefix] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const ws = await ensureWorkspace();
      await host.createStorageConnection(ws, {
        kind: "github",
        api_base: apiBase.trim(),
        owner: owner.trim(),
        repo: repo.trim(),
        branch: branch.trim(),
        ...(prefix.trim() ? { prefix: prefix.trim() } : {}),
        ...(token.trim() ? { token: token.trim() } : {}),
      });
      onConnected(ws);
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
        title={t("wizard.githubConnectTitle")}
        t={t}
      />
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <label className="flex flex-col gap-1">
          <span className="text-sm">{t("wizard.apiBase")}</span>
          <Input type="url" value={apiBase} onChange={(e) => setApiBase(e.target.value)} required />
        </label>
        <div className="flex flex-wrap gap-3">
          <label className="flex min-w-32 flex-1 flex-col gap-1">
            <span className="text-sm">{t("wizard.owner")}</span>
            <Input value={owner} onChange={(e) => setOwner(e.target.value)} required />
          </label>
          <label className="flex min-w-32 flex-1 flex-col gap-1">
            <span className="text-sm">{t("wizard.repo")}</span>
            <Input value={repo} onChange={(e) => setRepo(e.target.value)} required />
          </label>
          <label className="flex min-w-32 flex-1 flex-col gap-1">
            <span className="text-sm">{t("wizard.branch")}</span>
            <Input value={branch} onChange={(e) => setBranch(e.target.value)} required />
          </label>
        </div>
        <div className="flex flex-wrap gap-3">
          <label className="flex min-w-40 flex-1 flex-col gap-1">
            <span className="text-sm">{t("wizard.prefix")}</span>
            <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="notes/" />
          </label>
          <label className="flex min-w-40 flex-1 flex-col gap-1">
            <span className="text-sm">{t("wizard.tokenLabel")}</span>
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
            />
          </label>
        </div>
        {error ? (
          <p className="text-sm text-destructive" style={{ textWrap: "pretty" }}>
            {error}
          </p>
        ) : null}
        <div className="mt-2 flex justify-between">
          <Button variant="ghost" type="button" onClick={onBack}>
            {t("wizard.back")}
          </Button>
          <Button variant="brand" type="submit" disabled={busy}>
            {busy ? <Spinner className="size-3.5" /> : null}
            {t("wizard.testConnect")}
          </Button>
        </div>
      </form>
    </>
  );
}
