// GitHub / Gitea / Forgejo attach form (settings.md §2.3) — the Contents-API
// backend serves all three; only the api_base differs. The token lives in
// the server's MUESLI_GITHUB_TOKEN env; the repo is probed before the row
// is created (502 = unreachable, inline). React port of the web
// settings/StorageGitForm.svelte.
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

export function StorageGitForm({ api, workspaceId, onCreated }: Props) {
  const t = useT();

  const [apiBase, setApiBase] = useState("https://api.github.com");
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [prefix, setPrefix] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.createStorageConnection(workspaceId, {
        kind: "github",
        api_base: apiBase.trim(),
        owner: owner.trim(),
        repo: repo.trim(),
        branch: branch.trim(),
        ...(prefix.trim() ? { prefix: prefix.trim() } : {}),
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
        <span className="text-sm">{t("settings.conn.apiBase")}</span>
        <Input
          className="h-8 w-full"
          type="url"
          value={apiBase}
          required
          onChange={(e) => setApiBase(e.currentTarget.value)}
        />
        <span className="text-xs opacity-60">{t("settings.conn.apiBaseHint")}</span>
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-40 flex-1 flex-col gap-1">
          <span className="text-sm">{t("settings.conn.owner")}</span>
          <Input
            className="h-8 w-full"
            value={owner}
            required
            onChange={(e) => setOwner(e.currentTarget.value)}
          />
        </label>
        <label className="flex min-w-40 flex-1 flex-col gap-1">
          <span className="text-sm">{t("settings.conn.repo")}</span>
          <Input
            className="h-8 w-full"
            value={repo}
            required
            onChange={(e) => setRepo(e.currentTarget.value)}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-40 flex-1 flex-col gap-1">
          <span className="text-sm">{t("settings.conn.branch")}</span>
          <Input
            className="h-8 w-full"
            value={branch}
            required
            onChange={(e) => setBranch(e.currentTarget.value)}
          />
        </label>
        <label className="flex min-w-40 flex-1 flex-col gap-1">
          <span className="text-sm">{t("settings.conn.prefix")}</span>
          <Input
            className="h-8 w-full"
            value={prefix}
            placeholder="notes/"
            onChange={(e) => setPrefix(e.currentTarget.value)}
          />
        </label>
      </div>
      <p className="text-xs opacity-60">{t("settings.conn.gitTokenNote")}</p>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div>
        <Button size="sm" type="submit" disabled={busy}>
          {t("settings.conn.attach")}
        </Button>
      </div>
    </form>
  );
}

export default StorageGitForm;
