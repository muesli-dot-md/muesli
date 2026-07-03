<script lang="ts">
  // Settings → Connected storage (settings.md §2.3). Connections are
  // WORKSPACE-scoped: the section opens with a workspace switcher (personal
  // first, like WorkspacePanel) and is role-aware — members see the list
  // read-only, admins get connect/disconnect. Google Drive connect is a
  // FULL-PAGE navigation (the OAuth start is a session-cookie 302 chain; fetch
  // can't follow it), with an honest "setup required" card when the server
  // lacks the Google OAuth client. S3 and GitHub/Gitea attach via forms;
  // Dropbox/OneDrive are labeled coming-soon stubs.
  import Cloud from "@lucide/svelte/icons/cloud";
  import Database from "@lucide/svelte/icons/database";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import HardDrive from "@lucide/svelte/icons/hard-drive";
  import { onMount } from "svelte";
  import { errMsg } from "../apiError";
  import { t, type MessageKey } from "../i18n/index.svelte";
  import { httpBase, loginUrl, type AuthInfo } from "../identity";
  import { driveDate } from "../time";
  import {
    createWorkspaceApi,
    WorkspaceApiError,
    type CreateStorageRequest,
    type SharePointLibrariesRequest,
    type StorageConnection,
    type StorageStatusResponse,
    type WorkspaceSummary,
  } from "../workspaceApi";
  import SettingRow from "./SettingRow.svelte";
  import SettingsCard from "./SettingsCard.svelte";
  import StorageGitForm from "./StorageGitForm.svelte";
  import StorageS3Form from "./StorageS3Form.svelte";
  import StepConnectSharePoint from "@muesli/workspace-setup/StepConnectSharePoint.svelte";
  import type { SharePointHost } from "@muesli/workspace-setup/host";

  let {
    auth,
    toast,
  }: {
    auth: AuthInfo;
    toast: (msg: string, kind?: "info" | "warning") => void;
  } = $props();

  const api = createWorkspaceApi({ httpBase });

  let workspaces: WorkspaceSummary[] = $state([]);
  let selectedId: string | null = $state(null);
  let connections: StorageConnection[] = $state([]);
  let googleConfigured = $state(false);
  /** Storage health for the selected workspace (plan 1a task 10), fetched once
   *  per workspace switch alongside the connection list. */
  let health: StorageStatusResponse | null = $state(null);
  let loading = $state(true);
  /** In-flight reload of the connection list (workspace switch) — distinct
   *  from the initial `loading`, so the switched-to tab doesn't flash the
   *  "no connections" empty state while the fetch is still pending. */
  let connsLoading = $state(false);
  let degraded: "signin" | "open" | "error" | null = $state(null);
  let openForm: "s3" | "git" | "sharepoint" | null = $state(null);
  let disconnecting: string | null = $state(null);

  const selected = $derived(workspaces.find((w) => w.id === selectedId) ?? null);
  const isAdmin = $derived(selected?.role === "admin");
  const gdriveConn = $derived(connections.find((c) => c.kind === "gdrive") ?? null);
  /** The exact redirect URI a self-hoster must register with Google. */
  const driveRedirectUri = `${httpBase}/auth/storage/google/callback`;

  /** The shared SharePoint connect step only needs three calls (SharePointHost). */
  const sharepointHost: SharePointHost = {
    createStorageConnection: (id: string, body: CreateStorageRequest) =>
      api.createStorageConnection(id, body),
    getSharePointSetup: () => api.getSharePointSetup(),
    listSharePointLibraries: (id: string, body: SharePointLibrariesRequest) =>
      api.listSharePointLibraries(id, body),
  };


  async function loadWorkspaces() {
    loading = true;
    try {
      workspaces = (await api.listWorkspaces()).workspaces;
      degraded = null;
      if (workspaces.length > 0) {
        if (!workspaces.some((w) => w.id === selectedId)) selectedId = workspaces[0].id;
        await loadConnections();
      }
    } catch (e) {
      if (e instanceof WorkspaceApiError && e.status === 401) degraded = "signin";
      else if (e instanceof WorkspaceApiError && e.status === 503) degraded = "open";
      else degraded = "error";
    } finally {
      loading = false;
    }
  }

  async function loadConnections() {
    const id = selectedId;
    if (!id) return;
    connsLoading = true;
    try {
      const list = await api.listStorageConnections(id);
      if (id !== selectedId) return;
      connections = list.connections;
      googleConfigured = list.google.configured;
    } catch (e) {
      if (id !== selectedId) return;
      toast(errMsg(e), "warning");
    } finally {
      if (id === selectedId) connsLoading = false;
    }
    if (id !== selectedId) return;
    const status = await api.getStorageStatus(id).catch(() => null);
    if (id !== selectedId) return;
    health = status;
  }

  function selectWorkspace(id: string) {
    selectedId = id;
    openForm = null;
    connections = [];
    health = null;
    void loadConnections();
  }

  function connectDrive() {
    if (!selectedId) return;
    // Full-page navigation, never fetch: the OAuth start 302s to Google
    // authenticated by the session cookie, and the callback lands back here.
    window.location.href = `${httpBase}/api/workspaces/${encodeURIComponent(selectedId)}/storage/google/start`;
  }

  function kindLabel(kind: string): string {
    if (kind === "gdrive") return t("settings.conn.gdrive");
    if (kind === "s3") return t("settings.conn.s3");
    if (kind === "github") return t("settings.conn.github");
    if (kind === "sharepoint") return t("settings.conn.sharepoint");
    return kind;
  }

  /** s3/github connections carry a `credentials` tag (plan 1a task 4): "workspace"
   *  when a per-workspace key was stored on the connection, "server-env" when it
   *  falls back to the server's environment variables. gdrive has neither. */
  function credentialsLabel(conn: StorageConnection): string | null {
    const c = conn.config.credentials;
    if (c === "workspace") return t("settings.conn.credsWorkspace");
    if (c === "server-env" || c === "server-app") return t("settings.conn.credsServer");
    return null;
  }

  /** The key config facts per card: bucket/prefix, owner/repo@branch, Drive folder. */
  function facts(conn: StorageConnection): string {
    const c = conn.config;
    const str = (k: string) => (typeof c[k] === "string" ? (c[k] as string) : "");
    if (conn.kind === "s3") {
      const prefix = str("prefix");
      return `${str("bucket")}${prefix ? ` / ${prefix}` : ""} — ${str("endpoint")}`;
    }
    if (conn.kind === "github") {
      const prefix = str("prefix");
      return `${str("owner")}/${str("repo")}@${str("branch")}${prefix ? ` / ${prefix}` : ""}`;
    }
    if (conn.kind === "sharepoint") {
      const prefix = str("prefix");
      return `${str("site_url")} → ${str("drive_name")}${prefix ? ` / ${prefix}` : ""}`;
    }
    if (conn.kind === "gdrive") return str("folder_name") || "Muesli";
    return "";
  }

  async function disconnect(conn: StorageConnection) {
    if (!selectedId) return;
    if (!confirm(t("settings.conn.disconnectConfirm", { kind: kindLabel(conn.kind) }))) return;
    disconnecting = conn.id;
    try {
      await api.deleteStorageConnection(selectedId, conn.id);
      connections = connections.filter((c) => c.id !== conn.id);
      toast(t("settings.conn.disconnected"));
    } catch (e) {
      if (e instanceof WorkspaceApiError && e.status === 409) {
        let n: number;
        try {
          n = (JSON.parse(e.bodyText) as { attached_documents: number }).attached_documents;
        } catch {
          n = 1;
        }
        toast(
          t(n === 1 ? "settings.conn.attachedDocs.one" : "settings.conn.attachedDocs.other", {
            count: n,
          }),
          "warning",
        );
      } else {
        toast(errMsg(e), "warning");
      }
    } finally {
      disconnecting = null;
    }
  }

  onMount(() => {
    void loadWorkspaces();
  });
