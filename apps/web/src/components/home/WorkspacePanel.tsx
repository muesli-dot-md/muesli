// Workspace admin modal (workspace list/detail, rename/delete, invites, member
// roles, audit log), opened from AccountMenu in the editor header. Uses
// identity/time services, not collab: the home screen opens this panel too and
// must not pull in yjs / open a doc room as a side effect. Ported from
// WorkspacePanel.svelte onto the shadcn Dialog.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Pencil, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useT } from "@/state/i18n";
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

interface Props {
  user: Me;
  onClose: () => void;
  toast?: (msg: string) => void;
}

const api = createWorkspaceApi({ httpBase });

// Audit log (admins only, Phase 5): newest-first, paged by the last entry's id.
const AUDIT_PAGE = 25;

/** Small neutral pill (the old daisy badge). */
function Pill({
  className = "",
  title,
  children,
}: {
  className?: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-0.5 rounded-full bg-[var(--color-base-200)] px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {children}
    </span>
  );
}

export function WorkspacePanel({ user, onClose, toast = () => {} }: Props) {
  const t = useT();

  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(""); // open mode (503) / signed out (401)

  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>("member");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [busyMember, setBusyMember] = useState<string | null>(null); // user_id of the row being mutated
  const [busyInvite, setBusyInvite] = useState<string | null>(null);

  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditDone, setAuditDone] = useState(false);
  // Async paging reads the latest entries without re-wiring callbacks.
  const auditRef = useRef<AuditEntry[]>([]);
  auditRef.current = auditEntries;
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const activeSummary = workspaces.find((w) => w.id === activeId) ?? null;
  const isAdmin = detail?.role === "admin";
  const adminCount = detail?.members.filter((m) => m.role === "admin").length ?? 0;

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

  async function loadDetail(id: string) {
    setDetailLoading(true);
    try {
      const d = await api.getWorkspace(id);
      setDetail(d);
      if (d.role === "admin") {
        void loadAudit(true, d);
      } else {
        setAuditEntries([]);
        setAuditDone(false);
      }
    } catch (e) {
      fail(e);
    } finally {
      setDetailLoading(false);
    }
  }

  async function loadAudit(reset: boolean, d: WorkspaceDetail | null = detail) {
    if (!d || d.role !== "admin") return;
    setAuditBusy(true);
    try {
      const cur = auditRef.current;
      const beforeId = reset ? undefined : cur[cur.length - 1]?.id;
      const { entries } = await api.getAudit(d.id, { limit: AUDIT_PAGE, beforeId });
      setAuditEntries(reset ? entries : [...cur, ...entries]);
      setAuditDone(entries.length < AUDIT_PAGE);
    } catch (e) {
      fail(e);
    } finally {
      setAuditBusy(false);
    }
  }

  async function loadList() {
    setListLoading(true);
    try {
      const ws = (await api.listWorkspaces()).workspaces;
      setWorkspaces(ws);
      let id = activeIdRef.current;
      if (!id || !ws.some((w) => w.id === id)) {
        id = ws[0]?.id ?? null; // personal comes first
        setActiveId(id);
      }
      if (id) await loadDetail(id);
    } catch (e) {
      if (e instanceof WorkspaceApiError && e.status === 503) {
        setUnavailable(t("ws.unavailableOpenMode"));
      } else if (e instanceof WorkspaceApiError && e.status === 401) {
        setUnavailable(t("ws.signInToManage"));
      } else {
        fail(e);
      }
    } finally {
      setListLoading(false);
    }
  }

  const loadedRef = useRef(false);
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** "share_link_created" → "share link created" for the audit table. */
  const actionLabel = (action: string): string => action.replaceAll("_", " ");

  const auditActorName = (e: AuditEntry): string =>
    e.actor?.display_name ?? e.actor_label ?? (e.actor ? e.actor.id.slice(0, 8) : "—");

  function select(id: string) {
    if (id === activeId) return;
    setActiveId(id);
    setRenaming(false);
    void loadDetail(id);
  }

  async function saveRename() {
    if (!detail || !renameDraft.trim() || renameDraft.trim() === detail.name) {
      setRenaming(false);
      return;
    }
    try {
      await api.renameWorkspace(detail.id, renameDraft.trim());
      setRenaming(false);
      await Promise.all([loadDetail(detail.id), refreshList()]);
    } catch (e) {
      fail(e);
    }
  }

  async function refreshList() {
    try {
      setWorkspaces((await api.listWorkspaces()).workspaces);
    } catch {
      // list refresh is cosmetic here; detail errors are surfaced elsewhere
    }
  }

  async function setRole(m: WorkspaceMember, role: WorkspaceRole) {
    if (!detail || role === m.role) return;
    setBusyMember(m.user_id);
    try {
      await api.setMemberRole(detail.id, m.user_id, role);
      await loadDetail(detail.id);
    } catch (e) {
      fail(e);
      await loadDetail(detail.id); // reset the select to the server's truth
    } finally {
      setBusyMember(null);
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
    setBusyMember(m.user_id);
    try {
      await api.removeMember(detail.id, m.user_id);
      if (self) {
        setDetail(null);
        setActiveId(null);
        activeIdRef.current = null;
        await loadList(); // back to the personal workspace
      } else {
        await loadDetail(detail.id);
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusyMember(null);
    }
  }

  async function sendInvite(e: FormEvent) {
    e.preventDefault();
    if (!detail || !inviteEmail.trim()) return;
    setInviteBusy(true);
    try {
      const res = await api.createInvite(detail.id, inviteEmail.trim(), inviteRole);
      if (res.status === "added") {
        toast(t("ws.added", { email: inviteEmail.trim() }));
      } else {
        toast(t("ws.inviteClaim"));
      }
      setInviteEmail("");
      await loadDetail(detail.id);
    } catch (err) {
      fail(err);
    } finally {
      setInviteBusy(false);
    }
  }

  async function revokeInvite(inviteId: string) {
    if (!detail) return;
    setBusyInvite(inviteId);
    try {
      await api.revokeInvite(detail.id, inviteId);
      await loadDetail(detail.id);
    } catch (e) {
      fail(e);
    } finally {
      setBusyInvite(null);
    }
  }

  const initial = (m: WorkspaceMember): string =>
    (m.display_name ?? m.email ?? "?").trim().charAt(0).toUpperCase() || "?";

  /** Disable the role select for yourself when you're the only admin (409 anyway). */
  const roleLocked = (m: WorkspaceMember): boolean =>
    m.user_id === user.id && m.role === "admin" && adminCount === 1;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex max-h-[85vh] w-11/12 flex-col sm:max-w-2xl"
        showCloseButton={false}
      >
        <div className="flex items-center justify-between border-b border-border pb-2">
          <h2 className="text-base font-semibold">{t("ws.title")}</h2>
          <Button variant="ghost" size="icon-sm" title={t("common.close")} onClick={onClose}>
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {unavailable ? (
            <p className="py-6 text-center text-sm opacity-60">{unavailable}</p>
          ) : listLoading && !detail ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-8 w-1/2" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : (
            <>
              {workspaces.length > 1 && (
                <div role="tablist" className="mb-3 flex flex-wrap gap-1 border-b border-border">
                  {workspaces.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      role="tab"
                      aria-selected={w.id === activeId}
                      className={`-mb-px flex items-center gap-1 border-b-2 px-2.5 py-1.5 text-sm transition-colors ${
                        w.id === activeId
                          ? "border-primary font-medium text-foreground"
                          : "border-transparent text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={() => select(w.id)}
                    >
                      {w.name}
                      {w.is_personal && <span className="opacity-50">·</span>}
                    </button>
                  ))}
                </div>
              )}

              {detailLoading && !detail ? (
                <Skeleton className="h-40 w-full" />
              ) : detail ? (
                <>
                  {/* name + badges */}
                  <div className="mb-4 flex flex-wrap items-center gap-2">
                    {renaming ? (
                      <form
                        className="flex items-center gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void saveRename();
                        }}
                      >
                        <Input
                          className="h-8 w-56"
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          autoFocus
                        />
                        <Button size="sm" type="submit">
                          {t("common.save")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          onClick={() => setRenaming(false)}
                        >
                          {t("common.cancel")}
                        </Button>
                      </form>
                    ) : (
                      <>
                        <span className="text-lg font-semibold">{detail.name}</span>
                        {isAdmin && (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            title={t("ws.renameWorkspace")}
                            onClick={() => {
                              setRenameDraft(detail.name);
                              setRenaming(true);
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                        )}
                      </>
                    )}
                    <Pill
                      className={isAdmin ? "bg-primary/15 text-primary" : "text-muted-foreground"}
                    >
                      {detail.role}
                    </Pill>
                    {activeSummary?.is_personal && (
                      <Pill className="text-muted-foreground">{t("ws.personalBadge")}</Pill>
                    )}
                    {detailLoading && <Spinner className="size-3.5 opacity-50" />}
                  </div>

                  {/* members */}
                  <h3 className="mb-1 text-sm font-semibold opacity-70">{t("ws.members")}</h3>
                  <table className="mb-4 w-full text-sm">
                    <tbody>
                      {detail.members.map((m) => (
                        <tr key={m.user_id} className="border-b border-border/60 last:border-0">
                          <td className="w-10 py-1.5">
                            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-base-300)] text-xs font-medium">
                              {initial(m)}
                            </span>
                          </td>
                          <td className="py-1.5">
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium">
                                {m.display_name ?? m.email ?? m.user_id}
                              </span>
                              {m.user_id === user.id && (
                                <Pill className="text-muted-foreground">{t("ws.youBadge")}</Pill>
                              )}
                              {m.kind === "agent" && (
                                <Pill
                                  className="bg-primary/10 text-primary"
                                  title={t("ws.delegatedAgentIdentity")}
                                >
                                  {t("ws.agentBadge")}
                                </Pill>
                              )}
                            </div>
                            {m.email && <div className="text-xs opacity-50">{m.email}</div>}
                          </td>
                          <td className="w-28 py-1.5">
                            {isAdmin ? (
                              <select
                                className="h-7 rounded-md border border-border bg-transparent px-1.5 text-xs"
                                value={m.role}
                                disabled={roleLocked(m) || busyMember === m.user_id}
                                title={roleLocked(m) ? t("ws.adminNeeded") : ""}
                                onChange={(e) =>
                                  void setRole(m, e.currentTarget.value as WorkspaceRole)
                                }
                              >
                                <option value="admin">{t("ws.roleAdmin")}</option>
                                <option value="member">{t("ws.roleMember")}</option>
                              </select>
                            ) : (
                              <Pill className="text-muted-foreground">{m.role}</Pill>
                            )}
                          </td>
                          <td className="w-16 py-1.5 text-right">
                            {busyMember === m.user_id ? (
                              <Spinner className="size-3.5" />
                            ) : m.user_id === user.id ? (
                              !activeSummary?.is_personal && (
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  className="text-destructive"
                                  onClick={() => void removeMember(m)}
                                >
                                  {t("ws.leave")}
                                </Button>
                              )
                            ) : (
                              isAdmin && (
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  className="text-destructive"
                                  title={t("ws.removeFromWorkspace")}
                                  onClick={() => void removeMember(m)}
                                >
                                  {t("ws.remove")}
                                </Button>
                              )
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {/* invites (admins only — the server omits the list otherwise) */}
                  {isAdmin && detail.invites && (
                    <>
                      <h3 className="mb-1 text-sm font-semibold opacity-70">{t("ws.invites")}</h3>
                      {detail.invites.length > 0 && (
                        <ul className="mb-2 flex flex-col gap-1">
                          {detail.invites.map((inv) => (
                            <li
                              key={inv.id}
                              className="flex items-center gap-2 rounded-lg bg-[var(--color-base-200)] px-3 py-1.5 text-sm"
                            >
                              <span className="flex-1 truncate">{inv.email}</span>
                              <Pill className="text-muted-foreground">{inv.role}</Pill>
                              <span className="text-xs opacity-50">
                                {relativeTime(inv.created_at)}
                              </span>
                              {busyInvite === inv.id ? (
                                <Spinner className="size-3.5" />
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  className="text-destructive"
                                  onClick={() => void revokeInvite(inv.id)}
                                >
                                  {t("ws.revoke")}
                                </Button>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      <form
                        className="mb-4 flex items-center gap-2"
                        onSubmit={(e) => void sendInvite(e)}
                      >
                        <Input
                          className="h-8 flex-1"
                          type="email"
                          placeholder={t("ws.emailPlaceholder")}
                          value={inviteEmail}
                          onChange={(e) => setInviteEmail(e.target.value)}
                          required
                        />
                        <select
                          className="h-8 w-28 rounded-md border border-border bg-transparent px-1.5 text-sm"
                          value={inviteRole}
                          onChange={(e) => setInviteRole(e.currentTarget.value as WorkspaceRole)}
                        >
                          <option value="member">{t("ws.roleMember")}</option>
                          <option value="admin">{t("ws.roleAdmin")}</option>
                        </select>
                        <Button size="sm" type="submit" disabled={inviteBusy}>
                          {inviteBusy && <Spinner className="size-3.5" />}
                          {t("ws.invite")}
                        </Button>
                      </form>
                    </>
                  )}

                  {/* audit log (admins only; the server 403s everyone else) */}
                  {isAdmin && (
                    <>
                      <h3 className="mb-1 text-sm font-semibold opacity-70">{t("ws.audit")}</h3>
                      {auditEntries.length === 0 && !auditBusy ? (
                        <p className="mb-4 text-xs opacity-50">{t("ws.noAudit")}</p>
                      ) : (
                        <>
                          <table className="mb-1 w-full text-xs">
                            <thead>
                              <tr className="text-left text-muted-foreground">
                                <th className="py-1 font-medium">{t("ws.colAction")}</th>
                                <th className="py-1 font-medium">{t("ws.colActor")}</th>
                                <th className="py-1 text-right font-medium">{t("ws.colWhen")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {auditEntries.map((e) => (
                                <tr key={e.id} className="border-b border-border/40 last:border-0">
                                  <td className="py-1">
                                    <Pill className="font-mono text-muted-foreground">
                                      {actionLabel(e.action)}
                                    </Pill>
                                  </td>
                                  <td className="py-1">
                                    <span className="flex items-center gap-1">
                                      {auditActorName(e)}
                                      {e.actor?.kind === "agent" && (
                                        <Pill
                                          className="bg-primary/10 text-primary"
                                          title={t("ws.agentIdentity")}
                                        >
                                          🤖
                                        </Pill>
                                      )}
                                    </span>
                                  </td>
                                  <td
                                    className="py-1 text-right text-xs opacity-50"
                                    title={e.created_at}
                                  >
                                    {relativeTime(e.created_at)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {!auditDone && (
                            <Button
                              variant="ghost"
                              size="xs"
                              className="mb-4"
                              disabled={auditBusy}
                              onClick={() => void loadAudit(false)}
                            >
                              {auditBusy && <Spinner className="size-3.5" />}
                              {t("common.loadMore")}
                            </Button>
                          )}
                        </>
                      )}
                    </>
                  )}

                  <p className="text-xs opacity-50">
                    {t("ws.footnotePre")} <code className="font-mono">muesli login</code>{" "}
                    {t("ws.footnoteMid")}{" "}
                    <span className="whitespace-nowrap">{t("ws.agentBadge")}</span>{" "}
                    {t("ws.footnotePost")}
                  </p>
                </>
              ) : null}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default WorkspacePanel;
