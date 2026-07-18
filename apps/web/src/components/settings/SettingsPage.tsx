// Full-page settings shell at #~settings/<section>, in the Multica layout: a
// settings sub-sidebar with a small-caps "My Account" header over
// neutral-gray icon rows, and a right card-based content column. The shell
// owns auth, the toast, the OAuth-return notice, AND the workspace selection
// for the single Workspace page (its selector + General/Members content all
// read the same loaded list/detail). Each section is its own component in
// this directory. React port of the web SettingsPage.svelte, laid over the
// desktop SettingsPanel's Multica vertical line-nav pattern; section
// selection is DRIVEN BY THE ROUTE STORE (gotoSettings keeps the push-once/
// replace-inside history semantics — never push per section switch).
import { useEffect, useRef, useState } from "react";
import {
  Bell,
  Cable,
  Info,
  KeyRound,
  Languages,
  Settings,
  SlidersHorizontal,
  User,
  X,
  type LucideIcon,
} from "lucide-react";
import { AccountMenu } from "@/components/home/AccountMenu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  fetchMe,
  httpBase,
  logout,
  type AuthInfo,
  type Me,
} from "@/services/identity";
import {
  createWorkspaceApi,
  type WorkspaceDetail,
  type WorkspaceSummary,
} from "@/services/workspaceApi";
import { useT } from "@/state/i18n";
import { gotoHome, gotoSettings, type SettingsSection } from "@/state/route";
import { AboutSection } from "./AboutSection";
import { ApiKeysSection } from "./ApiKeysSection";
import { ConnectionsSection } from "./ConnectionsSection";
import { LanguageSection } from "./LanguageSection";
import { MembersSection } from "./MembersSection";
import { NativeSelect } from "./NativeSelect";
import { NotificationsSection } from "./NotificationsSection";
import { PreferencesSection } from "./PreferencesSection";
import { ProfileSection } from "./ProfileSection";
import {
  settingsNavItems,
  type SettingsIconKey,
  type SettingsNavItem,
} from "./settingsNav";
import { ShortcutsSection } from "./ShortcutsSection";
import { WorkspaceGeneralSection } from "./WorkspaceGeneralSection";

const ICONS: Record<SettingsIconKey, LucideIcon> = {
  user: User,
  sliders: SlidersHorizontal,
  languages: Languages,
  bell: Bell,
  keyRound: KeyRound,
  cable: Cable,
  info: Info,
  settings: Settings,
};

const wsApi = createWorkspaceApi({ httpBase });

interface Props {
  section: SettingsSection;
  embedded?: boolean;
  /** Profile edits (display name / avatar) also flow up to the host so its
   *  own copy of the signed-in user — e.g. Home's sidebar chip — follows
   *  live instead of reverting to a stale fetch when settings closes. */
  onUserChanged?: (user: Me) => void;
}

