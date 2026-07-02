<script lang="ts">
  // Settings → Profile (settings.md §2.1): avatar + display-name OVERRIDES
  // (PATCH /api/me writes the custom_* columns, never the OIDC claim columns),
  // read-only identity rows, and the danger-zone
  // stubs. The avatar never touches blob storage: it is cover-cropped and
  // resized to 128px on a canvas and sent as a ≤64 KB data URL.
  import Copy from "@lucide/svelte/icons/copy";
  import { createAccountApi, AccountApiError, type AccountUser } from "../accountApi";
  import { t } from "../i18n/index.svelte";
  import { httpBase, loginUrl, type AuthInfo } from "../identity";
  import SettingRow from "./SettingRow.svelte";
  import SettingsCard from "./SettingsCard.svelte";

  let {
    auth,
    toast,
    onupdated,
  }: {
    auth: AuthInfo;
    toast: (msg: string, kind?: "info" | "warning") => void;
    /** Profile edits update the shell's auth so the header avatar follows. */
    onupdated: (user: AccountUser) => void;
  } = $props();

  const api = createAccountApi({ httpBase });

  let nameDraft = $state("");
  let nameInitialized = false;
  $effect(() => {
    // Seed the input once auth arrives; don't clobber while the user types.
    if (!nameInitialized && auth.user) {
      nameDraft = auth.user.display_name ?? "";
      nameInitialized = true;
    }
  });

  let savingName = $state(false);
  let savingAvatar = $state(false);
  /** A picked-but-unsaved avatar data URL (the preview state). */
  let pendingAvatar: string | null = $state(null);
  let fileInput: HTMLInputElement | undefined = $state();

  const errMsg = (e: unknown) =>
    t("common.errorWithDetail", { detail: e instanceof Error ? e.message : String(e) });

  async function patch(body: { display_name?: string | null; avatar_url?: string | null }) {
    const user = await api.patchMe(body);
    onupdated(user);
    return user;
  }

  async function saveName() {
    savingName = true;
    try {
      const trimmed = nameDraft.trim();
      const user = await patch({ display_name: trimmed === "" ? null : trimmed });
      nameDraft = user.display_name ?? "";
      toast(t("settings.profile.saved"));
    } catch (e) {
      toast(errMsg(e), "warning");
    } finally {
      savingName = false;
    }
  }

  async function resetName() {
    savingName = true;
    try {
      const user = await patch({ display_name: null });
      nameDraft = user.display_name ?? "";
      toast(t("settings.profile.saved"));
    } catch (e) {
      toast(errMsg(e), "warning");
    } finally {
      savingName = false;
    }
  }

  /** Cover-crop to a 128px square and encode small. WebP where the canvas
   *  supports encoding it; toDataURL silently falls back to PNG elsewhere
   *  (both accepted server-side), with a JPEG retry if PNG lands over 64 KB. */
  async function resizeToDataUrl(file: File): Promise<string> {
    const objectUrl = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(t("settings.profile.avatarReadFailed")));
        img.src = objectUrl;
      });
      const size = 128;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error(t("settings.profile.avatarReadFailed"));
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      ctx.drawImage(
        img,
        (img.naturalWidth - s) / 2,
        (img.naturalHeight - s) / 2,
        s,
        s,
        0,
        0,
        size,
        size,
      );
      let dataUrl = canvas.toDataURL("image/webp", 0.85);
      if (dataUrl.length > 64 * 1024) dataUrl = canvas.toDataURL("image/jpeg", 0.8);
      if (dataUrl.length > 64 * 1024) throw new Error(t("settings.profile.avatarTooLarge"));
      return dataUrl;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async function pickAvatar(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // re-picking the same file must fire change again
    if (!file) return;
    try {
      pendingAvatar = await resizeToDataUrl(file);
    } catch (err) {
      toast(errMsg(err), "warning");
    }
  }

  async function saveAvatar() {
    if (!pendingAvatar) return;
    savingAvatar = true;
    try {
      await patch({ avatar_url: pendingAvatar });
      pendingAvatar = null;
      toast(t("settings.profile.saved"));
    } catch (e) {
      toast(e instanceof AccountApiError && e.status === 400 ? e.message : errMsg(e), "warning");
    } finally {
      savingAvatar = false;
    }
  }

  async function removeAvatar() {
    savingAvatar = true;
    try {
      await patch({ avatar_url: null });
      pendingAvatar = null;
      toast(t("settings.profile.saved"));
    } catch (e) {
      toast(errMsg(e), "warning");
    } finally {
      savingAvatar = false;
    }
  }

  async function copyUserId() {
    if (!auth.user) return;
    try {
      await navigator.clipboard.writeText(auth.user.id);
      toast(t("common.copiedToClipboard"));
    } catch {
      toast(t("ws.notAllowed"), "warning");
    }
  }

  const shownAvatar = $derived(pendingAvatar ?? auth.user?.avatar_url ?? null);
  const initial = $derived(
    (auth.user?.display_name ?? auth.user?.email ?? "?").trim().charAt(0).toUpperCase(),
  );
