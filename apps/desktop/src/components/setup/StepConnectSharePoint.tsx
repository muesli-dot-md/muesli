// SharePoint connect: app identity → admin grant → tenant + site → library
// picker + probe. Logic lives in @muesli/workspace-setup/sharepoint (rune-free,
// node-tested); this component holds an SpState in React state and renders the
// four stages. `standalone` (Settings → Connections mounts) hides the
// StepHeader + wizard Back. React port of
// packages/workspace-setup/src/StepConnectSharePoint.svelte.

import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { SharePointHost, SharePointSetup } from "@muesli/workspace-setup/host";
import {
  applyLibraries,
  backStage,
  connectBody,
  identityComplete,
  initialSpState,
  librariesBody,
  nextStage,
  siteComplete,
  substitute,
  type SpState,
} from "@muesli/workspace-setup/sharepoint";
import type { WizardKey } from "@muesli/workspace-setup/copy";
import { StepHeader } from "./StepHeader";
import type { Translate } from "./wizard-common";

const STAGES = [
  { id: "identity", label: "wizard.spStageIdentity" },
  { id: "grant", label: "wizard.spStageGrant" },
  { id: "site", label: "wizard.spStageSite" },
  { id: "connect", label: "wizard.spStageConnect" },
] as const satisfies readonly { id: SpState["stage"]; label: WizardKey }[];

