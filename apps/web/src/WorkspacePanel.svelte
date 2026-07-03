<script lang="ts">
  // identity.ts/time.ts, not collab.ts: the home screen opens this panel too and
  // must not pull in yjs / open a doc room as a side effect.
  import Pencil from "@lucide/svelte/icons/pencil";
  import X from "@lucide/svelte/icons/x";
  import { errMsg } from "./apiError";
  import { t } from "./i18n/index.svelte";
  import { httpBase, type Me } from "./identity";
  import { relativeTime } from "./time";
  import {
    createWorkspaceApi,
    WorkspaceApiError,
    type AuditEntry,
    type WorkspaceDetail,
    type WorkspaceMember,
    type WorkspaceRole,
    type WorkspaceSummary,
  } from "./workspaceApi";

  let {
    user,
    onclose,
    toast = () => {},
  }: { user: Me; onclose: () => void; toast?: (msg: string) => void } = $props();

  const api = createWorkspaceApi({ httpBase });

  let workspaces: WorkspaceSummary[] = $state([]);
  let activeId: string | null = $state(null);
  let detail = $state<WorkspaceDetail | null>(null);
  let listLoading = $state(true);
  let detailLoading = $state(false);
  let unavailable = $state(""); // open mode (503) / signed out (401)

  let renaming = $state(false);
  let renameDraft = $state("");
  let inviteEmail = $state("");
  let inviteRole: WorkspaceRole = $state("member");
  let inviteBusy = $state(false);
  let busyMember: string | null = $state(null); // user_id of the row being mutated
  let busyInvite: string | null = $state(null);

  // Audit log (admins only, Phase 5): newest-first, paged by the last entry's id.
  const AUDIT_PAGE = 25;
  let auditEntries: AuditEntry[] = $state([]);
  let auditBusy = $state(false);
  let auditDone = $state(false);

  const activeSummary = $derived(workspaces.find((w) => w.id === activeId) ?? null);
  const isAdmin = $derived(detail?.role === "admin");
  const adminCount = $derived(detail?.members.filter((m) => m.role === "admin").length ?? 0);

  $effect(() => {
    void loadList();
  });

  async function loadList() {
    listLoading = true;
    try {
      workspaces = (await api.listWorkspaces()).workspaces;
      if (!activeId || !workspaces.some((w) => w.id === activeId)) {
        activeId = workspaces[0]?.id ?? null; // personal comes first
      }
      if (activeId) await loadDetail(activeId);
    } catch (e) {
      if (e instanceof WorkspaceApiError && e.status === 503) {
        unavailable = t("ws.unavailableOpenMode");
      } else if (e instanceof WorkspaceApiError && e.status === 401) {
        unavailable = t("ws.signInToManage");
      } else {
        fail(e);
      }
    } finally {
      listLoading = false;
    }
  }

  async function loadDetail(id: string) {
    detailLoading = true;
    try {
      detail = await api.getWorkspace(id);
      if (detail.role === "admin") {
        void loadAudit(true);
      } else {
        auditEntries = [];
        auditDone = false;
      }
    } catch (e) {
      fail(e);
    } finally {
      detailLoading = false;
    }
  }

  async function loadAudit(reset: boolean) {
    if (!detail || detail.role !== "admin") return;
    auditBusy = true;
    try {
      const beforeId = reset ? undefined : auditEntries[auditEntries.length - 1]?.id;
      const { entries } = await api.getAudit(detail.id, { limit: AUDIT_PAGE, beforeId });
      auditEntries = reset ? entries : [...auditEntries, ...entries];
      auditDone = entries.length < AUDIT_PAGE;
    } catch (e) {
      fail(e);
    } finally {
      auditBusy = false;
    }
  }

  /** "share_link_created" → "share link created" for the audit table. */
  function actionLabel(action: string): string {
    return action.replaceAll("_", " ");
  }

  function auditActorName(e: AuditEntry): string {
    return e.actor?.display_name ?? e.actor_label ?? (e.actor ? e.actor.id.slice(0, 8) : "—");
  }

  function select(id: string) {
    if (id === activeId) return;
    activeId = id;
    renaming = false;
    void loadDetail(id);
  }

  function fail(e: unknown) {
    if (e instanceof WorkspaceApiError && e.status === 409) {
      toast(t("ws.adminNeeded"));
    } else if (e instanceof WorkspaceApiError && e.status === 403) {
      toast(t("ws.notAllowed"));
    } else if (e instanceof WorkspaceApiError && e.status === 401) {
      toast(t("common.signInToDo"));
    } else {
      toast(errMsg(e));
    }
  }

  async function saveRename() {
    if (!detail || !renameDraft.trim() || renameDraft.trim() === detail.name) {
      renaming = false;
      return;
    }
    try {
      await api.renameWorkspace(detail.id, renameDraft.trim());
      renaming = false;
      await Promise.all([loadDetail(detail.id), refreshList()]);
    } catch (e) {
      fail(e);
    }
  }

  async function refreshList() {
    try {
      workspaces = (await api.listWorkspaces()).workspaces;
    } catch {
      // list refresh is cosmetic here; detail errors are surfaced elsewhere
    }
  }

  async function setRole(m: WorkspaceMember, role: WorkspaceRole) {
    if (!detail || role === m.role) return;
    busyMember = m.user_id;
    try {
      await api.setMemberRole(detail.id, m.user_id, role);
      await loadDetail(detail.id);
    } catch (e) {
      fail(e);
      await loadDetail(detail.id); // reset the select to the server's truth
    } finally {
      busyMember = null;
    }
  }

  async function removeMember(m: WorkspaceMember) {
    if (!detail) return;
    const self = m.user_id === user.id;
    const prompt = self
      ? t("confirm.leaveWorkspace", { name: detail.name })
      : t("confirm.removeMember", {
          member: m.display_name ?? m.email ?? t("ws.thisMember"),
          name: detail.name,
        });
    if (!confirm(prompt)) return;
    busyMember = m.user_id;
    try {
      await api.removeMember(detail.id, m.user_id);
      if (self) {
        detail = null;
        activeId = null;
        await loadList(); // back to the personal workspace
      } else {
        await loadDetail(detail.id);
      }
    } catch (e) {
      fail(e);
    } finally {
      busyMember = null;
    }
  }

  async function sendInvite() {
    if (!detail || !inviteEmail.trim()) return;
    inviteBusy = true;
    try {
      const res = await api.createInvite(detail.id, inviteEmail.trim(), inviteRole);
      if (res.status === "added") {
        toast(t("ws.added", { email: inviteEmail.trim() }));
      } else {
        toast(t("ws.inviteClaim"));
      }
      inviteEmail = "";
      await loadDetail(detail.id);
    } catch (e) {
      fail(e);
    } finally {
      inviteBusy = false;
    }
  }

  async function revokeInvite(inviteId: string) {
    if (!detail) return;
    busyInvite = inviteId;
    try {
      await api.revokeInvite(detail.id, inviteId);
      await loadDetail(detail.id);
    } catch (e) {
      fail(e);
    } finally {
      busyInvite = null;
    }
  }

  function initial(m: WorkspaceMember): string {
    return (m.display_name ?? m.email ?? "?").trim().charAt(0).toUpperCase() || "?";
  }

  /** Disable the role select for yourself when you're the only admin (409 anyway). */
  function roleLocked(m: WorkspaceMember): boolean {
    return m.user_id === user.id && m.role === "admin" && adminCount === 1;
  }
