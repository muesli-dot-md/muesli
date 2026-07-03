<script lang="ts">
  // GitHub / Gitea / Forgejo attach form (settings.md §2.3) — the Contents-API
  // backend serves all three; only the api_base differs. The token lives in
  // the server's MUESLI_GITHUB_TOKEN env; the repo is probed before the row
  // is created (502 = unreachable, inline).
  import { errMsg } from "../apiError";
  import { t } from "../i18n/index.svelte";
  import { WorkspaceApiError, type WorkspaceApi } from "../workspaceApi";

  let {
    api,
    workspaceId,
    oncreated,
  }: {
    api: WorkspaceApi;
    workspaceId: string;
    oncreated: () => void;
  } = $props();

  let apiBase = $state("https://api.github.com");
  let owner = $state("");
  let repo = $state("");
  let branch = $state("main");
  let prefix = $state("");
  let busy = $state(false);
  let error: string | null = $state(null);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (busy) return;
    busy = true;
    error = null;
    try {
      await api.createStorageConnection(workspaceId, {
        kind: "github",
        api_base: apiBase.trim(),
        owner: owner.trim(),
        repo: repo.trim(),
        branch: branch.trim(),
        ...(prefix.trim() ? { prefix: prefix.trim() } : {}),
      });
      oncreated();
    } catch (e2) {
      if (e2 instanceof WorkspaceApiError && e2.status === 502) {
        error = t("settings.conn.unreachable", { detail: e2.message });
      } else if (e2 instanceof WorkspaceApiError && e2.status === 503) {
        error = t("settings.conn.serverMissingEnv", { detail: e2.message });
      } else {
        error = errMsg(e2);
      }
    } finally {
      busy = false;
    }
  }
</script>

<form class="mt-4 flex flex-col gap-3 border-t border-base-300 pt-4" onsubmit={submit}>
  <label class="flex flex-col gap-1">
    <span class="text-sm">{t("settings.conn.apiBase")}</span>
    <input class="input input-sm w-full" type="url" bind:value={apiBase} required />
    <span class="text-xs opacity-60">{t("settings.conn.apiBaseHint")}</span>
  </label>
  <div class="flex flex-wrap gap-3">
    <label class="flex min-w-40 flex-1 flex-col gap-1">
      <span class="text-sm">{t("settings.conn.owner")}</span>
      <input class="input input-sm w-full" bind:value={owner} required />
    </label>
    <label class="flex min-w-40 flex-1 flex-col gap-1">
      <span class="text-sm">{t("settings.conn.repo")}</span>
      <input class="input input-sm w-full" bind:value={repo} required />
    </label>
  </div>
  <div class="flex flex-wrap gap-3">
    <label class="flex min-w-40 flex-1 flex-col gap-1">
      <span class="text-sm">{t("settings.conn.branch")}</span>
      <input class="input input-sm w-full" bind:value={branch} required />
    </label>
    <label class="flex min-w-40 flex-1 flex-col gap-1">
      <span class="text-sm">{t("settings.conn.prefix")}</span>
      <input class="input input-sm w-full" bind:value={prefix} placeholder="notes/" />
    </label>
  </div>
  <p class="text-xs opacity-60">{t("settings.conn.gitTokenNote")}</p>
  {#if error}
    <p class="text-sm text-error">{error}</p>
  {/if}
  <div>
    <button class="btn btn-primary btn-sm" type="submit" disabled={busy}>
      {t("settings.conn.attach")}
    </button>
  </div>
</form>
