// Settings → Connected storage (settings.md §2.3). Connections are
// WORKSPACE-scoped: the section opens with a workspace switcher (personal
// first, like WorkspacePanel) and is role-aware — members see the list
// read-only, admins get connect/disconnect. Google Drive connect is a
// FULL-PAGE navigation (the OAuth start is a session-cookie 302 chain; fetch
// can't follow it), with an honest "setup required" card when the server
// lacks the Google OAuth client. S3 and GitHub/Gitea attach via forms;
// Dropbox/OneDrive are labeled coming-soon stubs. React port of the web
// settings/ConnectionsSection.svelte; the SharePoint connect step comes from
// @muesli/workspace-setup's React components (V6 promotion).
import { useEffect, useState } from "react";
import { Cloud, Database, GitBranch, HardDrive } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { errMsg } from "@/services/apiError";
import { httpBase, loginUrl, type AuthInfo } from "@/services/identity";
import { driveDate } from "@/services/time";
import {
  createWorkspaceApi,
  WorkspaceApiError,
  type CreateStorageRequest,
  type SharePointLibrariesRequest,
  type StorageConnection,
  type StorageStatusResponse,
  type WorkspaceSummary,
} from "@/services/workspaceApi";
import { useT, type MessageKey } from "@/state/i18n";
import type { SharePointHost } from "@muesli/workspace-setup/host";
import { StepConnectSharePoint } from "@muesli/workspace-setup/react/StepConnectSharePoint";
import { SettingsCard } from "./SettingsCard";
import { SettingsRow } from "./SettingsRow";
import { StorageGitForm } from "./StorageGitForm";
import { StorageS3Form } from "./StorageS3Form";

interface Props {
  auth: AuthInfo;
  toast: (msg: string, kind?: "info" | "warning") => void;
}

const api = createWorkspaceApi({ httpBase });

/** The shared SharePoint connect step only needs three calls (SharePointHost). */
const sharepointHost: SharePointHost = {
  createStorageConnection: (id: string, body: CreateStorageRequest) =>
    api.createStorageConnection(id, body),
  getSharePointSetup: () => api.getSharePointSetup(),
  listSharePointLibraries: (id: string, body: SharePointLibrariesRequest) =>
    api.listSharePointLibraries(id, body),
};

function KindIcon({ kind, className }: { kind: string; className?: string }) {
  if (kind === "gdrive") return <HardDrive className={className} aria-hidden="true" />;
  if (kind === "s3") return <Database className={className} aria-hidden="true" />;
  if (kind === "github") return <GitBranch className={className} aria-hidden="true" />;
  return <Cloud className={className} aria-hidden="true" />;
}

