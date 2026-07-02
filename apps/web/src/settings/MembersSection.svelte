<script lang="ts">
  // Settings → workspace Members (Multica's "Members"). The real member-management
  // surface — lifted out of the old WorkspacePanel modal into a settings page:
  // member rows with role select + remove, the invite form, pending invites, and
  // the admin audit log. All against the live workspace API (roles, invites,
  // members, audit). The shell passes the loaded `detail`; mutations call back to
  // reload it. Personal workspaces have only you, so the invite form is hidden.
  import { t } from "../i18n/index.svelte";
  import { httpBase, type Me } from "../identity";
  import { relativeTime } from "../time";
  import {
    createWorkspaceApi,
    WorkspaceApiError,
    type AuditEntry,
    type WorkspaceDetail,
    type WorkspaceMember,
    type WorkspaceRole,
    type WorkspaceSummary,
  } from "../workspaceApi";
  import SettingsCard from "./SettingsCard.svelte";

  let {
    user,
    workspace,
    detail,
    toast,
    onchanged,
  }: {
    user: Me;
    workspace: WorkspaceSummary;
    detail: WorkspaceDetail | null;
    toast: (msg: string, kind?: "info" | "warning") => void;
    onchanged: () => void;
  } = $props();

  const api = createWorkspaceApi({ httpBase });

  let inviteEmail = $state("");
  let inviteRole: WorkspaceRole = $state("member");
  let inviteBusy = $state(false);
  let busyMember: string | null = $state(null);
  let busyInvite: string | null = $state(null);

  const isAdmin = $derived(workspace.role === "admin");
  const adminCount = $derived(detail?.members.filter((m) => m.role === "admin").length ?? 0);

  // Audit log (admins only): newest-first, paged by the last entry's id.
  const AUDIT_PAGE = 25;
  let auditEntries: AuditEntry[] = $state([]);
  let auditBusy = $state(false);
  let auditDone = $state(false);
  let auditFor = "";

  $effect(() => {
    // (Re)load the audit log when the admin switches workspace.
    if (isAdmin && detail && auditFor !== workspace.id) {
      auditFor = workspace.id;
      void loadAudit(true);
    } else if (!isAdmin) {
      auditEntries = [];
      auditDone = false;
      auditFor = "";
    }
  });

  function fail(e: unknown) {
    if (e instanceof WorkspaceApiError && e.status === 409) toast(t("ws.adminNeeded"), "warning");
    else if (e instanceof WorkspaceApiError && e.status === 403)
      toast(t("ws.notAllowed"), "warning");
    else
      toast(
        t("common.errorWithDetail", { detail: e instanceof Error ? e.message : String(e) }),
        "warning",
      );
  }

  async function loadAudit(reset: boolean) {
    if (!isAdmin) return;
    auditBusy = true;
    try {
      const beforeId = reset ? undefined : auditEntries[auditEntries.length - 1]?.id;
      const { entries } = await api.getAudit(workspace.id, { limit: AUDIT_PAGE, beforeId });
      auditEntries = reset ? entries : [...auditEntries, ...entries];
      auditDone = entries.length < AUDIT_PAGE;
    } catch (e) {
      fail(e);
    } finally {
      auditBusy = false;
    }
  }

  function actionLabel(action: string): string {
    return action.replaceAll("_", " ");
  }
  function auditActorName(e: AuditEntry): string {
    return e.actor?.display_name ?? e.actor_label ?? (e.actor ? e.actor.id.slice(0, 8) : "—");
  }

  function initial(m: WorkspaceMember): string {
    return (m.display_name ?? m.email ?? "?").trim().charAt(0).toUpperCase() || "?";
  }
  /** Disable the role select for yourself when you're the only admin (409 anyway). */
  function roleLocked(m: WorkspaceMember): boolean {
    return m.user_id === user.id && m.role === "admin" && adminCount === 1;
  }

  async function setRole(m: WorkspaceMember, role: WorkspaceRole) {
    if (role === m.role) return;
    busyMember = m.user_id;
    try {
      await api.setMemberRole(workspace.id, m.user_id, role);
      onchanged();
    } catch (e) {
      fail(e);
      onchanged();
    } finally {
      busyMember = null;
    }
  }

  async function removeMember(m: WorkspaceMember) {
    const self = m.user_id === user.id;
    const prompt = self
      ? t("confirm.leaveWorkspace", { name: workspace.name })
      : t("confirm.removeMember", {
          member: m.display_name ?? m.email ?? t("ws.thisMember"),
          name: workspace.name,
        });
    if (!confirm(prompt)) return;
    busyMember = m.user_id;
    try {
      await api.removeMember(workspace.id, m.user_id);
      onchanged();
    } catch (e) {
      fail(e);
    } finally {
      busyMember = null;
    }
  }

  async function sendInvite() {
    if (!inviteEmail.trim()) return;
    inviteBusy = true;
    try {
      const res = await api.createInvite(workspace.id, inviteEmail.trim(), inviteRole);
      if (res.status === "added") toast(t("ws.added", { email: inviteEmail.trim() }));
      else toast(t("ws.inviteClaim"));
      inviteEmail = "";
      onchanged();
    } catch (e) {
      fail(e);
    } finally {
      inviteBusy = false;
    }
  }

  async function revokeInvite(inviteId: string) {
    busyInvite = inviteId;
    try {
      await api.revokeInvite(workspace.id, inviteId);
      onchanged();
    } catch (e) {
      fail(e);
    } finally {
      busyInvite = null;
    }
  }
