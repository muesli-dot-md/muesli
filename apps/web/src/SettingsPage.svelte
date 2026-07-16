<script lang="ts">
  // Full-page settings shell at #~settings/<section>, in the Multica layout: a
  // settings sub-sidebar with a small-caps "My Account" header over
  // neutral-gray icon rows, and a right card-based content column. The shell
  // owns auth, the toast, the OAuth-return notice, AND the workspace selection
  // for the single Workspace page (its selector + General/Members content all
  // read the same loaded list/detail). Each section is its own component under
  // settings/.
  import Bell from "@lucide/svelte/icons/bell";
  import Cable from "@lucide/svelte/icons/cable";
  import Info from "@lucide/svelte/icons/info";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import Settings from "@lucide/svelte/icons/settings";
  import Languages from "@lucide/svelte/icons/languages";
  import SlidersHorizontal from "@lucide/svelte/icons/sliders-horizontal";
  import User from "@lucide/svelte/icons/user";
  import X from "@lucide/svelte/icons/x";
  import { onMount } from "svelte";
  import AccountMenu from "./AccountMenu.svelte";
  import { t } from "./i18n/index.svelte";
  import { fetchMe, httpBase, logout, type AuthInfo, type Me } from "./identity";
  import { gotoHome, gotoSettings, type SettingsSection } from "./route.svelte";
  import AboutSection from "./settings/AboutSection.svelte";
  import ApiKeysSection from "./settings/ApiKeysSection.svelte";
  import ConnectionsSection from "./settings/ConnectionsSection.svelte";
  import MembersSection from "./settings/MembersSection.svelte";
  import NotificationsSection from "./settings/NotificationsSection.svelte";
  import LanguageSection from "./settings/LanguageSection.svelte";
  import PreferencesSection from "./settings/PreferencesSection.svelte";
  import ProfileSection from "./settings/ProfileSection.svelte";
  import {
    settingsNavItems,
    type SettingsIconKey,
    type SettingsNavItem,
  } from "./settings/settingsNav";
  import ShortcutsSection from "./settings/ShortcutsSection.svelte";
  import WorkspaceGeneralSection from "./settings/WorkspaceGeneralSection.svelte";
  import { createWorkspaceApi, type WorkspaceDetail, type WorkspaceSummary } from "./workspaceApi";

  let {
    section,
    embedded = false,
    onuserchanged,
  }: {
    section: SettingsSection;
    embedded?: boolean;
    /** Profile edits (display name / avatar) also flow up to the host so its
     *  own copy of the signed-in user — e.g. Home's sidebar chip — follows
     *  live instead of reverting to a stale fetch when settings closes. */
    onuserchanged?: (user: Me) => void;
  } = $props();

  let auth: AuthInfo = $state({ mode: "open", user: null });
  // True once the initial fetchMe + loadWorkspaces have settled. Until then
  // `showWorkspace` is false for the wrong reason (nothing has loaded yet),
  // so it must not drive navigation.
  let loaded = $state(false);

  const ICONS: Record<SettingsIconKey, typeof User> = {
    user: User,
    sliders: SlidersHorizontal,
    languages: Languages,
    bell: Bell,
    keyRound: KeyRound,
    cable: Cable,
    info: Info,
    settings: Settings,
  };

  // --- shared workspace context (the Workspace page's selector + content) --------
  const wsApi = createWorkspaceApi({ httpBase });
  let workspaces: WorkspaceSummary[] = $state([]);
  let selectedWsId: string | null = $state(null);
  let wsDetail: WorkspaceDetail | null = $state(null);
  const selectedWs = $derived(workspaces.find((w) => w.id === selectedWsId) ?? null);
  // The workspace page needs a real, signed-in workspace to act on.
  const showWorkspace = $derived(auth.mode === "oidc" && !!auth.user && workspaces.length > 0);

  async function loadWorkspaces() {
    if (auth.mode !== "oidc" || !auth.user) return;
    try {
      workspaces = (await wsApi.listWorkspaces()).workspaces;
      if (!workspaces.some((w) => w.id === selectedWsId)) selectedWsId = workspaces[0]?.id ?? null;
      if (selectedWsId) await loadWsDetail(selectedWsId);
    } catch {
      // Open mode (503) / signed out (401): the workspace page just stays hidden.
      workspaces = [];
      selectedWsId = null;
      wsDetail = null;
    }
  }

  async function loadWsDetail(id: string) {
    try {
      const detail = await wsApi.getWorkspace(id);
      // A slow response for a workspace the user has already switched away
      // from must not clobber the newer selection's detail.
      if (selectedWsId !== id) return;
      wsDetail = detail;
    } catch {
      if (selectedWsId !== id) return;
      wsDetail = null;
    }
  }

  function selectWorkspace(id: string) {
    if (id === selectedWsId) return;
    selectedWsId = id;
    wsDetail = null;
    void loadWsDetail(id);
  }

  async function reloadWorkspace() {
    // After a rename/leave/member change: refresh the list (name/membership may
    // have changed) and re-pin the selection, then reload detail. Leaving or
    // deleting the selected workspace falls back to the first (personal) one
    // via loadWorkspaces' re-pin — the page itself stays valid.
    await loadWorkspaces();
  }

  let toast = $state("");
  let toastKind: "info" | "warning" = $state("info");
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function showToast(msg: string, kind: "info" | "warning" = "info") {
    toast = msg;
    toastKind = kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ""), 4000);
  }

  // One flat list drives both the sidebar rail and the mobile tab strip. The
  // rail additionally splits it into two visual groups — the account pages
  // under the "My Account" header, the workspace item under its own small-caps
  // header — matching the old two-group rhythm without resurrecting the group
  // machinery. The mobile strip stays one flat row (it has no headers).
  const nav = $derived(settingsNavItems(showWorkspace));
  const accountNav = $derived(nav.filter((i) => i.section !== "workspace"));
  const workspaceNav = $derived(nav.filter((i) => i.section === "workspace"));

  // If the route points at the workspace page but none is available (open
  // mode / signed out), bounce to Profile so we never render an empty pane.
  // Gated on `loaded`: on a fresh mount at #~settings/workspace (or an aliased
  // #general/#members deep link) this effect fires before fetchMe/
  // loadWorkspaces resolve, and bouncing then would permanently kick
  // signed-in users off their deep link.
  $effect(() => {
    if (loaded && !showWorkspace && section === "workspace") gotoSettings("profile");
  });

  function close() {
    if (history.length > 1) history.back();
    else gotoHome();
  }

  async function signOut() {
    // true = the browser is off to the IdP's end_session URL (RP-initiated logout).
    if (await logout()) return;
    auth = { ...auth, user: null };
    workspaces = [];
    selectedWsId = null;
    wsDetail = null;
  }

  onMount(() => {
    // fetchMe never rejects (it falls back to open mode), and loadWorkspaces
    // catches internally — but `loaded` landing must not depend on that prose
    // invariant: the finally makes the bounce guard structurally unable to
    // wedge shut.
    fetchMe()
      .then(async (a) => {
        auth = a;
        await loadWorkspaces();
      })
      .finally(() => (loaded = true));
    // Google Drive OAuth return: gdrive::callback redirects to
    // {web_origin}/?storage=connected|error#~settings/connections.
    const params = new URLSearchParams(location.search);
    const storage = params.get("storage");
    if (storage) {
      params.delete("storage");
      const qs = params.toString();
      history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
      if (storage === "connected") showToast(t("settings.conn.driveConnected"));
      else showToast(t("settings.conn.driveError"), "warning");
    }
  });