export function SettingsPage({ section, embedded = false, onUserChanged }: Props) {
  const t = useT();

  const [auth, setAuth] = useState<AuthInfo>({ mode: "open", user: null });
  // True once the initial fetchMe + loadWorkspaces have settled. Until then
  // `showWorkspace` is false for the wrong reason (nothing has loaded yet),
  // so it must not drive navigation.
  const [loaded, setLoaded] = useState(false);

  // --- shared workspace context (the Workspace page's selector + content) ------
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [selectedWsId, setSelectedWsId] = useState<string | null>(null);
  const [wsDetail, setWsDetail] = useState<WorkspaceDetail | null>(null);
  const selectedWs = workspaces.find((w) => w.id === selectedWsId) ?? null;
  // The workspace page needs a real, signed-in workspace to act on.
  const showWorkspace = auth.mode === "oidc" && !!auth.user && workspaces.length > 0;

  // The "still current?" guard for slow detail responses — a mutable ref so
  // the checks stay exact across awaits (React state reads in async fns are
  // stale by design).
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedWsId;

  async function loadWsDetail(id: string) {
    try {
      const detail = await wsApi.getWorkspace(id);
      // A slow response for a workspace the user has already switched away
      // from must not clobber the newer selection's detail.
      if (selectedRef.current !== id) return;
      setWsDetail(detail);
    } catch {
      if (selectedRef.current !== id) return;
      setWsDetail(null);
    }
  }

  async function loadWorkspaces(a: AuthInfo) {
    if (a.mode !== "oidc" || !a.user) return;
    try {
      const list = (await wsApi.listWorkspaces()).workspaces;
      setWorkspaces(list);
      let id = selectedRef.current;
      if (!list.some((w) => w.id === id)) id = list[0]?.id ?? null;
      setSelectedWsId(id);
      selectedRef.current = id;
      if (id) await loadWsDetail(id);
    } catch {
      // Open mode (503) / signed out (401): the workspace page just stays hidden.
      setWorkspaces([]);
      setSelectedWsId(null);
      selectedRef.current = null;
      setWsDetail(null);
    }
  }

  function selectWorkspace(id: string) {
    if (id === selectedWsId) return;
    setSelectedWsId(id);
    selectedRef.current = id;
    setWsDetail(null);
    void loadWsDetail(id);
  }

  async function reloadWorkspace() {
    // After a rename/leave/member change: refresh the list (name/membership may
    // have changed) and re-pin the selection, then reload detail. Leaving or
    // deleting the selected workspace falls back to the first (personal) one
    // via loadWorkspaces' re-pin — the page itself stays valid.
    await loadWorkspaces(auth);
  }

  // --- toast -------------------------------------------------------------------
  const [toast, setToast] = useState("");
  const [toastKind, setToastKind] = useState<"info" | "warning">("info");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function showToast(msg: string, kind: "info" | "warning" = "info") {
    setToast(msg);
    setToastKind(kind);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4000);
  }

  // One flat list drives both the sidebar rail and the mobile tab strip. The
  // rail additionally splits it into two visual groups — the account pages
  // under the "My Account" header, the workspace item under its own small-caps
  // header — matching the old two-group rhythm without resurrecting the group
  // machinery. The mobile strip stays one flat row (it has no headers).
  const nav = settingsNavItems(showWorkspace);
  const accountNav = nav.filter((i) => i.section !== "workspace");
  const workspaceNav = nav.filter((i) => i.section === "workspace");

  // If the route points at the workspace page but none is available (open
  // mode / signed out), bounce to Profile so we never render an empty pane.
  // Gated on `loaded`: on a fresh mount at #~settings/workspace (or an aliased
  // #general/#members deep link) this effect fires before fetchMe/
  // loadWorkspaces resolve, and bouncing then would permanently kick
  // signed-in users off their deep link.
  useEffect(() => {
    if (loaded && !showWorkspace && section === "workspace") gotoSettings("profile");
  }, [loaded, showWorkspace, section]);

  function close() {
    if (history.length > 1) history.back();
    else gotoHome();
  }

  async function signOut() {
    // true = the browser is off to the IdP's end_session URL (RP-initiated
    // logout) — the caller must do NOTHING more locally.
    if (await logout()) return;
    setAuth((a) => ({ ...a, user: null }));
    setWorkspaces([]);
    setSelectedWsId(null);
    selectedRef.current = null;
    setWsDetail(null);
  }

  useEffect(() => {
    // fetchMe never rejects (it falls back to open mode), and loadWorkspaces
    // catches internally — but `loaded` landing must not depend on that prose
    // invariant: the finally makes the bounce guard structurally unable to
    // wedge shut.
    fetchMe()
      .then(async (a) => {
        setAuth(a);
        await loadWorkspaces(a);
      })
      .finally(() => setLoaded(true));
    // Google Drive OAuth return: gdrive::callback redirects to
    // {web_origin}/?storage=connected|error#~settings/connections.
    const params = new URLSearchParams(location.search);
    const storage = params.get("storage");
    if (storage) {
      params.delete("storage");
      const qs = params.toString();
      history.replaceState(
        null,
        "",
        `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`,
      );
      if (storage === "connected") showToast(t("settings.conn.driveConnected"));
      else showToast(t("settings.conn.driveError"), "warning");
    }
    return () => clearTimeout(toastTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onUserUpdated(user: Me) {
    setAuth((a) => ({ ...a, user }));
    onUserChanged?.(user);
  }

  function NavButton({ item, rail }: { item: SettingsNavItem; rail: boolean }) {
    const Icon = ICONS[item.icon];
    const selected = section === item.section;
    return (
      <button
        type="button"
        className={cn(
          "flex h-8 items-center gap-2 rounded-lg text-sm transition-colors active:translate-y-px",
          rail ? "w-full px-2.5 text-left" : "shrink-0 whitespace-nowrap px-2.5",
          selected
            ? "bg-surface-selected font-medium text-surface-selected-foreground"
            : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
        )}
        aria-current={selected ? "page" : undefined}
        onClick={() => gotoSettings(item.section)}
      >
        <Icon className={cn("size-4", !selected && "opacity-70")} aria-hidden="true" />
        {t(item.labelKey)}
      </button>
    );
  }

  return (
    <>
      {/* Embedded (inside Home's main panel): fill the card, no screen-height
          shell, no top bar — Home owns the chrome (workspaces sidebar +
          account menu). Standalone: the full-page shell with its own header. */}
      <div
        className={
          embedded
            ? "flex h-full min-h-0 flex-col"
            : "flex h-screen flex-col bg-[var(--floor)]"
        }
      >
        {embedded ? (
          // header inside the card: title + close (back to the document
          // browser). The account menu lives in Home's sidebar, so it's not
          // repeated here.
          <header className="flex h-14 shrink-0 items-center gap-3 px-5">
            <h1 className="text-xl font-semibold tracking-tight">
              {t("common.settings")}
            </h1>
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto rounded-full"
              title={t("common.close")}
              aria-label={t("common.close")}
              onClick={close}
            >
              <X className="size-5" aria-hidden="true" />
            </Button>
          </header>
        ) : (
          // top bar: title · account · close
          <header className="flex h-16 shrink-0 items-center gap-3 px-5">
            <h1 className="text-xl font-semibold tracking-tight">
              {t("common.settings")}
            </h1>
            <div className="ml-auto flex items-center gap-2">
              <AccountMenu auth={auth} toast={showToast} onSignOut={() => void signOut()} />
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full"
                title={t("common.close")}
                aria-label={t("common.close")}
                onClick={close}
              >
                <X className="size-5" aria-hidden="true" />
              </Button>
            </div>
          </header>
        )}

        {/* mobile: the rail collapses to a single top tab strip */}
        <nav
          className="flex gap-1 overflow-x-auto px-4 pb-2 md:hidden"
          aria-label={t("common.settings")}
        >
          {nav.map((item) => (
            <NavButton key={item.section} item={item} rail={false} />
          ))}
        </nav>

        <div className="flex min-h-0 flex-1">
          {/* settings sub-sidebar: a small-caps header + neutral-gray icon rows */}
          <aside className="hidden w-64 shrink-0 overflow-y-auto overscroll-contain px-3 pb-6 pt-1 md:block">
            <nav className="flex flex-col gap-0.5" aria-label={t("common.settings")}>
              <p className="mb-1 truncate px-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("settings.group.account")}
              </p>
              {accountNav.map((item) => (
                <NavButton key={item.section} item={item} rail />
              ))}
              {workspaceNav.length > 0 ? (
                <>
                  <p className="mb-1 mt-5 truncate px-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t("settings.nav.workspace")}
                  </p>
                  {workspaceNav.map((item) => (
                    <NavButton key={item.section} item={item} rail />
                  ))}
                </>
              ) : null}
            </nav>
          </aside>

          <main className="min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-16 md:px-8">
            <div className="mx-auto w-full max-w-2xl">
              {section === "profile" ? (
                <ProfileSection auth={auth} toast={showToast} onUpdated={onUserUpdated} />
              ) : section === "preferences" ? (
                <PreferencesSection />
              ) : section === "language" ? (
                <LanguageSection />
              ) : section === "notifications" ? (
                <NotificationsSection auth={auth} toast={showToast} />
              ) : section === "api-keys" ? (
                <ApiKeysSection auth={auth} toast={showToast} />
              ) : section === "connections" ? (
                <ConnectionsSection auth={auth} toast={showToast} />
              ) : section === "shortcuts" ? (
                <ShortcutsSection />
              ) : section === "workspace" ? (
                showWorkspace && selectedWs && auth.user ? (
                  // One page per ALL workspace settings: the selector on top
                  // picks which workspace is being edited; the General and
                  // Members content stack below it as sections.
                  <>
                    <header className="mb-5">
                      <h2 className="text-lg font-semibold tracking-tight">
                        {t("settings.nav.workspace")}
                      </h2>
                    </header>
                    <div className="mb-8">
                      <label
                        className="mb-1.5 block text-sm font-medium"
                        htmlFor="settings-workspace-select"
                      >
                        {t("settings.conn.workspaceLabel")}
                      </label>
                      <NativeSelect
                        id="settings-workspace-select"
                        className="w-full max-w-md"
                        value={selectedWsId ?? ""}
                        onChange={(e) => selectWorkspace(e.currentTarget.value)}
                      >
                        {workspaces.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name}
                            {w.is_personal ? ` · ${t("ws.personalBadge")}` : ""}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                    <WorkspaceGeneralSection
                      user={auth.user}
                      workspace={selectedWs}
                      detail={wsDetail}
                      toast={showToast}
                      onChanged={() => void reloadWorkspace()}
                    />
                    <div className="mt-8">
                      <MembersSection
                        user={auth.user}
                        workspace={selectedWs}
                        detail={wsDetail}
                        toast={showToast}
                        onChanged={() => void reloadWorkspace()}
                      />
                    </div>
                  </>
                ) : null
              ) : (
                <AboutSection />
              )}
            </div>
          </main>
        </div>
      </div>

      {toast ? (
        <div className="pointer-events-none fixed bottom-4 right-4 z-50">
          <div
            className={cn(
              "pointer-events-auto rounded-xl bg-popover px-4 py-2 text-sm text-popover-foreground shadow-md ring-1",
              toastKind === "warning" ? "ring-amber-500/50" : "ring-surface-border",
            )}
            role="status"
          >
            {toast}
          </div>
        </div>
      ) : null}
    </>
  );
}

export default SettingsPage;