</script>

<header class="mb-5">
  <h2 class="text-lg font-semibold tracking-tight">{t("settings.nav.members")}</h2>
  <p class="mt-1 text-sm text-[var(--text-muted)]" style="text-wrap: pretty;">
    {t("settings.members.intro")}
  </p>
</header>

{#if !detail}
  <SettingsCard>
    <div class="px-5 py-6 text-sm text-[var(--text-muted)]">{t("common.loading")}</div>
  </SettingsCard>
{:else}
  <!-- members list -->
  <SettingsCard heading={t("ws.members")}>
    {#each detail.members as m (m.user_id)}
      <div
        class="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-base-300/60 px-5 py-3 first:border-t-0"
      >
        <span
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral text-xs font-semibold text-neutral-content"
          aria-hidden="true"
        >
          {initial(m)}
        </span>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="truncate text-sm font-medium"
              >{m.display_name ?? m.email ?? m.user_id}</span
            >
            {#if m.user_id === user.id}
              <span class="badge badge-ghost badge-xs">{t("ws.youBadge")}</span>
            {/if}
            {#if m.kind === "agent"}
              <span class="badge badge-secondary badge-xs" title={t("ws.delegatedAgentIdentity")}>
                {t("ws.agentBadge")}
              </span>
            {/if}
          </div>
          {#if m.email}
            <p class="truncate text-xs text-[var(--text-muted)]">{m.email}</p>
          {/if}
        </div>
        {#if isAdmin}
          <select
            class="select select-xs w-24"
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
        {#if busyMember === m.user_id}
          <span class="loading loading-spinner loading-xs"></span>
        {:else if m.user_id === user.id && !workspace.is_personal}
          <button class="btn btn-ghost btn-xs text-error" onclick={() => void removeMember(m)}>
            {t("ws.leave")}
          </button>
        {:else if isAdmin && m.user_id !== user.id}
          <button
            class="btn btn-ghost btn-xs text-error"
            title={t("ws.removeFromWorkspace")}
            onclick={() => void removeMember(m)}
          >
            {t("ws.remove")}
          </button>
        {/if}
      </div>
    {/each}
  </SettingsCard>

  <!-- invites (admins only — the server omits the list for everyone else) -->
  {#if isAdmin && detail.invites}
    <SettingsCard heading={t("ws.invites")}>
      <div class="px-5 py-4">
        <form
          class="flex flex-wrap items-center gap-2"
          onsubmit={(e) => {
            e.preventDefault();
            void sendInvite();
          }}
        >
          <input
            class="input input-sm min-w-0 flex-1"
            type="email"
            placeholder={t("ws.emailPlaceholder")}
            bind:value={inviteEmail}
            required
          />
          <select class="select select-sm w-28" bind:value={inviteRole}>
            <option value="member">{t("ws.roleMember")}</option>
            <option value="admin">{t("ws.roleAdmin")}</option>
          </select>
          <button class="btn btn-primary btn-sm" type="submit" disabled={inviteBusy}>
            {#if inviteBusy}<span class="loading loading-spinner loading-xs"></span>{/if}
            {t("ws.invite")}
          </button>
        </form>

        {#if detail.invites.length > 0}
          <ul class="mt-3 flex flex-col gap-1.5">
            {#each detail.invites as inv (inv.id)}
              <li class="flex items-center gap-2 rounded-field bg-base-200 px-3 py-1.5 text-sm">
                <span class="min-w-0 flex-1 truncate">{inv.email}</span>
                <span class="badge badge-ghost badge-xs">{inv.role}</span>
                <span class="text-xs tabular-nums text-[var(--text-muted)]">
                  {relativeTime(inv.created_at)}
                </span>
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
      </div>
    </SettingsCard>
  {/if}

  <!-- audit log (admins only; the server 403s everyone else) -->
  {#if isAdmin}
    <SettingsCard heading={t("ws.audit")}>
      <div class="px-5 py-4">
        {#if auditEntries.length === 0 && !auditBusy}
          <p class="text-xs text-[var(--text-muted)]">{t("ws.noAudit")}</p>
        {:else}
          <table class="table table-xs">
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
                  <td
                    ><span class="badge badge-ghost badge-xs font-mono"
                      >{actionLabel(e.action)}</span
                    ></td
                  >
                  <td>
                    <span class="flex items-center gap-1">
                      {auditActorName(e)}
                      {#if e.actor?.kind === "agent"}
                        <span class="badge badge-secondary badge-xs" title={t("ws.agentIdentity")}
                          >🤖</span
                        >
                      {/if}
                    </span>
                  </td>
                  <td
                    class="text-right text-xs tabular-nums text-[var(--text-muted)]"
                    title={e.created_at}
                  >
                    {relativeTime(e.created_at)}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if !auditDone}
            <button
              class="btn btn-ghost btn-xs mt-1"
              disabled={auditBusy}
              onclick={() => void loadAudit(false)}
            >
              {#if auditBusy}<span class="loading loading-spinner loading-xs"></span>{/if}
              {t("common.loadMore")}
            </button>
          {/if}
        {/if}
      </div>
    </SettingsCard>
  {/if}
{/if}