</script>

{#snippet navItem(item: SettingsNavItem, rail: boolean)}
  {@const Icon = ICONS[item.icon]}
  <button
    class="arc-tap flex min-h-10 items-center gap-2.5 rounded-field text-sm {rail
      ? 'w-full px-3 py-2 text-left'
      : 'shrink-0 whitespace-nowrap px-3 py-2'} {section === item.section
      ? 'font-medium text-base-content'
      : 'text-[var(--text-muted)] hover:bg-[var(--row-hover)] hover:text-base-content'}"
    style={section === item.section
      ? "background: var(--lift); box-shadow: var(--shadow-lift);"
      : ""}
    aria-current={section === item.section ? "page" : undefined}
    onclick={() => gotoSettings(item.section)}
  >
    <Icon class="h-4 w-4 {section === item.section ? '' : 'opacity-70'}" aria-hidden="true" />
    {t(item.labelKey)}
  </button>
{/snippet}

<!-- Embedded (inside Home's main panel): fill the card, no screen-height shell,
     no top bar — Home owns the chrome (workspaces sidebar + account menu).
     Standalone: the full-page shell with its own header. -->
<div class={embedded ? "flex h-full min-h-0 flex-col" : "flex h-screen flex-col bg-[var(--floor)]"}>
  {#if embedded}
    <!-- header inside the card: title + close (back to the document browser). The
         account menu lives in Home's sidebar, so it's not repeated here. -->
    <header class="flex h-14 shrink-0 items-center gap-3 px-5">
      <h1 class="text-xl font-semibold tracking-tight">{t("common.settings")}</h1>
      <button
        class="btn btn-circle btn-ghost ml-auto h-10 w-10 p-0"
        title={t("common.close")}
        aria-label={t("common.close")}
        onclick={close}
      >
        <X class="h-5 w-5" aria-hidden="true" />
      </button>
    </header>
  {:else}
    <!-- top bar: title · account · close (controls 40px, header 64px — DESIGN.md) -->
    <header class="flex h-16 shrink-0 items-center gap-3 px-5">
      <h1 class="text-xl font-semibold tracking-tight">{t("common.settings")}</h1>
      <div class="ml-auto flex items-center gap-2">
        <AccountMenu {auth} toast={showToast} onsignout={signOut} />
        <button
          class="btn btn-circle btn-ghost h-10 w-10 p-0"
          title={t("common.close")}
          aria-label={t("common.close")}
          onclick={close}
        >
          <X class="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    </header>
  {/if}

  <!-- mobile: the rail collapses to a single top tab strip -->
  <nav class="flex gap-1 overflow-x-auto px-4 pb-2 md:hidden" aria-label={t("common.settings")}>
    {#each nav as item (item.section)}
      {@render navItem(item, false)}
    {/each}
  </nav>

  <div class="flex min-h-0 flex-1">
    <!-- settings sub-sidebar: a small-caps header + neutral-gray icon rows -->
    <aside class="hidden w-64 shrink-0 overflow-y-auto px-3 pt-1 pb-6 md:block">
      <nav class="flex flex-col gap-0.5" aria-label={t("common.settings")}>
        <p
          class="mb-1 truncate px-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]"
        >
          {t("settings.group.account")}
        </p>
        {#each accountNav as item (item.section)}
          {@render navItem(item, true)}
        {/each}
        {#if workspaceNav.length > 0}
          <p
            class="mb-1 mt-5 truncate px-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]"
          >
            {t("settings.nav.workspace")}
          </p>
          {#each workspaceNav as item (item.section)}
            {@render navItem(item, true)}
          {/each}
        {/if}
      </nav>
    </aside>

    <main class="min-w-0 flex-1 overflow-y-auto px-4 pb-16 md:px-8">
      <div class="mx-auto w-full max-w-2xl">
        {#if section === "profile"}
          <ProfileSection
            {auth}
            toast={showToast}
            onupdated={(user) => {
              auth = { ...auth, user };
              onuserchanged?.(user);
            }}
          />
        {:else if section === "preferences"}
          <PreferencesSection />
        {:else if section === "language"}
          <LanguageSection />
        {:else if section === "notifications"}
          <NotificationsSection {auth} toast={showToast} />
        {:else if section === "api-keys"}
          <ApiKeysSection {auth} toast={showToast} />
        {:else if section === "connections"}
          <ConnectionsSection {auth} toast={showToast} />
        {:else if section === "shortcuts"}
          <ShortcutsSection />
        {:else if section === "workspace"}
          {#if showWorkspace && selectedWs && auth.user}
            <!-- One page per ALL workspace settings: the selector on top picks
                 which workspace is being edited; the General and Members
                 content stack below it as sections. -->
            <header class="mb-5">
              <h2 class="text-lg font-semibold tracking-tight">{t("settings.nav.workspace")}</h2>
            </header>
            <div class="mb-8">
              <label class="mb-1.5 block text-sm font-medium" for="settings-workspace-select">
                {t("settings.conn.workspaceLabel")}
              </label>
              <select
                id="settings-workspace-select"
                class="select select-sm w-full max-w-md"
                value={selectedWsId}
                onchange={(e) => selectWorkspace(e.currentTarget.value)}
              >
                {#each workspaces as w (w.id)}
                  <option value={w.id}
                    >{w.name}{w.is_personal ? ` · ${t("ws.personalBadge")}` : ""}</option
                  >
                {/each}
              </select>
            </div>
            <WorkspaceGeneralSection
              user={auth.user}
              workspace={selectedWs}
              detail={wsDetail}
              toast={showToast}
              onchanged={reloadWorkspace}
            />
            <div class="mt-8">
              <MembersSection
                user={auth.user}
                workspace={selectedWs}
                detail={wsDetail}
                toast={showToast}
                onchanged={reloadWorkspace}
              />
            </div>
          {/if}
        {:else}
          <AboutSection />
        {/if}
      </div>
    </main>
  </div>
</div>

{#if toast}
  <div class="toast toast-end z-50">
    <div
      class="alert py-2 text-sm shadow {toastKind === 'warning' ? 'alert-warning' : 'alert-info'}"
    >
      {toast}
    </div>
  </div>
{/if}
