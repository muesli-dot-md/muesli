// S3 / R2 / MinIO attach form (settings.md §2.3). Credentials are per-workspace
// (plan 1a task 4): the access key + secret entered here are encrypted and stored
// against this connection, mirroring @muesli/workspace-setup's StepConnectS3 (the
// wizard's own S3 step). The server still accepts a connection with no credentials
// for self-hosts running MUESLI_S3_ACCESS_KEY/_SECRET_KEY from its environment, but
// this form always collects them so a fresh connection is never silently dependent
// on server env vars the admin may not control. The server probes the bucket before
// creating the row, so 502 = "couldn't reach it" inline. React port of the web
// settings/StorageS3Form.svelte.
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errMsg } from "@/services/apiError";
import { WorkspaceApiError, type WorkspaceApi } from "@/services/workspaceApi";
import { useT } from "@/state/i18n";

interface Props {
  api: WorkspaceApi;
  workspaceId: string;
  onCreated: () => void;
}

export function StorageS3Form({ api, workspaceId, onCreated }: Props) {
  const t = useT();

  const [endpoint, setEndpoint] = useState("");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("");
  const [prefix, setPrefix] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [policyText, setPolicyText] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The policy preview refreshes when bucket/prefix change (debounced by blur),
  // identical in shape to the wizard's StepConnectS3.
  async function refreshPolicy() {
    if (!bucket.trim()) return;
    try {
      const res = await api.getS3Policy(bucket.trim(), prefix.trim());
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
      await api.createStorageConnection(workspaceId, {
        kind: "s3",
        endpoint: endpoint.trim(),
        bucket: bucket.trim(),
        ...(region.trim() ? { region: region.trim() } : {}),
        ...(prefix.trim() ? { prefix: prefix.trim() } : {}),
        access_key_id: accessKeyId.trim(),
        secret_key: secretKey,
      });
      onCreated();
    } catch (e2) {
      if (e2 instanceof WorkspaceApiError && e2.status === 502) {
        setError(t("settings.conn.unreachable", { detail: e2.message }));
      } else if (e2 instanceof WorkspaceApiError && e2.status === 503) {
        setError(t("settings.conn.serverMissingEnv", { detail: e2.message }));
      } else {
        setError(errMsg(e2));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="mt-4 flex w-full flex-col gap-3 border-t border-surface-border pt-4"
      onSubmit={(e) => void submit(e)}
    >
      <label className="flex flex-col gap-1">
        <span className="text-sm">{t("settings.conn.endpoint")}</span>
        <Input
          className="h-8 w-full"
          type="url"
          value={endpoint}
          placeholder="https://s3.example.com"
          required
          onChange={(e) => setEndpoint(e.currentTarget.value)}
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-40 flex-1 flex-col gap-1">
          <span className="text-sm">{t("settings.conn.bucket")}</span>
          <Input
            className="h-8 w-full"
            value={bucket}
            required
            onChange={(e) => setBucket(e.currentTarget.value)}
            onBlur={() => void refreshPolicy()}
          />
        </label>
        <label className="flex min-w-40 flex-1 flex-col gap-1">
          <span className="text-sm">{t("settings.conn.region")}</span>
          <Input
            className="h-8 w-full"
            value={region}
            placeholder="us-east-1"
            onChange={(e) => setRegion(e.currentTarget.value)}
          />
        </label>
        <label className="flex min-w-40 flex-1 flex-col gap-1">
          <span className="text-sm">{t("settings.conn.prefix")}</span>
          <Input
            className="h-8 w-full"
            value={prefix}
            placeholder="notes/"
            onChange={(e) => setPrefix(e.currentTarget.value)}
            onBlur={() => void refreshPolicy()}
          />
        </label>
      </div>
      {policyText ? (
        <div className="relative">
          <pre className="max-h-40 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">
            {policyText}
          </pre>
          <Button
            variant="outline"
            size="xs"
            className="absolute right-2 top-2"
            type="button"
            onClick={() => void copyPolicy()}
          >
            {copied ? t("wizard.copied") : t("wizard.copyPolicy")}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-40 flex-1 flex-col gap-1">
          <span className="text-sm">{t("settings.conn.accessKeyId")}</span>
          <Input
            className="h-8 w-full"
            value={accessKeyId}
            autoComplete="off"
            required
            onChange={(e) => setAccessKeyId(e.currentTarget.value)}
          />
        </label>
        <label className="flex min-w-40 flex-1 flex-col gap-1">
          <span className="text-sm">{t("settings.conn.secretKey")}</span>
          <Input
            className="h-8 w-full"
            type="password"
            value={secretKey}
            autoComplete="off"
            required
            onChange={(e) => setSecretKey(e.currentTarget.value)}
          />
        </label>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div>
        <Button size="sm" type="submit" disabled={busy}>
          {t("settings.conn.attach")}
        </Button>
      </div>
    </form>
  );
}

export default StorageS3Form;
