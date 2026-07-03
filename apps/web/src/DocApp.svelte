<script lang="ts">
  import Search from "@lucide/svelte/icons/search";
  import AccountMenu from "./AccountMenu.svelte";
  import NotificationsBell from "./NotificationsBell.svelte";
  import Editor from "./Editor.svelte";
  import Sidebar from "./Sidebar.svelte";
  import Toolbar from "./Toolbar.svelte";
  import OutlineRail from "./OutlineRail.svelte";
  import WorkspacePanel from "./WorkspacePanel.svelte";
  import ErrorPage from "./ErrorPage.svelte";
  import NotFound from "./NotFound.svelte";
  import { relativeTime, authorName } from "./collabStore.svelte";
  import { classifyDocError, type ErrorKind } from "./errorKind";
  import { errMsg } from "./apiError";
  import { t } from "./i18n/index.svelte";
  import { renderMarkdown } from "@muesli/editor-core/render";
  import { fetchMe, httpBase, logout, me, setMeIdentity, type AuthInfo } from "./identity";
  import { gotoHome } from "./route.svelte";
  import { openSearchPalette, searchShortcutHint } from "./SearchPalette.svelte";
  import { openSession, provideDocSession, type Participant } from "./session.svelte";
  import { groupPresence, initials, splitForStack } from "./presence";
  import { createWorkspaceApi, WorkspaceApiError } from "./workspaceApi";
  import { onDestroy, onMount, tick } from "svelte";

  let { docId, shareToken }: { docId: string; shareToken: string | null } = $props();

  // One collab session per mounted DocApp; App.svelte keys this component on the
  // doc id, so switching docs destroys this session (ws closed) and opens a new
  // one — the props are immutable for this component's lifetime.
  // svelte-ignore state_referenced_locally
  const session = openSession(docId, shareToken);
  provideDocSession(session);
  const collab = session.store;
  onDestroy(() => session.destroy());

  const api = createWorkspaceApi({ httpBase });

  // Raw [clientId, user] awareness pairs; the grouped one-per-person roster is
  // derived below via groupPresence (deduped by userId, self excluded).
  let entries: Array<[number, Participant]> = $state([]);
  let connected = $state(session.provider.wsconnected);
  let auth: AuthInfo = $state({ mode: "open", user: null });
  // A failed document load (404 missing / 403 no-access / other) routes to a
  // friendly dedicated error page instead of surfacing the raw error (Commit 2).
  let docError: ErrorKind | null = $state(null);
  let shareRole: "viewer" | "commenter" | "editor" = $state("editor");
  let shareUrl = $state("");
  let shareError = $state("");
  let workspaceOpen = $state(false);

  // --- title (inline rename, §Header) ---------------------------------------
  let title = $state("");
  let editingTitle = $state(false);
  let titleDraft = $state("");
  let titleInput: HTMLInputElement | null = $state(null);
  const displayTitle = $derived(title.trim() || docId);
  const showSignInHint = $derived(auth.mode === "oidc" && !connected && !auth.user);

  onMount(() => {
    const onAwareness = () => (entries = session.participantEntries());
    const onStatus = ({ status }: { status: string }) => (connected = status === "connected");
    session.provider.awareness.on("change", onAwareness);
    session.provider.on("status", onStatus);
    onAwareness();
    connected = session.provider.wsconnected;
    fetchMe().then((a) => {
      auth = a;
      // Promote `me` to the authenticated identity (userId is the presence dedup
      // key; color re-derives from it; avatar rides along), then re-publish the
      // local awareness `user` so other clients collapse our tabs into one chip.
      if (a.user) {
        setMeIdentity(a.user);
        session.publishLocalUser();
      }
    });
    // A doc created from Home hands its title/folder here via sessionStorage
    // (the row is only minted on first ws connect, so Home can't PATCH it —
    // a timed retry from Home raced and lost; "synced" is the reliable moment).
    const pendingKey = `muesli:pending-place:${docId}`;
    const pendingRaw = sessionStorage.getItem(pendingKey);
    if (pendingRaw) {
      const onSynced = (synced: boolean) => {
        if (!synced) return;
        session.provider.off("sync", onSynced);
        try {
          const pending = JSON.parse(pendingRaw) as { title?: string; folder_id?: string };
          if (pending.title) title = pending.title;
          api
            .updateDocument(docId, pending)
            .then(() => sessionStorage.removeItem(pendingKey))
            .catch(() => {}); // next Home visit shows the slug; rename recovers
        } catch {
          sessionStorage.removeItem(pendingKey);
        }
      };
      session.provider.on("sync", onSynced);
      if (session.provider.synced) onSynced(true);
    }
    // stored display title (fallback: the slug shown until the list answers)
    api
      .listDocuments()
      .then(({ documents }) => {
        const mine = documents.find((d) => d.slug === docId);
        if (mine?.title) title = mine.title;
      })
      .catch(() => {}); // signed out / open-mode quirks: the slug is fine

    // Existence / permission probe (Commit 2). A 404/403 on the canonical text
    // routes us to a friendly "doesn't exist" / "no access" page instead of a
    // blank editor or raw error. Skipped when:
    //   - a brand-new doc is being minted from Home (pending-place flag) — it
    //     doesn't exist via REST yet; the ws connect creates it.
    //   - a guest arrives with a share token — the REST text route is
    //     cookie-authed (no guest cookie), so the ws/collab layer is the
    //     authority for share access, not this probe.
    if (!pendingRaw && !shareToken) {
      api.getDocumentText(docId).catch((e) => {
        if (e instanceof WorkspaceApiError) docError = classifyDocError(e.status);
        // network/other: leave the editor to its own connection status UI
      });
    }
    const stopCollab = collab.start();
    return () => {
      session.provider.awareness.off("change", onAwareness);
      session.provider.off("status", onStatus);
      stopCollab();
    };
  });

  async function startTitleEdit() {
    titleDraft = title.trim() || "";
    editingTitle = true;
    await tick();
    titleInput?.focus();
    titleInput?.select();
  }

  async function commitTitle() {
    if (!editingTitle) return;
    editingTitle = false;
    const next = titleDraft.trim();
    if (next === title.trim()) return;
    try {
      const res = await api.updateDocument(docId, { title: next || null });
      title = res.title ?? "";
      collab.showToast(t("toast.renamed"));
    } catch (e) {
      if (e instanceof WorkspaceApiError && e.status === 401) {
        collab.showToast(t("common.signInToDo"));
      } else {
        collab.showToast(errMsg(e));
      }
    }
  }

  function cancelTitleEdit() {
    editingTitle = false;
    titleDraft = "";
  }

  // --- presence (§Header) -----------------------------------------------------
  // One indicator per *person*: dedup raw awareness entries by userId (guests by
  // clientId), exclude self, then split into ≤3 chips or 2 chips + ⊕N overflow.
  const localKey = $derived(me.userId ?? `guest:${session.localClientId}`);
  const roster = $derived(groupPresence(entries, localKey));
  const stack = $derived(splitForStack(roster));

  // ⊕N roster popover (lists everyone; closes on outside-click / Escape).
  let rosterOpen = $state(false);
  let rosterEl: HTMLDivElement | null = $state(null);
  function onRosterPointer(e: PointerEvent) {
    if (rosterOpen && rosterEl && !rosterEl.contains(e.target as Node)) rosterOpen = false;
  }
  function onRosterKey(e: KeyboardEvent) {
    if (e.key === "Escape" && rosterOpen) {
      e.preventDefault();
      rosterOpen = false;
    }
  }
  $effect(() => {
    if (!rosterOpen) return;
    window.addEventListener("pointerdown", onRosterPointer, true);
    window.addEventListener("keydown", onRosterKey, true);
    return () => {
      window.removeEventListener("pointerdown", onRosterPointer, true);
      window.removeEventListener("keydown", onRosterKey, true);
    };
  });

  const snapshotHtml = $derived(collab.snapshot ? renderMarkdown(collab.snapshot.text) : "");

  async function share() {
    shareError = "";
    try {
      const link = await session.createShareLink(shareRole);
      shareUrl = link.url;
      await navigator.clipboard.writeText(link.url).catch(() => {});
    } catch (e) {
      shareError = errMsg(e);
    }
  }

  async function signOut() {
    await logout();
    // The doc room's ws auth is gone with the cookie; go home, which unmounts
    // this component and destroys the session (and shows the sign-in screen).
    gotoHome();
  }
