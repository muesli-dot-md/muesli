// Settings → workspace General (Multica's "General"). muesli's workspace model
// backs ONLY the Name field (PATCH /api/workspaces/{id} {name}) — there is no
// description/context/slug column, so those Multica fields are intentionally
// absent. The Danger Zone carries two destructive actions: Leave workspace
// (self-removal via DELETE …/members/{me}; non-personal only, not when you're
// the last admin) and Delete workspace (admin-only, DELETE /api/workspaces/{id}
// — purges every document; guarded by a typed-name confirmation). React port
// of the web settings/WorkspaceGeneralSection.svelte.
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errMsg } from "@/services/apiError";
import { httpBase, type Me } from "@/services/identity";
import {
  createWorkspaceApi,
  WorkspaceApiError,
  type WorkspaceDetail,
  type WorkspaceSummary,
} from "@/services/workspaceApi";
import { useT } from "@/state/i18n";
import { SettingsCard } from "./SettingsCard";

interface Props {
  user: Me;
  workspace: WorkspaceSummary;
  detail: WorkspaceDetail | null;
  toast: (msg: string, kind?: "info" | "warning") => void;
  /** Reload list + detail after a rename or leave (the shell owns the data). */
  onChanged: () => void;
}

const api = createWorkspaceApi({ httpBase });

export function WorkspaceGeneralSection({ user, workspace, detail, toast, onChanged }: Props) {
  const t = useT();

  const [nameDraft, setNameDraft] = useState(workspace.name);
  const seededFor = useRef(workspace.id);
  useEffect(() => {
    // Re-seed when the selected workspace changes (don't clobber active typing).
    if (seededFor.current !== workspace.id) {
      setNameDraft(workspace.name);
      seededFor.current = workspace.id;
    }
  }, [workspace.id, workspace.name]);

  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const isAdmin = workspace.role === "admin";
  const adminCount = detail?.members.filter((m) => m.role === "admin").length ?? 0;
  const onlyAdmin =
    !!detail?.members.find((m) => m.user_id === user.id && m.role === "admin") &&
    adminCount === 1;
  const dirty = nameDraft.trim() !== "" && nameDraft.trim() !== workspace.name;

  async function save() {
    if (!dirty) return;
    setSaving(true);
    try {
      await api.renameWorkspace(workspace.id, nameDraft.trim());
      toast(t("settings.general.saved"));
      onChanged();
    } catch (e) {
      if (e instanceof WorkspaceApiError && e.status === 403)
        toast(t("ws.notAllowed"), "warning");
      else toast(errMsg(e), "warning");
    } finally {
      setSaving(false);
    }
  }

  async function leave() {
    if (!confirm(t("confirm.leaveWorkspace", { name: workspace.name }))) return;
    setLeaving(true);
    try {
      await api.removeMember(workspace.id, user.id);
      toast(t("settings.general.left", { name: workspace.name }));
      onChanged();
    } catch (e) {
      if (e instanceof WorkspaceApiError && e.status === 409)
        toast(t("ws.adminNeeded"), "warning");
      else toast(errMsg(e), "warning");
    } finally {
      setLeaving(false);
    }
  }

  /** Typed-name confirmation: a plain OK-click is too cheap for an action that
   *  purges every document for every member. Mistyped/cancelled → no-op. */
  async function deleteWorkspaceForever() {
    const typed = prompt(t("confirm.deleteWorkspace", { name: workspace.name }));
    if (typed === null) return;
    if (typed.trim() !== workspace.name) {
      toast(t("settings.general.deleteNameMismatch"), "warning");
      return;
    }
    setDeleting(true);
    try {
      await api.deleteWorkspace(workspace.id);
      toast(t("settings.general.deleted", { name: workspace.name }));
      onChanged();
    } catch (e) {
      if (e instanceof WorkspaceApiError && e.status === 403)
        toast(t("ws.notAllowed"), "warning");
      else toast(errMsg(e), "warning");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <header className="mb-5">
        <h2 className="text-lg font-semibold tracking-tight">
          {t("settings.nav.general")}
        </h2>
      </header>

      <SettingsCard>
        <div className="px-4 py-3.5">
          <label className="mb-1.5 block text-sm font-medium" htmlFor="ws-general-name">
            {t("settings.general.name")}
          </label>
          <Input
            id="ws-general-name"
            className="h-8 w-full max-w-md"
            value={nameDraft}
            maxLength={120}
            disabled={!isAdmin}
            onChange={(e) => setNameDraft(e.currentTarget.value)}
          />
          {!isAdmin ? (
            <p className="mt-2 text-xs text-muted-foreground [text-wrap:pretty]">
              {t("settings.general.adminOnly")}
            </p>
          ) : null}
          <div className="mt-4 flex justify-end">
            <Button size="sm" disabled={!isAdmin || !dirty || saving} onClick={() => void save()}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      </SettingsCard>

      {!workspace.is_personal || isAdmin ? (
        <SettingsCard heading={t("settings.general.dangerZone")} tone="danger">
          {!workspace.is_personal ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-destructive">
                  {t("settings.general.leave")}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground [text-wrap:pretty]">
                  {onlyAdmin
                    ? t("settings.general.leaveLastAdmin")
                    : t("settings.general.leaveNote")}
                </p>
              </div>
              <Button
                variant="destructive"
                size="sm"
                className="shrink-0"
                disabled={leaving || onlyAdmin}
                onClick={() => void leave()}
              >
                {t("settings.general.leave")}
              </Button>
            </div>
          ) : null}
          {isAdmin ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-destructive">
                  {t("settings.general.delete")}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground [text-wrap:pretty]">
                  {t("settings.general.deleteNote")}
                </p>
              </div>
              <Button
                variant="destructive"
                size="sm"
                className="shrink-0"
                disabled={deleting}
                onClick={() => void deleteWorkspaceForever()}
              >
                {t("settings.general.delete")}
              </Button>
            </div>
          ) : null}
        </SettingsCard>
      ) : (
        <p className="mt-4 px-1 text-xs text-muted-foreground [text-wrap:pretty]">
          {t("settings.general.personalNote")}
        </p>
      )}
    </>
  );
}

export default WorkspaceGeneralSection;
