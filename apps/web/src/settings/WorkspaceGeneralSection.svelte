<script lang="ts">
  // Settings → workspace General (Multica's "General"). muesli's workspace model
  // backs ONLY the Name field (PATCH /api/workspaces/{id} {name}) — there is no
  // description/context/slug column, so those Multica fields are intentionally
  // absent (see the report). The Danger Zone carries two destructive actions:
  // Leave workspace (self-removal via DELETE …/members/{me}; non-personal only,
  // not when you're the last admin) and Delete workspace (admin-only, DELETE
  // /api/workspaces/{id} — purges every document; guarded by a typed-name
  // confirmation).
  import { errMsg } from "../apiError";
  import { t } from "../i18n/index.svelte";
  import { httpBase, type Me } from "../identity";
  import {
    createWorkspaceApi,
    WorkspaceApiError,
    type WorkspaceDetail,
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
    /** Reload list + detail after a rename or leave (the shell owns the data). */
    onchanged: () => void;
  } = $props();

  const api = createWorkspaceApi({ httpBase });

  let nameDraft = $state("");
  let seededFor = "";
  $effect(() => {
    // Re-seed when the selected workspace changes (don't clobber active typing).
    if (seededFor !== workspace.id) {
      nameDraft = workspace.name;
      seededFor = workspace.id;
    }
  });

  let saving = $state(false);
  let leaving = $state(false);
  let deleting = $state(false);

  const isAdmin = $derived(workspace.role === "admin");
  const adminCount = $derived(detail?.members.filter((m) => m.role === "admin").length ?? 0);
  const onlyAdmin = $derived(
    !!detail?.members.find((m) => m.user_id === user.id && m.role === "admin") && adminCount === 1,
  );
  const dirty = $derived(nameDraft.trim() !== "" && nameDraft.trim() !== workspace.name);

  async function save() {
    if (!dirty) return;
    saving = true;
    try {
      await api.renameWorkspace(workspace.id, nameDraft.trim());
      toast(t("settings.general.saved"));
      onchanged();
    } catch (e) {
      if (e instanceof WorkspaceApiError && e.status === 403) toast(t("ws.notAllowed"), "warning");
      else toast(errMsg(e), "warning");
    } finally {
      saving = false;
    }
  }

  async function leave() {
    if (!confirm(t("confirm.leaveWorkspace", { name: workspace.name }))) return;
    leaving = true;
    try {
      await api.removeMember(workspace.id, user.id);
      toast(t("settings.general.left", { name: workspace.name }));
      onchanged();
    } catch (e) {
      if (e instanceof WorkspaceApiError && e.status === 409) toast(t("ws.adminNeeded"), "warning");
      else toast(errMsg(e), "warning");
    } finally {
      leaving = false;
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
    deleting = true;
    try {
      await api.deleteWorkspace(workspace.id);
      toast(t("settings.general.deleted", { name: workspace.name }));
      onchanged();
    } catch (e) {
      if (e instanceof WorkspaceApiError && e.status === 403) toast(t("ws.notAllowed"), "warning");
      else toast(errMsg(e), "warning");
    } finally {
      deleting = false;
    }
  }
</script>

<header class="mb-5">
  <h2 class="text-lg font-semibold tracking-tight">{t("settings.nav.general")}</h2>
</header>

<SettingsCard>
  <div class="px-5 py-4">
    <label class="mb-1.5 block text-sm font-medium" for="ws-general-name">
      {t("settings.general.name")}
    </label>
    <input
      id="ws-general-name"
      class="input input-sm w-full max-w-md"
      bind:value={nameDraft}
      maxlength={120}
      disabled={!isAdmin}
    />
    {#if !isAdmin}
      <p class="mt-2 text-xs text-[var(--text-muted)]" style="text-wrap: pretty;">
        {t("settings.general.adminOnly")}
      </p>
    {/if}
    <div class="mt-4 flex justify-end">
      <button class="btn btn-primary btn-sm" disabled={!isAdmin || !dirty || saving} onclick={save}>
        {t("common.save")}
      </button>
    </div>
  </div>
</SettingsCard>

{#if !workspace.is_personal || isAdmin}
  <SettingsCard heading={t("settings.general.dangerZone")} tone="danger">
    {#if !workspace.is_personal}
      <div class="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-error">{t("settings.general.leave")}</p>
          <p class="mt-0.5 text-xs text-[var(--text-muted)]" style="text-wrap: pretty;">
            {onlyAdmin ? t("settings.general.leaveLastAdmin") : t("settings.general.leaveNote")}
          </p>
        </div>
        <button
          class="btn btn-sm btn-error btn-outline shrink-0"
          disabled={leaving || onlyAdmin}
          onclick={leave}
        >
          {t("settings.general.leave")}
        </button>
      </div>
    {/if}
    {#if isAdmin}
      <div
        class="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4 {!workspace.is_personal
          ? 'border-t border-base-300'
          : ''}"
      >
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-error">{t("settings.general.delete")}</p>
          <p class="mt-0.5 text-xs text-[var(--text-muted)]" style="text-wrap: pretty;">
            {t("settings.general.deleteNote")}
          </p>
        </div>
        <button
          class="btn btn-sm btn-error btn-outline shrink-0"
          disabled={deleting}
          onclick={deleteWorkspaceForever}
        >
          {t("settings.general.delete")}
        </button>
      </div>
    {/if}
  </SettingsCard>
{:else}
  <p class="mt-4 px-1 text-xs text-[var(--text-muted)]" style="text-wrap: pretty;">
    {t("settings.general.personalNote")}
  </p>
{/if}