</script>

<header class="mb-5">
  <h2 class="text-lg font-semibold tracking-tight">{t("settings.nav.profile")}</h2>
</header>

{#if auth.mode === "open"}
  <p class="text-sm text-[var(--text-muted)]" style="text-wrap: pretty;">
    {t("settings.openMode")}
  </p>
{:else if !auth.user}
  <p class="text-sm text-[var(--text-muted)]" style="text-wrap: pretty;">
    {t("settings.signInToManage")}
    <a class="link link-primary" href={loginUrl()}>{t("common.signIn")}</a>
  </p>
{:else}
  <input bind:this={fileInput} type="file" accept="image/*" class="hidden" onchange={pickAvatar} />

  <SettingsCard>
    <!-- avatar -->
    <SettingRow
      title={t("settings.profile.changeAvatar")}
      description={t("settings.profile.avatarHint")}
    >
      {#snippet leading()}
        {#if shownAvatar}
          <img src={shownAvatar} alt="" class="h-16 w-16 rounded-full object-cover" />
        {:else}
          <span
            class="flex h-16 w-16 items-center justify-center rounded-full bg-primary text-2xl font-semibold text-primary-content"
          >
            {initial}
          </span>
        {/if}
      {/snippet}
      {#snippet control()}
        {#if pendingAvatar}
          <button class="btn btn-primary btn-sm" disabled={savingAvatar} onclick={saveAvatar}>
            {t("common.save")}
          </button>
          <button class="btn btn-ghost btn-sm" onclick={() => (pendingAvatar = null)}>
            {t("common.cancel")}
          </button>
        {:else}
          <button class="btn btn-sm" disabled={savingAvatar} onclick={() => fileInput?.click()}>
            {t("settings.profile.changeAvatar")}
          </button>
          {#if auth.user?.avatar_url}
            <button class="btn btn-ghost btn-sm" disabled={savingAvatar} onclick={removeAvatar}>
              {t("settings.profile.removeAvatar")}
            </button>
          {/if}
        {/if}
      {/snippet}
    </SettingRow>

    <!-- display name -->
    <SettingRow
      title={t("settings.profile.displayName")}
      description={t("settings.profile.displayNameHint")}
    >
      {#snippet control()}
        <form
          class="flex flex-wrap items-center justify-end gap-2"
          onsubmit={(e) => {
            e.preventDefault();
            void saveName();
          }}
        >
          <label class="sr-only" for="settings-display-name">
            {t("settings.profile.displayName")}
          </label>
          <input
            id="settings-display-name"
            class="input input-sm w-56 max-w-full"
            bind:value={nameDraft}
            maxlength={120}
          />
          <button class="btn btn-primary btn-sm" type="submit" disabled={savingName}>
            {t("common.save")}
          </button>
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            disabled={savingName}
            onclick={resetName}
          >
            {t("settings.profile.useIdpName")}
          </button>
        </form>
      {/snippet}
    </SettingRow>
  </SettingsCard>

  <!-- read-only identity rows -->
  <SettingsCard>
    <SettingRow
      title={t("settings.profile.email")}
      description={t("settings.profile.emailManaged")}
    >
      {#snippet control()}
        <span class="text-sm">{auth.user?.email ?? "—"}</span>
      {/snippet}
    </SettingRow>
    <SettingRow title={t("account.signInSection")} description={t("account.oidcNote")}>
      {#snippet control()}
        <span class="text-sm">{t("account.oidc")}</span>
      {/snippet}
    </SettingRow>
    <SettingRow title={t("account.userId")}>
      {#snippet control()}
        <code class="font-mono text-xs text-[var(--text-muted)]">{auth.user?.id}</code>
        <button
          class="btn btn-ghost btn-xs"
          title={t("settings.profile.copyId")}
          aria-label={t("settings.profile.copyId")}
          onclick={copyUserId}
        >
          <Copy class="h-3.5 w-3.5 opacity-70" aria-hidden="true" />
        </button>
      {/snippet}
    </SettingRow>
  </SettingsCard>

  <!-- danger zone (honest stubs, settings.md §2.7) -->
  <SettingsCard heading={t("settings.profile.dangerZone")} tone="danger">
    <SettingRow title={t("settings.profile.signOutOthers")}>
      {#snippet control()}
        <button class="btn btn-sm" disabled>{t("settings.comingSoon")}</button>
      {/snippet}
    </SettingRow>
    <SettingRow
      title={t("settings.profile.deleteAccount")}
      description={t("settings.profile.deleteAccountNote")}
    />
  </SettingsCard>
{/if}
