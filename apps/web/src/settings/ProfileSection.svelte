<script lang="ts">
  // Settings → Profile (settings.md §2.1): avatar + display-name OVERRIDES
  // (PATCH /api/me writes the custom_* columns, never the OIDC claim columns),
  // the read-only email row, and the danger-zone
  // stubs. The avatar never touches blob storage: it is cover-cropped and
  // resized to 128px on a canvas and sent as a ≤64 KB data URL. Picking an
  // avatar PATCHes immediately — there is no local preview state that a
  // closed settings page could silently discard.
  import { createAccountApi, type AccountUser } from "../accountApi";
  import { errMsg } from "../apiError";
  import { t } from "../i18n/index.svelte";
  import { httpBase, loginUrl, type AuthInfo } from "../identity";
  import { resizeToDataUrl } from "./avatarResize";
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
  let fileInput: HTMLInputElement | undefined = $state();

  // PATCH /api/me answers a FULL user snapshot, and a name save can interleave
  // with an avatar pick — if the earlier-issued response lands last, applying
  // it would revert the newer change on screen (and in the host via onupdated).
  // Invariant: only the response of the LATEST-issued PATCH is applied and
  // forwarded; stale resolutions return null and callers skip local state.
  let patchSeq = 0;
  async function patch(body: {
    display_name?: string | null;
    avatar_url?: string | null;
  }): Promise<AccountUser | null> {
    const seq = ++patchSeq;
    const user = await api.patchMe(body);
    if (seq !== patchSeq) return null;
    onupdated(user);
    return user;
  }

  async function saveName() {
    savingName = true;
    try {
      const trimmed = nameDraft.trim();
      const user = await patch({ display_name: trimmed === "" ? null : trimmed });
      if (user) nameDraft = user.display_name ?? "";
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
      if (user) nameDraft = user.display_name ?? "";
      toast(t("settings.profile.saved"));
    } catch (e) {
      toast(errMsg(e), "warning");
    } finally {
      savingName = false;
    }
  }

  /** Picking a file saves it right away: a picked avatar that only lived in
   *  component state until a separate Save click was silently discarded when
   *  settings closed — the PATCH must be the moment the pick takes effect. */
  async function pickAvatar(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // re-picking the same file must fire change again
    if (!file) return;
    savingAvatar = true;
    try {
      await patch({ avatar_url: await resizeToDataUrl(file) });
      toast(t("settings.profile.saved"));
    } catch (err) {
      toast(errMsg(err), "warning");
    } finally {
      savingAvatar = false;
    }
  }

  async function removeAvatar() {
    savingAvatar = true;
    try {
      await patch({ avatar_url: null });
      toast(t("settings.profile.saved"));
    } catch (e) {
      toast(errMsg(e), "warning");
    } finally {
      savingAvatar = false;
    }
  }

  const shownAvatar = $derived(auth.user?.avatar_url ?? null);
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
    <SettingRow title={t("settings.profile.changeAvatar")}>
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
        <button class="btn btn-sm" disabled={savingAvatar} onclick={() => fileInput?.click()}>
          {t("settings.profile.changeAvatar")}
        </button>
        {#if auth.user?.avatar_url}
          <button class="btn btn-ghost btn-sm" disabled={savingAvatar} onclick={removeAvatar}>
            {t("settings.profile.removeAvatar")}
          </button>
        {/if}
      {/snippet}
    </SettingRow>

    <!-- display name -->
    <SettingRow title={t("settings.profile.displayName")}>
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

  <!-- read-only identity row -->
  <SettingsCard>
    <SettingRow
      title={t("settings.profile.email")}
      description={t("settings.profile.emailManaged")}
    >
      {#snippet control()}
        <span class="text-sm">{auth.user?.email ?? "—"}</span>
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