export function ConnectionsSection({ auth, toast }: Props) {
  const t = useT();

  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connections, setConnections] = useState<StorageConnection[]>([]);
  const [googleConfigured, setGoogleConfigured] = useState(false);
  /** Storage health for the selected workspace (plan 1a task 10), fetched once
   *  per workspace switch alongside the connection list. */
  const [health, setHealth] = useState<StorageStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  /** In-flight reload of the connection list (workspace switch) — distinct
   *  from the initial `loading`, so the switched-to tab doesn't flash the
   *  "no connections" empty state while the fetch is still pending. */
  const [connsLoading, setConnsLoading] = useState(false);
  const [degraded, setDegraded] = useState<"signin" | "open" | "error" | null>(null);
  const [openForm, setOpenForm] = useState<"s3" | "git" | "sharepoint" | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  const selected = workspaces.find((w) => w.id === selectedId) ?? null;
  const isAdmin = selected?.role === "admin";
  const gdriveConn = connections.find((c) => c.kind === "gdrive") ?? null;
  /** The exact redirect URI a self-hoster must register with Google. */
  const driveRedirectUri = `${httpBase}/auth/storage/google/callback`;

  // `selectedId` is read through a ref-like closure guard in the async loaders
  // below; a module-level mutable mirror keeps the "still current?" checks
  // exact across awaits (React state reads inside async fns are stale).
  // Implemented with a simple object so both loaders share it.
  const [selectionGuard] = useState<{ current: string | null }>({ current: null });

  async function loadConnections(id: string) {
    if (!id) return;
    selectionGuard.current = id;
    setConnsLoading(true);
    try {
      const list = await api.listStorageConnections(id);
      if (selectionGuard.current !== id) return;
      setConnections(list.connections);
      setGoogleConfigured(list.google.configured);
    } catch (e) {
      if (selectionGuard.current !== id) return;
      toast(errMsg(e), "warning");
    } finally {
      if (selectionGuard.current === id) setConnsLoading(false);
    }
    if (selectionGuard.current !== id) return;
    const status = await api.getStorageStatus(id).catch(() => null);
    if (selectionGuard.current !== id) return;
    setHealth(status);
  }

  async function loadWorkspaces() {
    setLoading(true);
    try {
      const list = (await api.listWorkspaces()).workspaces;
      setWorkspaces(list);
      setDegraded(null);
      if (list.length > 0) {
        const id = list.some((w) => w.id === selectedId) ? selectedId! : list[0].id;
        setSelectedId(id);
        await loadConnections(id);
      }
    } catch (e) {
      if (e instanceof WorkspaceApiError && e.status === 401) setDegraded("signin");
      else if (e instanceof WorkspaceApiError && e.status === 503) setDegraded("open");
      else setDegraded("error");
    } finally {
      setLoading(false);
    }
  }

  function selectWorkspace(id: string) {
    setSelectedId(id);
    setOpenForm(null);
    setConnections([]);
    setHealth(null);
    void loadConnections(id);
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
    setDisconnecting(conn.id);
    try {
      await api.deleteStorageConnection(selectedId, conn.id);
      setConnections((cur) => cur.filter((c) => c.id !== conn.id));
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
      setDisconnecting(null);
    }
  }

  useEffect(() => {
    void loadWorkspaces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <header className="mb-5">
        <h2 className="text-lg font-semibold tracking-tight">{t("settings.nav.connections")}</h2>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground [text-wrap:pretty]">
          {t("settings.conn.intro")}
        </p>
      </header>

      {auth.mode === "open" || degraded === "open" ? (
        <p className="text-sm text-muted-foreground [text-wrap:pretty]">
          {t("ws.unavailableOpenMode")}
        </p>
      ) : degraded === "signin" ? (
        <p className="text-sm text-muted-foreground [text-wrap:pretty]">
          {t("settings.signInToManage")}{" "}
          <a className="text-primary underline-offset-4 hover:underline" href={loginUrl()}>
            {t("common.signIn")}
          </a>
        </p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : degraded === "error" ? (
        <p className="text-sm text-destructive">{t("settings.conn.loadFailed")}</p>
      ) : (
        <>
          {/* workspace switcher (personal-first ordering comes from the server) */}
          {workspaces.length > 1 ? (
            <div
              className="mb-4 flex flex-wrap gap-1"
              role="tablist"
              aria-label={t("settings.conn.workspaceLabel")}
            >
              {workspaces.map((w) => {
                const active = w.id === selectedId;
                return (
                  <button
                    key={w.id}
                    role="tab"
                    aria-selected={active}
                    className={cn(
                      "flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm transition-colors active:translate-y-px",
                      active
                        ? "bg-surface-selected font-medium text-surface-selected-foreground"
                        : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
                    )}
                    onClick={() => selectWorkspace(w.id)}
                  >
                    {w.name}
                    {w.is_personal ? (
                      <Badge variant="secondary">{t("ws.personalBadge")}</Badge>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* existing connections */}
          <SettingsCard description={!isAdmin ? t("settings.conn.adminOnly") : undefined}>
            {connections.length === 0 ? (
              <SettingsRow title={connsLoading ? t("common.loading") : t("settings.conn.empty")} />
            ) : null}
            {connections.map((conn) => (
              <SettingsRow
                key={conn.id}
                leading={<KindIcon kind={conn.kind} className="size-5 shrink-0 opacity-70" />}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {kindLabel(conn.kind)}
                    {credentialsLabel(conn) ? (
                      <Badge variant="secondary" className="ml-2 align-middle">
                        {credentialsLabel(conn)}
                      </Badge>
                    ) : null}
                  </p>
                  <p className="truncate font-mono text-xs text-muted-foreground">{facts(conn)}</p>
                  <p className="mt-0.5 text-xs opacity-50">
                    {t("settings.conn.connectedOn", { date: driveDate(conn.created_at) })}
                  </p>
                </div>
                {isAdmin ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-destructive hover:text-destructive"
                    disabled={disconnecting === conn.id}
                    onClick={() => void disconnect(conn)}
                  >
                    {t("settings.conn.disconnect")}
                  </Button>
                ) : null}
              </SettingsRow>
            ))}
            {health?.bound ? (
              <div className="px-4 py-3">
                <p
                  className={cn(
                    "text-xs",
                    health.healthy === false ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {t("settings.conn.health")}:{" "}
                  {health.healthy === false
                    ? t("settings.conn.unhealthy", { detail: health.last_error ?? "" })
                    : health.last_ok_unix
                      ? t("settings.conn.healthy", {
                          when: new Date(health.last_ok_unix * 1000).toLocaleString(),
                        })
                      : t("settings.conn.healthUnknown")}
                </p>
              </div>
            ) : null}
          </SettingsCard>

          {/* connect more */}
          <SettingsCard heading={t("settings.conn.addHeading")}>
            {/* Google Drive */}
            {!gdriveConn ? (
              <SettingsRow stacked>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                  <HardDrive className="size-5 shrink-0 opacity-70" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {t("settings.conn.gdrive")}
                      {!googleConfigured ? (
                        <Badge
                          className="ml-2 border-amber-500/40 bg-amber-500/10 align-middle text-amber-700 dark:text-amber-400"
                          variant="outline"
                        >
                          {t("settings.conn.driveSetupRequired")}
                        </Badge>
                      ) : null}
                    </p>
                    {!googleConfigured ? (
                      <p className="mt-1 text-xs text-muted-foreground [text-wrap:pretty]">
                        {t("settings.conn.driveNotConfigured")}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={!isAdmin || !googleConfigured}
                    onClick={connectDrive}
                  >
                    {t("settings.conn.connectDrive")}
                  </Button>
                </div>
                {!googleConfigured ? (
                  <p className="mt-3 text-xs text-muted-foreground [text-wrap:pretty]">
                    {t("settings.conn.driveSelfHostHint")}{" "}
                    <code className="ml-1 font-mono">{driveRedirectUri}</code>
                  </p>
                ) : null}
              </SettingsRow>
            ) : null}

            {/* S3 / R2 / MinIO */}
            <SettingsRow stacked>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                <Database className="size-5 shrink-0 opacity-70" aria-hidden="true" />
                <p className="min-w-0 flex-1 text-sm font-medium">{t("settings.conn.s3")}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={!isAdmin}
                  onClick={() => setOpenForm(openForm === "s3" ? null : "s3")}
                >
                  {t("settings.conn.attachS3")}
                </Button>
              </div>
              {openForm === "s3" && selectedId ? (
                <StorageS3Form
                  api={api}
                  workspaceId={selectedId}
                  onCreated={() => {
                    setOpenForm(null);
                    toast(t("settings.conn.attached"));
                    void loadConnections(selectedId);
                  }}
                />
              ) : null}
            </SettingsRow>

            {/* GitHub / Gitea */}
            <SettingsRow stacked>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                <GitBranch className="size-5 shrink-0 opacity-70" aria-hidden="true" />
                <p className="min-w-0 flex-1 text-sm font-medium">{t("settings.conn.github")}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={!isAdmin}
                  onClick={() => setOpenForm(openForm === "git" ? null : "git")}
                >
                  {t("settings.conn.attachGit")}
                </Button>
              </div>
              {openForm === "git" && selectedId ? (
                <StorageGitForm
                  api={api}
                  workspaceId={selectedId}
                  onCreated={() => {
                    setOpenForm(null);
                    toast(t("settings.conn.attached"));
                    void loadConnections(selectedId);
                  }}
                />
              ) : null}
            </SettingsRow>

            {/* SharePoint */}
            <SettingsRow stacked>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                <Cloud className="size-5 shrink-0 opacity-70" aria-hidden="true" />
                <p className="min-w-0 flex-1 text-sm font-medium">
                  {t("settings.conn.sharepoint")}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={!isAdmin}
                  onClick={() => setOpenForm(openForm === "sharepoint" ? null : "sharepoint")}
                >
                  {t("settings.conn.attachSharePoint")}
                </Button>
              </div>
              {openForm === "sharepoint" && selectedId ? (
                <div className="mt-3 flex flex-col">
                  <StepConnectSharePoint
                    host={sharepointHost}
                    t={(k: string, p?: Record<string, string | number>) => t(k as MessageKey, p)}
                    workspaceId={selectedId}
                    ensureWorkspace={() => Promise.resolve(selectedId)}
                    onConnected={() => {
                      setOpenForm(null);
                      toast(t("settings.conn.attached"));
                      void loadConnections(selectedId);
                    }}
                    onBack={() => setOpenForm(null)}
                    stepIndex={0}
                    totalSteps={1}
                    standalone
                  />
                </div>
              ) : null}
            </SettingsRow>

            {/* coming-soon stubs */}
            <SettingsRow
              title={t("settings.conn.dropbox")}
              leading={<Cloud className="size-5 shrink-0 opacity-70" aria-hidden="true" />}
              control={<Badge variant="secondary">{t("settings.comingSoon")}</Badge>}
            />
          </SettingsCard>
        </>
      )}
    </>
  );
}

export default ConnectionsSection;
