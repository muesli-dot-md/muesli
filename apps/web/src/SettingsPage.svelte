<script lang="ts">
  // Full-page settings shell at #~settings/<section>, redesigned to the Multica
  // two-level layout: a settings sub-sidebar with small-caps GROUP headers
  // ("My Account" + the active workspace name) over neutral-gray icon rows, and
  // a right card-based content column. The shell owns auth, the toast, the
  // OAuth-return notice, AND the shared workspace selection (the workspace group
  // + its General/Members pages all read the same loaded list/detail). Each
  // section is its own component under settings/.
  import Bell from "@lucide/svelte/icons/bell";
  import Cable from "@lucide/svelte/icons/cable";
  import Info from "@lucide/svelte/icons/info";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import Settings from "@lucide/svelte/icons/settings";
  import SlidersHorizontal from "@lucide/svelte/icons/sliders-horizontal";
  import User from "@lucide/svelte/icons/user";
  import Users from "@lucide/svelte/icons/users";
  import X from "@lucide/svelte/icons/x";
  import { onMount } from "svelte";
  import AccountMenu from "./AccountMenu.svelte";
  import { t } from "./i18n/index.svelte";
  import { fetchMe, httpBase, logout, type AuthInfo } from "./identity";
  import { gotoHome, gotoSettings, type SettingsSection } from "./route.svelte";
  import AboutSection from "./settings/AboutSection.svelte";
  import ApiKeysSection from "./settings/ApiKeysSection.svelte";
  import ConnectionsSection from "./settings/ConnectionsSection.svelte";
  import MembersSection from "./settings/MembersSection.svelte";
  import NotificationsSection from "./settings/NotificationsSection.svelte";
  import PreferencesSection from "./settings/PreferencesSection.svelte";
  import ProfileSection from "./settings/ProfileSection.svelte";
  import {
    groupForSection,
    settingsNavGroups,
    settingsNavItems,
    type SettingsIconKey,
    type SettingsNavItem,
  } from "./settings/settingsNav";
  import ShortcutsSection from "./settings/ShortcutsSection.svelte";
  import WorkspaceGeneralSection from "./settings/WorkspaceGeneralSection.svelte";
  import { createWorkspaceApi, type WorkspaceDetail, type WorkspaceSummary } from "./workspaceApi";

  let { section, embedded = false }: { section: SettingsSection; embedded?: boolean } = $props();

  let auth: AuthInfo = $state({ mode: "open", user: null });

  const ICONS: Record<SettingsIconKey, typeof User> = {
    user: User,
    sliders: SlidersHorizontal,
    bell: Bell,
    keyRound: KeyRound,
    cable: Cable,
    info: Info,
    settings: Settings,
    users: Users,
  };

  // --- shared workspace context (the workspace group + General/Members) ---------
  const wsApi = createWorkspaceApi({ httpBase });
  let workspaces: WorkspaceSummary[] = $state([]);
  let selectedWsId: string | null = $state(null);
  let wsDetail: WorkspaceDetail | null = $state(null);
  const selectedWs = $derived(workspaces.find((w) => w.id === selectedWsId) ?? null);
  // The workspace group needs a real, signed-in workspace to act on.
  const showWorkspace = $derived(auth.mode === "oidc" && !!auth.user && workspaces.length > 0);

  async function loadWorkspaces() {
    if (auth.mode !== "oidc" || !auth.user) return;
    try {
      workspaces = (await wsApi.listWorkspaces()).workspaces;
      if (!workspaces.some((w) => w.id === selectedWsId)) selectedWsId = workspaces[0]?.id ?? null;
      if (selectedWsId) await loadWsDetail(selectedWsId);
    } catch {
      // Open mode (503) / signed out (401): the workspace group just stays hidden.
      workspaces = [];
      selectedWsId = null;
      wsDetail = null;
    }
  }

  async function loadWsDetail(id: string) {
    try {
      wsDetail = await wsApi.getWorkspace(id);
    } catch {
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
    // have changed) and re-pin the selection, then reload detail.
    const prev = selectedWsId;
    await loadWorkspaces();
    if (prev && !workspaces.some((w) => w.id === prev)) {
      // We left the selected workspace — fall back to the first (personal) one.
      if (section === "general" || section === "members") gotoSettings("general");
    }
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

  // Flat list for the mobile tab strip (groups collapse there).
  const flatNav = $derived(settingsNavItems(showWorkspace));
  const groups = $derived(settingsNavGroups(showWorkspace));

  // If the route points at a workspace page but the group isn't available
  // (open mode / signed out), bounce to Profile so we never render an empty pane.
  $effect(() => {
    if (!showWorkspace && groupForSection(section) === "workspace") gotoSettings("profile");
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
    fetchMe().then((a) => {
      auth = a;
      void loadWorkspaces();
    });
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

  /** The header text for a group: static for "My Account", the live workspace
   *  name for the workspace group (Multica shows the workspace name there). */
  function groupHeader(id: "account" | "workspace"): string {
    if (id === "workspace") return selectedWs?.name ?? t("settings.group.workspace");
    return t("settings.group.account");
  }
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

  <!-- mobile: groups collapse to a single top tab strip -->
  <nav class="flex gap-1 overflow-x-auto px-4 pb-2 md:hidden" aria-label={t("common.settings")}>
    {#each flatNav as item (item.section)}
      {@render navItem(item, false)}
    {/each}
  </nav>

  <div class="flex min-h-0 flex-1">
    <!-- settings sub-sidebar: small-caps group headers + neutral-gray icon rows -->
    <aside class="hidden w-64 shrink-0 overflow-y-auto px-3 pt-1 pb-6 md:block">
      <nav class="flex flex-col gap-5" aria-label={t("common.settings")}>
        {#each groups as group (group.id)}
          <div class="flex flex-col gap-0.5">
            <p
              class="mb-1 truncate px-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]"
            >
              {groupHeader(group.id)}
            </p>
            <!-- workspace switcher (only when the user has more than one) -->
            {#if group.id === "workspace" && workspaces.length > 1}
              <select
                class="select select-xs mx-1 mb-1 w-[calc(100%-0.5rem)]"
                value={selectedWsId}
                onchange={(e) => selectWorkspace(e.currentTarget.value)}
                aria-label={t("settings.conn.workspaceLabel")}
              >
                {#each workspaces as w (w.id)}
                  <option value={w.id}
                    >{w.name}{w.is_personal ? ` · ${t("ws.personalBadge")}` : ""}</option
                  >
                {/each}
              </select>
            {/if}
            {#each group.items as item (item.section)}
              {@render navItem(item, true)}
            {/each}
          </div>
        {/each}
      </nav>
    </aside>

    <main class="min-w-0 flex-1 overflow-y-auto px-4 pb-16 md:px-8">
      <div class="mx-auto w-full max-w-2xl">
        {#if section === "profile"}
          <ProfileSection
            {auth}
            toast={showToast}
            onupdated={(user) => (auth = { ...auth, user })}
          />
        {:else if section === "preferences"}
          <PreferencesSection />
        {:else if section === "notifications"}
          <NotificationsSection {auth} toast={showToast} />
        {:else if section === "api-keys"}
          <ApiKeysSection {auth} toast={showToast} />
        {:else if section === "connections"}
          <ConnectionsSection {auth} toast={showToast} />
        {:else if section === "shortcuts"}
          <ShortcutsSection />
        {:else if section === "general"}
          {#if showWorkspace && selectedWs && auth.user}
            <WorkspaceGeneralSection
              user={auth.user}
              workspace={selectedWs}
              detail={wsDetail}
              toast={showToast}
              onchanged={reloadWorkspace}
            />
          {/if}
        {:else if section === "members"}
          {#if showWorkspace && selectedWs && auth.user}
            <MembersSection
              user={auth.user}
              workspace={selectedWs}
              detail={wsDetail}
              toast={showToast}
              onchanged={reloadWorkspace}
            />
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