</script>

{#if docError === "doc-not-found"}
  <NotFound kind="doc" />
{:else if docError === "no-access"}
  <ErrorPage title={t("error.noAccessTitle")} message={t("error.noAccessBody")} action="home" />
{:else if docError === "generic"}
  <ErrorPage title={t("error.genericTitle")} message={t("error.genericBody")} action="home" />
{:else}
  <div class="flex h-screen flex-col bg-base-200">
    <header class="navbar min-h-0 border-b border-base-300 bg-base-100 px-4 py-2">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <button
          class="btn btn-ghost btn-sm gap-2 px-2"
          title={t("doc.allDocuments")}
          onclick={() => gotoHome()}
        >
          <!-- Wordmark matches the marketing site's nav: lowercase, Sentient, 1.4rem -->
          <span class="wordmark text-[1.4rem] leading-none">muesli</span>
        </button>
        <div class="flex min-w-0 items-baseline gap-2">
          {#if editingTitle}
            <input
              bind:this={titleInput}
              class="input input-sm w-64 text-base font-medium"
              placeholder={docId}
              bind:value={titleDraft}
              onblur={commitTitle}
              onkeydown={(e) => {
                if (e.key === "Enter") commitTitle();
                if (e.key === "Escape") {
                  e.preventDefault();
                  cancelTitleEdit();
                }
              }}
            />
          {:else}
            <button
              class="max-w-72 truncate rounded px-1.5 py-0.5 text-base font-medium hover:bg-base-200"
              title={t("modal.renameDocTitle")}
              onclick={startTitleEdit}
            >
              {displayTitle}
            </button>
          {/if}
        </div>
        <button
          class="btn btn-circle btn-ghost btn-sm"
          title={t("doc.searchTitle", { hint: searchShortcutHint })}
          onclick={() => openSearchPalette()}
        >
          <Search class="h-4 w-4" aria-hidden="true" />
        </button>
        <!-- Connected is the web's steady state — only the EXCEPTION gets a dot. -->
        {#if !connected}
          <div class="status status-error" title={t("doc.disconnected")}></div>
        {/if}
        {#if showSignInHint}
          <span class="text-xs opacity-60">{t("doc.signInToOpen")}</span>
        {:else if !connected}
          <span class="text-xs opacity-60">{t("doc.offline")}</span>
        {/if}
      </div>
      <div class="flex items-center gap-2">
        {#if roster.length > 0}
          <div class="relative flex items-center pl-1.5" bind:this={rosterEl}>
            {#each stack.visible as p (p.key)}
              <div class="tooltip tooltip-bottom -ml-1.5 first:ml-0" data-tip={p.name}>
                {#if p.avatar}
                  <img
                    class="presence-avatar h-7 w-7 rounded-full ring-2 ring-base-100"
                    src={p.avatar}
                    alt={p.name}
                    referrerpolicy="no-referrer"
                  />
                {:else}
                  <span
                    class="flex h-7 w-7 items-center justify-center rounded-full text-[0.65rem] font-semibold text-white ring-2 ring-base-100"
                    style:background-color={p.color}
                    aria-label={p.name}
                  >
                    {p.kind === "agent" ? "✦" : initials(p.name)}
                  </span>
                {/if}
              </div>
            {/each}
            {#if stack.overflow > 0}
              <button
                type="button"
                class="-ml-1.5 flex h-10 min-w-10 items-center justify-center rounded-full ring-2 ring-base-100 transition-transform active:scale-[0.96]"
                title={t("doc.presenceMore", { count: stack.overflow })}
                aria-haspopup="true"
                aria-expanded={rosterOpen}
                onclick={() => (rosterOpen = !rosterOpen)}
              >
                <span
                  class="flex h-7 min-w-7 items-center justify-center rounded-full bg-base-300 px-1 text-[0.65rem] font-semibold"
                >
                  ⊕{stack.overflow}
                </span>
              </button>
            {/if}
            {#if rosterOpen}
              <div
                class="absolute right-0 top-full z-20 mt-1.5 max-h-80 w-56 overflow-y-auto rounded-box border border-base-300 bg-base-100 p-2 shadow"
                role="menu"
              >
                <p class="px-1.5 pb-1 text-xs font-semibold opacity-60">
                  {t("doc.peopleHere")}
                </p>
                <ul class="flex flex-col gap-0.5">
                  {#each roster as p (p.key)}
                    <li class="flex items-center gap-2 rounded px-1.5 py-1">
                      {#if p.avatar}
                        <img
                          class="presence-avatar h-6 w-6 shrink-0 rounded-full"
                          src={p.avatar}
                          alt={p.name}
                          referrerpolicy="no-referrer"
                        />
                      {:else}
                        <span
                          class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[0.6rem] font-semibold text-white"
                          style:background-color={p.color}
                          aria-hidden="true"
                        >
                          {p.kind === "agent" ? "✦" : initials(p.name)}
                        </span>
                      {/if}
                      <span class="truncate text-sm">{p.name}</span>
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}
          </div>
        {/if}
        {#if auth.mode === "oidc" && auth.user}
          <NotificationsBell />
        {/if}
        {#if auth.mode === "oidc" && auth.user}
          <div class="dropdown dropdown-end">
            <div tabindex="0" role="button" class="btn btn-sm btn-primary ml-1">
              {t("common.share")}
            </div>
            <div
              class="dropdown-content z-10 mt-1 w-72 rounded-box border border-base-300 bg-base-100 p-3 shadow"
            >
              <div class="flex items-center gap-2">
                <select class="select select-sm flex-1" bind:value={shareRole}>
                  <option value="viewer">{t("common.shareRole.viewer")}</option>
                  <option value="commenter">{t("common.shareRole.commenter")}</option>
                  <option value="editor">{t("common.shareRole.editor")}</option>
                </select>
                <button class="btn btn-sm" onclick={share}>{t("common.createLink")}</button>
              </div>
              {#if shareUrl}
                <input
                  class="input input-sm mt-2 w-full font-mono text-xs"
                  readonly
                  value={shareUrl}
                  onfocus={(e) => e.currentTarget.select()}
                />
                <p class="mt-1 text-xs opacity-60">{t("common.copiedToClipboard")}</p>
              {/if}
              {#if shareError}
                <p class="mt-1 text-xs text-error">{shareError}</p>
              {/if}
            </div>
          </div>
        {/if}
        <AccountMenu
          {auth}
          toast={(m) => collab.showToast(m)}
          onsignout={signOut}
          onworkspace={() => (workspaceOpen = true)}
        />
      </div>
    </header>
    <Toolbar title={displayTitle} />
    <main class="flex min-h-0 flex-1 bg-base-200">
      <OutlineRail />
      <section class="doc-sheet min-h-0 min-w-0 flex-1">
        <Editor />
      </section>
      <Sidebar />
    </main>

    {#if workspaceOpen && auth.mode === "oidc" && auth.user}
      <WorkspacePanel
        user={auth.user}
        toast={(m) => collab.showToast(m)}
        onclose={() => (workspaceOpen = false)}
      />
    {/if}

    {#if collab.toast}
      <div class="toast toast-end z-50">
        <div class="alert alert-warning py-2 text-sm shadow">{collab.toast}</div>
      </div>
    {/if}

    {#if collab.snapshot}
      <div class="modal modal-open" role="dialog">
        <div class="modal-box flex max-h-[85vh] w-11/12 max-w-3xl flex-col">
          <div class="mb-2 flex items-center justify-between gap-2 border-b border-base-300 pb-2">
            <div class="text-sm">
              <span class="font-semibold">{t("doc.snapshot")}</span>
              <span class="opacity-60">
                · {t("doc.seq", { seq: collab.snapshot.seq })} · {authorName(
                  collab.snapshot.entry.author,
                )} ·
                {relativeTime(collab.snapshot.entry.created_at)}
              </span>
            </div>
            <button class="btn btn-primary btn-sm" onclick={() => collab.closeSnapshot()}>
              {t("doc.backToLive")}
            </button>
          </div>
          <div class="prose-muesli min-h-0 flex-1 overflow-y-auto">
            {@html snapshotHtml}
          </div>
        </div>
        <button
          class="modal-backdrop"
          aria-label={t("doc.backToLive")}
          onclick={() => collab.closeSnapshot()}
        ></button>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* A hairline outline keeps avatar photos from melting into the chrome on
     either theme (light vs. dark). Uses outline so it doesn't shift layout. */
  :global(.presence-avatar) {
    outline: 1px solid rgba(0, 0, 0, 0.1);
    outline-offset: -1px;
  }
  :global([data-theme="muesli-dark"] .presence-avatar) {
    outline-color: rgba(255, 255, 255, 0.1);
  }
</style>