</script>

<div class="modal modal-open" role="dialog">
  <div class="modal-box flex max-h-[85vh] w-11/12 max-w-2xl flex-col">
    <div class="mb-3 flex items-center justify-between border-b border-base-300 pb-2">
      <h2 class="text-base font-semibold">{t("ws.title")}</h2>
      <button class="btn btn-ghost btn-sm" title={t("common.close")} onclick={onclose}>
        <X class="h-4 w-4" aria-hidden="true" />
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if unavailable}
        <p class="py-6 text-center text-sm opacity-60">{unavailable}</p>
      {:else if listLoading && !detail}
        <div class="flex flex-col gap-3">
          <div class="skeleton h-8 w-1/2"></div>
          <div class="skeleton h-24 w-full"></div>
          <div class="skeleton h-16 w-full"></div>
        </div>
      {:else}
        {#if workspaces.length > 1}
          <div role="tablist" class="tabs tabs-border tabs-sm mb-3">
            {#each workspaces as w (w.id)}
              <button
                role="tab"
                class="tab gap-1 {w.id === activeId ? 'tab-active' : ''}"
                onclick={() => select(w.id)}
              >
                {w.name}
                {#if w.is_personal}<span class="opacity-50">·</span>{/if}
              </button>
            {/each}
          </div>
        {/if}

        {#if detailLoading && !detail}
          <div class="skeleton h-40 w-full"></div>
        {:else if detail}
          <!-- name + badges -->
          <div class="mb-4 flex flex-wrap items-center gap-2">
            {#if renaming}
              <form
                class="flex items-center gap-2"
                onsubmit={(e) => {
                  e.preventDefault();
                  void saveRename();
                }}
              >
                <!-- svelte-ignore a11y_autofocus -->
                <input class="input input-sm" bind:value={renameDraft} autofocus />
                <button class="btn btn-sm btn-primary" type="submit">{t("common.save")}</button>
                <button
                  class="btn btn-ghost btn-sm"
                  type="button"
                  onclick={() => (renaming = false)}
                >
                  {t("common.cancel")}
                </button>
              </form>
            {:else}
              <span class="text-lg font-semibold">{detail.name}</span>
              {#if isAdmin}
                <button
                  class="btn btn-ghost btn-xs"
                  title={t("ws.renameWorkspace")}
                  onclick={() => {
                    renameDraft = detail?.name ?? "";
                    renaming = true;
                  }}
                >
                  <Pencil class="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              {/if}
            {/if}
            <span class="badge badge-sm {isAdmin ? 'badge-primary' : 'badge-ghost'}">
              {detail.role}
            </span>
            {#if activeSummary?.is_personal}
              <span class="badge badge-ghost badge-sm">{t("ws.personalBadge")}</span>
            {/if}
            {#if detailLoading}
              <span class="loading loading-spinner loading-xs opacity-50"></span>
            {/if}
          </div>

          <!-- members -->
          <h3 class="mb-1 text-sm font-semibold opacity-70">{t("ws.members")}</h3>
          <table class="table table-sm mb-4">
            <tbody>
              {#each detail.members as m (m.user_id)}
                <tr>
                  <td class="w-10">
                    <div class="avatar avatar-placeholder">
                      <div class="w-7 rounded-full bg-neutral text-neutral-content">
                        <span class="text-xs">{initial(m)}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div class="flex items-center gap-1.5">
                      <span class="font-medium">{m.display_name ?? m.email ?? m.user_id}</span>
                      {#if m.user_id === user.id}
                        <span class="badge badge-ghost badge-xs">{t("ws.youBadge")}</span>
                      {/if}
                      {#if m.kind === "agent"}
                        <span
                          class="badge badge-secondary badge-xs gap-0.5"
                          title={t("ws.delegatedAgentIdentity")}
                        >
                          {t("ws.agentBadge")}
                        </span>
                      {/if}
                    </div>
                    {#if m.email}
                      <div class="text-xs opacity-50">{m.email}</div>
                    {/if}
                  </td>
                  <td class="w-28">
                    {#if isAdmin}
                      <select
                        class="select select-xs"
                        value={m.role}
                        disabled={roleLocked(m) || busyMember === m.user_id}
                        title={roleLocked(m) ? t("ws.adminNeeded") : ""}
                        onchange={(e) => void setRole(m, e.currentTarget.value as WorkspaceRole)}
                      >
                        <option value="admin">{t("ws.roleAdmin")}</option>
                        <option value="member">{t("ws.roleMember")}</option>
                      </select>
                    {:else}
                      <span class="badge badge-ghost badge-sm">{m.role}</span>
                    {/if}
                  </td>
                  <td class="w-16 text-right">
                    {#if busyMember === m.user_id}
                      <span class="loading loading-spinner loading-xs"></span>
                    {:else if m.user_id === user.id}
                      {#if !activeSummary?.is_personal}
                        <button
                          class="btn btn-ghost btn-xs text-error"
                          onclick={() => void removeMember(m)}
                        >
                          {t("ws.leave")}
                        </button>
                      {/if}
                    {:else if isAdmin}
                      <button
                        class="btn btn-ghost btn-xs text-error"
                        title={t("ws.removeFromWorkspace")}
                        onclick={() => void removeMember(m)}
                      >
                        {t("ws.remove")}
                      </button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>

          <!-- invites (admins only — the server omits the list otherwise) -->
          {#if isAdmin && detail.invites}
            <h3 class="mb-1 text-sm font-semibold opacity-70">{t("ws.invites")}</h3>
            {#if detail.invites.length > 0}
              <ul class="mb-2 flex flex-col gap-1">
                {#each detail.invites as inv (inv.id)}
                  <li class="flex items-center gap-2 rounded-box bg-base-200 px-3 py-1.5 text-sm">
                    <span class="flex-1 truncate">{inv.email}</span>
                    <span class="badge badge-ghost badge-xs">{inv.role}</span>
                    <span class="text-xs opacity-50">{relativeTime(inv.created_at)}</span>
                    {#if busyInvite === inv.id}
                      <span class="loading loading-spinner loading-xs"></span>
                    {:else}
                      <button
                        class="btn btn-ghost btn-xs text-error"
                        onclick={() => void revokeInvite(inv.id)}
                      >
                        {t("ws.revoke")}
                      </button>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
            <form
              class="mb-4 flex items-center gap-2"
              onsubmit={(e) => {
                e.preventDefault();
                void sendInvite();
              }}
            >
              <input
                class="input input-sm flex-1"
                type="email"
                placeholder={t("ws.emailPlaceholder")}
                bind:value={inviteEmail}
                required
              />
              <select class="select select-sm w-28" bind:value={inviteRole}>
                <option value="member">{t("ws.roleMember")}</option>
                <option value="admin">{t("ws.roleAdmin")}</option>
              </select>
              <button class="btn btn-sm btn-primary" type="submit" disabled={inviteBusy}>
                {#if inviteBusy}
                  <span class="loading loading-spinner loading-xs"></span>
                {/if}
                {t("ws.invite")}
              </button>
            </form>
          {/if}

          <!-- audit log (admins only; the server 403s everyone else) -->
          {#if isAdmin}
            <h3 class="mb-1 text-sm font-semibold opacity-70">{t("ws.audit")}</h3>
            {#if auditEntries.length === 0 && !auditBusy}
              <p class="mb-4 text-xs opacity-50">{t("ws.noAudit")}</p>
            {:else}
              <table class="table table-xs mb-1">
                <thead>
                  <tr>
                    <th>{t("ws.colAction")}</th>
                    <th>{t("ws.colActor")}</th>
                    <th class="text-right">{t("ws.colWhen")}</th>
                  </tr>
                </thead>
                <tbody>
                  {#each auditEntries as e (e.id)}
                    <tr>
                      <td>
                        <span class="badge badge-ghost badge-xs font-mono"
                          >{actionLabel(e.action)}</span
                        >
                      </td>
                      <td>
                        <span class="flex items-center gap-1">
                          {auditActorName(e)}
                          {#if e.actor?.kind === "agent"}
                            <span
                              class="badge badge-secondary badge-xs"
                              title={t("ws.agentIdentity")}>🤖</span
                            >
                          {/if}
                        </span>
                      </td>
                      <td class="text-right text-xs opacity-50" title={e.created_at}>
                        {relativeTime(e.created_at)}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              {#if !auditDone}
                <button
                  class="btn btn-ghost btn-xs mb-4"
                  disabled={auditBusy}
                  onclick={() => void loadAudit(false)}
                >
                  {#if auditBusy}
                    <span class="loading loading-spinner loading-xs"></span>
                  {/if}
                  {t("common.loadMore")}
                </button>
              {/if}
            {/if}
          {/if}

          <p class="text-xs opacity-50">
            {t("ws.footnotePre")} <code class="font-mono">muesli login</code>
            {t("ws.footnoteMid")}
            <span class="whitespace-nowrap">{t("ws.agentBadge")}</span>
            {t("ws.footnotePost")}
          </p>
        {/if}
      {/if}
    </div>
  </div>
  <button class="modal-backdrop" aria-label={t("common.close")} onclick={onclose}></button>
</div>
