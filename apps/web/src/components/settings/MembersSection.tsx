// Settings → workspace Members (Multica's "Members"). The real member-management
// surface — lifted out of the old WorkspacePanel modal into a settings page:
// member rows with role select + remove, the invite form, pending invites, and
// the admin audit log. All against the live workspace API (roles, invites,
// members, audit). The shell passes the loaded `detail`; mutations call back to
// reload it. Personal workspaces have only you, so the invite form is hidden.
// React port of the web settings/MembersSection.svelte.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errMsg } from "@/services/apiError";
import { httpBase, type Me } from "@/services/identity";
import { relativeTime } from "@/services/time";
import {
  createWorkspaceApi,
  WorkspaceApiError,
  type AuditEntry,
  type WorkspaceDetail,
  type WorkspaceMember,
  type WorkspaceRole,
  type WorkspaceSummary,
} from "@/services/workspaceApi";
import { useT } from "@/state/i18n";
import { NativeSelect } from "./NativeSelect";
import { SettingsCard } from "./SettingsCard";

interface Props {
  user: Me;
  workspace: WorkspaceSummary;
  detail: WorkspaceDetail | null;
  toast: (msg: string, kind?: "info" | "warning") => void;
  onChanged: () => void;
}

const api = createWorkspaceApi({ httpBase });

// Audit log (admins only): newest-first, paged by the last entry's id.
const AUDIT_PAGE = 25;

