// S3 connect: policy FIRST (so keys are born least-privilege), then the form,
// then the probe with a live status line. React sibling of
// StepConnectS3.svelte, promoted from apps/desktop.

import { useState, type FormEvent } from "react";

import { Button, Input } from "./ui";
import { StepHeader } from "./StepHeader";
import type { ConnectStepProps } from "./wizard-common";

export function StepConnectS3({
  host,
  t,
  ensureWorkspace,
  onConnected,
  onBack,
  stepIndex,
  totalSteps,
}: ConnectStepProps) {
  const [endpoint, setEndpoint] = useState("");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("");
  const [prefix, setPrefix] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [policyText, setPolicyText] = useState("");
  const [copied, setCopied] = useState(false);

  // The policy preview refreshes when bucket/prefix change (debounced by blur).
  async function refreshPolicy() {
    if (!bucket.trim()) return;
    try {
      const res = await host.getS3Policy(bucket.trim(), prefix.trim());
      setPolicyText(JSON.stringify((res as { policy?: unknown }).policy ?? res, null, 2));
    } catch {
      setPolicyText("");
    }
  }

  async function copyPolicy() {
    await navigator.clipboard.writeText(policyText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const ws = await ensureWorkspace();
      await host.createStorageConnection(ws, {
        kind: "s3",
        endpoint: endpoint.trim(),
        bucket: bucket.trim(),
        ...(region.trim() ? { region: region.trim() } : {}),
        ...(prefix.trim() ? { prefix: prefix.trim() } : {}),
        access_key_id: accessKeyId.trim(),
        secret_key: secretKey,
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
        title={t("wizard.s3ConnectTitle")}
        body={t("wizard.s3PolicyLead")}
        t={t}
      />
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <div className="flex flex-wrap gap-3">
          <label className="flex min-w-40 flex-1 flex-col gap-1">
            <span className="text-sm">{t("wizard.bucket")}</span>
            <Input
              value={bucket}
              onChange={(e) => setBucket(e.target.value)}
              onBlur={() => void refreshPolicy()}
              required
            />
          </label>
          <label className="flex min-w-40 flex-1 flex-col gap-1">
            <span className="text-sm">{t("wizard.prefix")}</span>
            <Input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              onBlur={() => void refreshPolicy()}
              placeholder="notes/"
            />
          </label>
        </div>
        {policyText ? (
          <div className="relative">
            <pre className="max-h-40 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">
              {policyText}
            </pre>
            <Button
              size="xs"
              variant="outline"
              type="button"
              className="absolute top-2 right-2"
              onClick={() => void copyPolicy()}
            >
              {copied ? t("wizard.copied") : t("wizard.copyPolicy")}
            </Button>
          </div>
        ) : null}
        <label className="flex flex-col gap-1">
          <span className="text-sm">{t("wizard.endpoint")}</span>
          <Input
            type="url"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://s3.example.com"
            required
          />
        </label>
        <div className="flex flex-wrap gap-3">
          <label className="flex min-w-40 flex-1 flex-col gap-1">
            <span className="text-sm">{t("wizard.region")}</span>
            <Input
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="us-east-1"
            />
          </label>
          <label className="flex min-w-40 flex-1 flex-col gap-1">
            <span className="text-sm">{t("wizard.accessKeyId")}</span>
            <Input
              value={accessKeyId}
              onChange={(e) => setAccessKeyId(e.target.value)}
              autoComplete="off"
              required
            />
          </label>
          <label className="flex min-w-40 flex-1 flex-col gap-1">
            <span className="text-sm">{t("wizard.secretKey")}</span>
            <Input
              type="password"
              value={secretKey}
              onChange={(e) => setSecretKey(e.target.value)}
              autoComplete="off"
              required
            />
          </label>
        </div>
        {busy ? (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <span className="inline-block size-2 animate-pulse rounded-full bg-brand" />
            {t("wizard.probing")}
          </p>
        ) : null}
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
            {t("wizard.testConnect")}
          </Button>
        </div>
      </form>
    </>
  );
}