export function StepConnectSharePoint({
  host,
  t,
  ensureWorkspace,
  onConnected,
  onBack,
  stepIndex,
  totalSteps,
  standalone = false,
}: {
  host: SharePointHost;
  t: Translate;
  workspaceId: string | null;
  ensureWorkspace: () => Promise<string>;
  onConnected: (workspaceId: string) => void;
  onBack: () => void;
  stepIndex: number;
  totalSteps: number;
  standalone?: boolean;
}) {
  const [setup, setSetup] = useState<SharePointSetup | null>(null);
  const [sp, setSp] = useState<SpState>(() => initialSpState(false));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // Private key file: read client-side and kept only in sp.privateKeyPem; never
  // rendered back into the DOM. This tracks just enough for a confirmation line.
  const [privateKeyFile, setPrivateKeyFile] = useState<{ name: string; size: number } | null>(null);

  /** The sharepoint.ts helpers mutate the state in place; clone-then-mutate
   *  keeps React's immutability contract without forking the shared logic. */
  function mutateSp(fn: (s: SpState) => void) {
    setSp((prev) => {
      const next = { ...prev };
      fn(next);
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    void host
      .getSharePointSetup()
      .then((s) => {
        if (cancelled) return;
        setSetup(s);
        setSp(initialSpState(s.configured));
      })
      .catch((e) => {
        if (cancelled) return;
        setError(t("wizard.error", { detail: e instanceof Error ? e.message : String(e) }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- host is a stable adapter, wired once
  }, []);

  function errMsg(e: unknown): string {
    return t("wizard.error", { detail: e instanceof Error ? e.message : String(e) });
  }

  async function copyText(key: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  }

  /** Back inside the stages; at the first stage the wizard's own Back takes over. */
  function back() {
    setError(null);
    const probe = { ...sp };
    if (backStage(probe)) setSp(probe);
    else onBack();
  }

  async function findLibraries() {
    if (busy || !setup || !siteComplete(sp)) return;
    setBusy(true);
    setError(null);
    try {
      const ws = await ensureWorkspace();
      const res = await host.listSharePointLibraries(ws, librariesBody(sp));
      mutateSp((s) => applyLibraries(s, res));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function pickPrivateKeyFile(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = ""; // re-picking the same file must fire change again
    if (!file) return;
    setError(null);
    let text: string;
    try {
      text = await file.text();
    } catch (e2) {
      setError(errMsg(e2));
      return;
    }
    if (!text.trim()) {
      setError(t("wizard.spKeyPemEmpty"));
      return;
    }
    mutateSp((s) => (s.privateKeyPem = text));
    setPrivateKeyFile({ name: file.name, size: file.size });
  }

  function clearPrivateKeyFile() {
    mutateSp((s) => (s.privateKeyPem = ""));
    setPrivateKeyFile(null);
  }

  async function connect(e: FormEvent) {
    e.preventDefault();
    const body = connectBody(sp);
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ws = await ensureWorkspace();
      await host.createStorageConnection(ws, body);
      onConnected(ws);
    } catch (e2) {
      setError(errMsg(e2));
    } finally {
      setBusy(false);
    }
  }

  function copyBlock(key: string, label: string, text: string): ReactNode {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-sm">{label}</span>
        <div className="relative">
          <pre
            className="max-h-40 overflow-auto rounded-lg bg-muted p-3 pr-16 font-mono text-xs"
            style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}
          >
            {text}
          </pre>
          <Button
            size="xs"
            variant="outline"
            type="button"
            className="absolute top-2 right-2"
            onClick={() => void copyText(key, text)}
          >
            {copied === key ? t("wizard.copied") : t("wizard.copy")}
          </Button>
        </div>
      </div>
    );
  }

  const errorLine = error ? (
    <p className="text-sm text-destructive" style={{ textWrap: "pretty" }}>
      {error}
    </p>
  ) : null;

  return (
    <>
      {!standalone ? (
        <StepHeader
          stepIndex={stepIndex}
          totalSteps={totalSteps}
          title={t("wizard.spConnectTitle")}
          body={t("wizard.spLead")}
          t={t}
        />
      ) : null}

      {!setup ? (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <span className="inline-block size-2 animate-pulse rounded-full bg-brand" />
          {error ?? "…"}
        </p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2" aria-hidden="true">
            {STAGES.map((s, i) => (
              <span
                key={s.id}
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-medium",
                  sp.stage === s.id
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {i + 1}. {t(s.label)}
              </span>
            ))}
          </div>

          {sp.stage === "identity" ? (
            <>
              <div className="flex flex-col gap-3">
                {setup.configured ? (
                  <>
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="radio"
                        className="mt-0.5 size-3.5 accent-brand"
                        checked={!sp.ownApp}
                        onChange={() => mutateSp((s) => (s.ownApp = false))}
                      />
                      <span className="text-sm">
                        {t("wizard.spServerApp")}
                        <span className="block font-mono text-xs text-muted-foreground">
                          {t("wizard.spServerAppId", { clientId: setup.client_id ?? "" })}
                        </span>
                      </span>
                    </label>
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="radio"
                        className="mt-0.5 size-3.5 accent-brand"
                        checked={sp.ownApp}
                        onChange={() => mutateSp((s) => (s.ownApp = true))}
                      />
                      <span className="text-sm">{t("wizard.spOwnApp")}</span>
                    </label>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground" style={{ textWrap: "pretty" }}>
                    {t("wizard.spNoServerApp")}
                  </p>
                )}
                {sp.ownApp ? (
                  <>
                    <p className="text-xs text-muted-foreground" style={{ textWrap: "pretty" }}>
                      {t("wizard.spOwnAppHint")}
                    </p>
                    <label className="flex flex-col gap-1">
                      <span className="text-sm">{t("wizard.spClientId")}</span>
                      <Input
                        className="font-mono"
                        value={sp.clientId}
                        onChange={(e) => {
                          const v = e.target.value;
                          mutateSp((s) => (s.clientId = v));
                        }}
                        autoComplete="off"
                      />
                    </label>
                    <div className="flex gap-4">
                      <label className="flex cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="radio"
                          className="size-3.5 accent-brand"
                          checked={sp.authMethod === "secret"}
                          onChange={() => mutateSp((s) => (s.authMethod = "secret"))}
                        />
                        {t("wizard.spAuthSecret")}
                      </label>
                      <label className="flex cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="radio"
                          className="size-3.5 accent-brand"
                          checked={sp.authMethod === "certificate"}
                          onChange={() => mutateSp((s) => (s.authMethod = "certificate"))}
                        />
                        {t("wizard.spAuthCert")}
                      </label>
                    </div>
                    {sp.authMethod === "secret" ? (
                      <label className="flex flex-col gap-1">
                        <span className="text-sm">{t("wizard.spClientSecret")}</span>
                        <Input
                          type="password"
                          value={sp.clientSecret}
                          onChange={(e) => {
                            const v = e.target.value;
                            mutateSp((s) => (s.clientSecret = v));
                          }}
                          autoComplete="off"
                        />
                      </label>
                    ) : (
                      <>
                        <label className="flex flex-col gap-1">
                          <span className="text-sm">{t("wizard.spCertPem")}</span>
                          <Textarea
                            className="font-mono"
                            rows={4}
                            value={sp.certificatePem}
                            onChange={(e) => {
                              const v = e.target.value;
                              mutateSp((s) => (s.certificatePem = v));
                            }}
                            placeholder="-----BEGIN CERTIFICATE-----"
                          />
                        </label>
                        <div className="flex flex-col gap-1">
                          <label className="text-sm" htmlFor="mws-sp-key-file">
                            {t("wizard.spKeyPem")}
                          </label>
                          {privateKeyFile ? (
                            <p className="text-xs text-muted-foreground">
                              {t("wizard.spKeyPemLoaded", {
                                name: privateKeyFile.name,
                                bytes: privateKeyFile.size,
                              })}
                              <Button
                                size="xs"
                                variant="ghost"
                                type="button"
                                className="ml-1"
                                onClick={clearPrivateKeyFile}
                              >
                                {t("wizard.spKeyPemRemove")}
                              </Button>
                            </p>
                          ) : (
                            <Input
                              id="mws-sp-key-file"
                              type="file"
                              accept=".pem,.key"
                              onChange={(e) => void pickPrivateKeyFile(e)}
                            />
                          )}
                        </div>
                      </>
                    )}
                  </>
                ) : null}
                {errorLine}
              </div>
              <div className="mt-4 flex justify-between">
                {standalone ? (
                  <span />
                ) : (
                  <Button variant="ghost" type="button" onClick={onBack}>
                    {t("wizard.back")}
                  </Button>
                )}
                <Button
                  variant="brand"
                  type="button"
                  disabled={!identityComplete(sp, setup)}
                  onClick={() => mutateSp((s) => nextStage(s, setup))}
                >
                  {t("wizard.next")}
                </Button>
              </div>
            </>
          ) : sp.stage === "grant" ? (
            <>
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground" style={{ textWrap: "pretty" }}>
                  {t("wizard.spGrantLead")}
                </p>
                {copyBlock(
                  "consent",
                  t("wizard.spConsentUrl"),
                  substitute(setup.consent_url_template, sp, setup),
                )}
                {copyBlock(
                  "graph",
                  t("wizard.spGrantGraph"),
                  substitute(setup.grant_snippet_graph, sp, setup),
                )}
                {copyBlock(
                  "pnp",
                  t("wizard.spGrantPowershell"),
                  substitute(setup.grant_snippet_powershell, sp, setup),
                )}
                <p className="text-xs text-muted-foreground" style={{ textWrap: "pretty" }}>
                  {t("wizard.spPlaceholderHint")}
                </p>
              </div>
              <div className="mt-4 flex justify-between">
                <Button variant="ghost" type="button" onClick={back}>
                  {t("wizard.back")}
                </Button>
                <Button variant="brand" type="button" onClick={() => mutateSp((s) => nextStage(s, setup))}>
                  {t("wizard.next")}
                </Button>
              </div>
            </>
          ) : sp.stage === "site" ? (
            <>
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-3">
                  <label className="flex min-w-40 flex-1 flex-col gap-1">
                    <span className="text-sm">{t("wizard.spTenant")}</span>
                    <Input
                      className="font-mono"
                      value={sp.tenant}
                      onChange={(e) => {
                        const v = e.target.value;
                        mutateSp((s) => (s.tenant = v));
                      }}
                      placeholder="contoso.onmicrosoft.com"
                      autoComplete="off"
                    />
                  </label>
                  <label className="flex min-w-40 flex-1 flex-col gap-1">
                    <span className="text-sm">{t("wizard.spSiteUrl")}</span>
                    <Input
                      type="url"
                      value={sp.siteUrl}
                      onChange={(e) => {
                        const v = e.target.value;
                        mutateSp((s) => (s.siteUrl = v));
                      }}
                      placeholder="https://contoso.sharepoint.com/sites/team"
                    />
                  </label>
                </div>
                {busy ? (
                  <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <span className="inline-block size-2 animate-pulse rounded-full bg-brand" />
                    {t("wizard.spFinding")}
                  </p>
                ) : null}
                {errorLine}
              </div>
              <div className="mt-4 flex justify-between">
                <Button variant="ghost" type="button" onClick={back}>
                  {t("wizard.back")}
                </Button>
                <Button
                  variant="brand"
                  type="button"
                  disabled={busy || !siteComplete(sp)}
                  onClick={() => void findLibraries()}
                >
                  {t("wizard.spFindLibraries")}
                </Button>
              </div>
            </>
          ) : (
            <form className="flex flex-col gap-3" onSubmit={(e) => void connect(e)}>
              <p className="text-sm text-muted-foreground">
                {t("wizard.spSite", { name: sp.siteName })}
              </p>
              <label className="flex flex-col gap-1">
                <span className="text-sm">{t("wizard.spLibrary")}</span>
                <select
                  className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                  value={sp.driveId}
                  onChange={(e) => {
                    const v = e.target.value;
                    mutateSp((s) => (s.driveId = v));
                  }}
                >
                  {sp.libraries.map((lib) => (
                    <option key={lib.drive_id} value={lib.drive_id}>
                      {lib.name}
                      {lib.is_default ? ` — ${t("wizard.spDefault")}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm">{t("wizard.prefix")}</span>
                <Input
                  value={sp.prefix}
                  onChange={(e) => {
                    const v = e.target.value;
                    mutateSp((s) => (s.prefix = v));
                  }}
                  placeholder="notes/"
                />
              </label>
              {busy ? (
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <span className="inline-block size-2 animate-pulse rounded-full bg-brand" />
                  {t("wizard.probing")}
                </p>
              ) : null}
              {errorLine}
              <div className="mt-2 flex justify-between">
                <Button variant="ghost" type="button" onClick={back}>
                  {t("wizard.back")}
                </Button>
                <Button variant="brand" type="submit" disabled={busy}>
                  {t("wizard.testConnect")}
                </Button>
              </div>
            </form>
          )}
        </>
      )}
    </>
  );
}