export function MembersSection({ user, workspace, detail, toast, onChanged }: Props) {
  const t = useT();

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>("member");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [busyMember, setBusyMember] = useState<string | null>(null);
  const [busyInvite, setBusyInvite] = useState<string | null>(null);

  const isAdmin = workspace.role === "admin";
  const adminCount = detail?.members.filter((m) => m.role === "admin").length ?? 0;

  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditDone, setAuditDone] = useState(false);
  const auditFor = useRef("");

  function fail(e: unknown) {
    if (e instanceof WorkspaceApiError && e.status === 409) toast(t("ws.adminNeeded"), "warning");
    else if (e instanceof WorkspaceApiError && e.status === 403)
      toast(t("ws.notAllowed"), "warning");
    else toast(errMsg(e), "warning");
  }

  async function loadAudit(reset: boolean, current: AuditEntry[]) {
    if (!isAdmin) return;
    setAuditBusy(true);
    try {
      const beforeId = reset ? undefined : current[current.length - 1]?.id;
      const { entries } = await api.getAudit(workspace.id, { limit: AUDIT_PAGE, beforeId });
      setAuditEntries(reset ? entries : [...current, ...entries]);
      setAuditDone(entries.length < AUDIT_PAGE);
    } catch (e) {
      fail(e);
    } finally {
      setAuditBusy(false);
    }
  }

  useEffect(() => {
    // (Re)load the audit log when the admin switches workspace.
    if (isAdmin && detail && auditFor.current !== workspace.id) {
      auditFor.current = workspace.id;
      void loadAudit(true, []);
    } else if (!isAdmin) {
      setAuditEntries([]);
      setAuditDone(false);
      auditFor.current = "";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, detail, workspace.id]);

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
    setBusyMember(m.user_id);
    try {
      await api.setMemberRole(workspace.id, m.user_id, role);
      onChanged();
    } catch (e) {
      fail(e);
      onChanged();
    } finally {
      setBusyMember(null);
    }
  }

  async function removeMember(m: WorkspaceMember) {
    const self = m.user_id === user.id;
    const promptText = self
      ? t("confirm.leaveWorkspace", { name: workspace.name })
      : t("confirm.removeMember", {
          member: m.display_name ?? m.email ?? t("ws.thisMember"),
          name: workspace.name,
        });
    if (!confirm(promptText)) return;
    setBusyMember(m.user_id);
    try {
      await api.removeMember(workspace.id, m.user_id);
      onChanged();
    } catch (e) {
      fail(e);
    } finally {
      setBusyMember(null);
    }
  }

  async function sendInvite() {
    if (!inviteEmail.trim()) return;
    setInviteBusy(true);
    try {
      const res = await api.createInvite(workspace.id, inviteEmail.trim(), inviteRole);
      if (res.status === "added") toast(t("ws.added", { email: inviteEmail.trim() }));
      else toast(t("ws.inviteClaim"));
      setInviteEmail("");
      onChanged();
    } catch (e) {
      fail(e);
    } finally {
      setInviteBusy(false);
    }
  }

  async function revokeInvite(inviteId: string) {
    setBusyInvite(inviteId);
    try {
      await api.revokeInvite(workspace.id, inviteId);
      onChanged();
    } catch (e) {
      fail(e);
    } finally {
      setBusyInvite(null);
    }
  }

  function onInviteSubmit(e: FormEvent) {
    e.preventDefault();
    void sendInvite();
  }

  return (
    <>
      <header className="mb-5">
        <h2 className="text-lg font-semibold tracking-tight">{t("settings.nav.members")}</h2>
        <p className="mt-1 text-sm text-muted-foreground [text-wrap:pretty]">
          {t("settings.members.intro")}
        </p>
      </header>

      {!detail ? (
        <SettingsCard>
          <div className="px-4 py-6 text-sm text-muted-foreground">{t("common.loading")}</div>
        </SettingsCard>
      ) : (
        <>
          {/* members list */}
          <SettingsCard heading={t("ws.members")}>
            {detail.members.map((m) => (
              <div
                key={m.user_id}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
              >
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground"
                  aria-hidden="true"
                >
                  {initial(m)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-medium">
                      {m.display_name ?? m.email ?? m.user_id}
                    </span>
                    {m.user_id === user.id ? (
                      <Badge variant="secondary">{t("ws.youBadge")}</Badge>
                    ) : null}
                    {m.kind === "agent" ? (
                      <Badge variant="outline" title={t("ws.delegatedAgentIdentity")}>
                        {t("ws.agentBadge")}
                      </Badge>
                    ) : null}
                  </div>
                  {m.email ? (
                    <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                  ) : null}
                </div>
                {isAdmin ? (
                  <NativeSelect
                    className="h-7 w-24 text-xs"
                    value={m.role}
                    disabled={roleLocked(m) || busyMember === m.user_id}
                    title={roleLocked(m) ? t("ws.adminNeeded") : ""}
                    onChange={(e) => void setRole(m, e.currentTarget.value as WorkspaceRole)}
                  >
                    <option value="admin">{t("ws.roleAdmin")}</option>
                    <option value="member">{t("ws.roleMember")}</option>
                  </NativeSelect>
                ) : (
                  <Badge variant="secondary">{m.role}</Badge>
                )}
                {busyMember === m.user_id ? (
                  <Spinner className="size-3.5" />
                ) : m.user_id === user.id && !workspace.is_personal ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-destructive hover:text-destructive"
                    onClick={() => void removeMember(m)}
                  >
                    {t("ws.leave")}
                  </Button>
                ) : isAdmin && m.user_id !== user.id ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-destructive hover:text-destructive"
                    title={t("ws.removeFromWorkspace")}
                    onClick={() => void removeMember(m)}
                  >
                    {t("ws.remove")}
                  </Button>
                ) : null}
              </div>
            ))}
          </SettingsCard>

          {/* invites (admins only — the server omits the list for everyone else) */}
          {isAdmin && detail.invites ? (
            <SettingsCard heading={t("ws.invites")}>
              <div className="px-4 py-3.5">
                <form className="flex flex-wrap items-center gap-2" onSubmit={onInviteSubmit}>
                  <Input
                    className="h-8 min-w-0 flex-1"
                    type="email"
                    placeholder={t("ws.emailPlaceholder")}
                    value={inviteEmail}
                    required
                    onChange={(e) => setInviteEmail(e.currentTarget.value)}
                  />
                  <NativeSelect
                    className="w-28"
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.currentTarget.value as WorkspaceRole)}
                  >
                    <option value="member">{t("ws.roleMember")}</option>
                    <option value="admin">{t("ws.roleAdmin")}</option>
                  </NativeSelect>
                  <Button size="sm" type="submit" disabled={inviteBusy}>
                    {inviteBusy ? <Spinner className="size-3" /> : null}
                    {t("ws.invite")}
                  </Button>
                </form>

                {detail.invites.length > 0 ? (
                  <ul className="mt-3 flex flex-col gap-1.5">
                    {detail.invites.map((inv) => (
                      <li
                        key={inv.id}
                        className="flex items-center gap-2 rounded-lg bg-muted px-3 py-1.5 text-sm"
                      >
                        <span className="min-w-0 flex-1 truncate">{inv.email}</span>
                        <Badge variant="secondary">{inv.role}</Badge>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {relativeTime(inv.created_at)}
                        </span>
                        {busyInvite === inv.id ? (
                          <Spinner className="size-3" />
                        ) : (
                          <Button
                            variant="ghost"
                            size="xs"
                            className="text-destructive hover:text-destructive"
                            onClick={() => void revokeInvite(inv.id)}
                          >
                            {t("ws.revoke")}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </SettingsCard>
          ) : null}

          {/* audit log (admins only; the server 403s everyone else) */}
          {isAdmin ? (
            <SettingsCard heading={t("ws.audit")}>
              <div className="px-4 py-3.5">
                {auditEntries.length === 0 && !auditBusy ? (
                  <p className="text-xs text-muted-foreground">{t("ws.noAudit")}</p>
                ) : (
                  <>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-muted-foreground">
                          <th className="pb-1.5 font-medium">{t("ws.colAction")}</th>
                          <th className="pb-1.5 font-medium">{t("ws.colActor")}</th>
                          <th className="pb-1.5 text-right font-medium">{t("ws.colWhen")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-surface-border">
                        {auditEntries.map((e) => (
                          <tr key={e.id}>
                            <td className="py-1.5 pr-2">
                              <Badge variant="secondary" className="font-mono">
                                {actionLabel(e.action)}
                              </Badge>
                            </td>
                            <td className="py-1.5 pr-2">
                              <span className="flex items-center gap-1">
                                {auditActorName(e)}
                                {e.actor?.kind === "agent" ? (
                                  <Badge variant="outline" title={t("ws.agentIdentity")}>
                                    🤖
                                  </Badge>
                                ) : null}
                              </span>
                            </td>
                            <td
                              className="py-1.5 text-right tabular-nums text-muted-foreground"
                              title={e.created_at}
                            >
                              {relativeTime(e.created_at)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!auditDone ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="mt-1"
                        disabled={auditBusy}
                        onClick={() => void loadAudit(false, auditEntries)}
                      >
                        {auditBusy ? <Spinner className="size-3" /> : null}
                        {t("common.loadMore")}
                      </Button>
                    ) : null}
                  </>
                )}
              </div>
            </SettingsCard>
          ) : null}
        </>
      )}
    </>
  );
}

export default MembersSection;