</script>

{#snippet kindIcon(kind: string, cls: string)}
  {#if kind === "gdrive"}
    <HardDrive class={cls} aria-hidden="true" />
  {:else if kind === "s3"}
    <Database class={cls} aria-hidden="true" />
  {:else if kind === "github"}
    <GitBranch class={cls} aria-hidden="true" />
  {:else}
    <Cloud class={cls} aria-hidden="true" />
  {/if}
{/snippet}

<header class="mb-5">
  <h2 class="text-lg font-semibold tracking-tight">{t("settings.nav.connections")}</h2>
  <p class="mt-1 max-w-prose text-sm text-[var(--text-muted)]" style="text-wrap: pretty;">
    {t("settings.conn.intro")}
  </p>
</header>

{#if auth.mode === "open" || degraded === "open"}
  <p class="text-sm text-[var(--text-muted)]" style="text-wrap: pretty;">
    {t("ws.unavailableOpenMode")}
  </p>
{:else if degraded === "signin"}
  <p class="text-sm text-[var(--text-muted)]" style="text-wrap: pretty;">
    {t("settings.signInToManage")}
    <a class="link link-primary" href={loginUrl()}>{t("common.signIn")}</a>
  </p>
{:else if loading}
  <p class="text-sm text-[var(--text-muted)]">{t("common.loading")}</p>
{:else if degraded === "error"}
  <p class="text-sm text-error">{t("settings.conn.loadFailed")}</p>
{:else}
  <!-- workspace switcher (personal-first ordering comes from the server) -->
  {#if workspaces.length > 1}
    <div
      class="mb-4 flex flex-wrap gap-1"
      role="tablist"
      aria-label={t("settings.conn.workspaceLabel")}
    >
      {#each workspaces as w (w.id)}
        <button
          role="tab"
          aria-selected={w.id === selectedId}
          class="arc-tap min-h-10 rounded-field px-4 py-2 text-sm {w.id === selectedId
            ? 'font-medium text-base-content'
            : 'text-[var(--text-muted)] hover:bg-[var(--row-hover)] hover:text-base-content'}"
          style={w.id === selectedId
            ? "background: var(--lift); box-shadow: var(--shadow-lift);"
            : ""}
          onclick={() => selectWorkspace(w.id)}
        >
          {w.name}
          {#if w.is_personal}
            <span class="badge badge-ghost badge-xs ml-1 align-middle">{t("ws.personalBadge")}</span
            >
          {/if}
        </button>
      {/each}
    </div>
  {/if}

  <!-- existing connections -->
  <SettingsCard description={!isAdmin ? t("settings.conn.adminOnly") : undefined}>
    {#if connections.length === 0}
      <SettingRow title={connsLoading ? t("common.loading") : t("settings.conn.empty")} />
    {/if}
    {#each connections as conn (conn.id)}
      <SettingRow>
        {#snippet leading()}
          {@render kindIcon(conn.kind, "h-5 w-5 shrink-0 opacity-70")}
        {/snippet}
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">
            {kindLabel(conn.kind)}
            {#if credentialsLabel(conn)}
              <span class="badge badge-ghost badge-sm ml-2 align-middle">
                {credentialsLabel(conn)}
              </span>
            {/if}
          </p>
          <p class="truncate font-mono text-xs text-[var(--text-muted)]">{facts(conn)}</p>
          <p class="mt-0.5 text-xs opacity-50">
            {t("settings.conn.connectedOn", { date: driveDate(conn.created_at) })}
          </p>
        </div>
        {#if isAdmin}
          <button
            class="btn btn-ghost btn-sm shrink-0 text-error"
            disabled={disconnecting === conn.id}
            onclick={() => void disconnect(conn)}
          >
            {t("settings.conn.disconnect")}
          </button>
        {/if}
      </SettingRow>
    {/each}
    {#if health?.bound}
      <div class="border-t border-base-300/60 px-5 py-3">
        <p class="text-xs {health.healthy === false ? 'text-error' : 'text-[var(--text-muted)]'}">
          {t("settings.conn.health")}:
          {#if health.healthy === false}
            {t("settings.conn.unhealthy", { detail: health.last_error ?? "" })}
          {:else if health.last_ok_unix}
            {t("settings.conn.healthy", {
              when: new Date(health.last_ok_unix * 1000).toLocaleString(),
            })}
          {:else}
            {t("settings.conn.healthUnknown")}
          {/if}
        </p>
      </div>
    {/if}
  </SettingsCard>

  <!-- connect more -->
  <SettingsCard heading={t("settings.conn.addHeading")}>
    <!-- Google Drive -->
    {#if !gdriveConn}
      <SettingRow stacked>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-3">
          <HardDrive class="h-5 w-5 shrink-0 opacity-70" aria-hidden="true" />
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium">
              {t("settings.conn.gdrive")}
              {#if !googleConfigured}
                <span class="badge badge-warning badge-sm ml-2 align-middle">
                  {t("settings.conn.driveSetupRequired")}
                </span>
              {/if}
            </p>
            {#if !googleConfigured}
              <p class="mt-1 text-xs text-[var(--text-muted)]" style="text-wrap: pretty;">
                {t("settings.conn.driveNotConfigured")}
              </p>
            {/if}
          </div>
          <button
            class="btn btn-sm shrink-0"
            disabled={!isAdmin || !googleConfigured}
            onclick={connectDrive}
          >
            {t("settings.conn.connectDrive")}
          </button>
        </div>
        {#if !googleConfigured}
          <p class="mt-3 text-xs text-[var(--text-muted)]" style="text-wrap: pretty;">
            {t("settings.conn.driveSelfHostHint")}
            <code class="ml-1 font-mono">{driveRedirectUri}</code>
          </p>
        {/if}
      </SettingRow>
    {/if}

    <!-- S3 / R2 / MinIO -->
    <SettingRow stacked>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-3">
        <Database class="h-5 w-5 shrink-0 opacity-70" aria-hidden="true" />
        <p class="min-w-0 flex-1 text-sm font-medium">{t("settings.conn.s3")}</p>
        <button
          class="btn btn-sm shrink-0"
          disabled={!isAdmin}
          onclick={() => (openForm = openForm === "s3" ? null : "s3")}
        >
          {t("settings.conn.attachS3")}
        </button>
      </div>
      {#if openForm === "s3" && selectedId}
        <StorageS3Form
          {api}
          workspaceId={selectedId}
          oncreated={() => {
            openForm = null;
            toast(t("settings.conn.attached"));
            void loadConnections();
          }}
        />
      {/if}
    </SettingRow>

    <!-- GitHub / Gitea -->
    <SettingRow stacked>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-3">
        <GitBranch class="h-5 w-5 shrink-0 opacity-70" aria-hidden="true" />
        <p class="min-w-0 flex-1 text-sm font-medium">{t("settings.conn.github")}</p>
        <button
          class="btn btn-sm shrink-0"
          disabled={!isAdmin}
          onclick={() => (openForm = openForm === "git" ? null : "git")}
        >
          {t("settings.conn.attachGit")}
        </button>
      </div>
      {#if openForm === "git" && selectedId}
        <StorageGitForm
          {api}
          workspaceId={selectedId}
          oncreated={() => {
            openForm = null;
            toast(t("settings.conn.attached"));
            void loadConnections();
          }}
        />
      {/if}
    </SettingRow>

    <!-- SharePoint -->
    <SettingRow stacked>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-3">
        <Cloud class="h-5 w-5 shrink-0 opacity-70" aria-hidden="true" />
        <p class="min-w-0 flex-1 text-sm font-medium">{t("settings.conn.sharepoint")}</p>
        <button
          class="btn btn-sm shrink-0"
          disabled={!isAdmin}
          onclick={() => (openForm = openForm === "sharepoint" ? null : "sharepoint")}
        >
          {t("settings.conn.attachSharePoint")}
        </button>
      </div>
      {#if openForm === "sharepoint" && selectedId}
        <div class="mws-root mt-3 flex flex-col">
          <StepConnectSharePoint
            host={sharepointHost}
            t={(k, p) => t(k as MessageKey, p)}
            workspaceId={selectedId}
            ensureWorkspace={() => Promise.resolve(selectedId!)}
            onconnected={() => {
              openForm = null;
              toast(t("settings.conn.attached"));
              void loadConnections();
            }}
            onback={() => (openForm = null)}
            stepIndex={0}
            totalSteps={1}
            standalone
          />
        </div>
      {/if}
    </SettingRow>

    <!-- coming-soon stubs -->
    {#each [t("settings.conn.dropbox")] as name (name)}
      <SettingRow title={name}>
        {#snippet leading()}
          <Cloud class="h-5 w-5 shrink-0 opacity-70" aria-hidden="true" />
        {/snippet}
        {#snippet control()}
          <span class="badge badge-ghost badge-sm">{t("settings.comingSoon")}</span>
        {/snippet}
      </SettingRow>
    {/each}
  </SettingsCard>
{/if}
