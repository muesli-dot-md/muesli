<script lang="ts">
  // Settings → Notifications (sub-project ④c). Per-user notification channels for @mentions:
  // both in-app and email are independently toggleable. Each toggle round-trips through
  // PUT /api/notification-preferences. Auth-only (open mode shows a sign-in nudge, like
  // ProfileSection).
  import { t } from "../i18n/index.svelte";
  import { httpBase, type AuthInfo } from "../identity";
  import { createNotificationsApi, type Preference } from "../notificationsApi";
  import SettingRow from "./SettingRow.svelte";
  import SettingsCard from "./SettingsCard.svelte";

  let { auth, toast }: { auth: AuthInfo; toast: (msg: string, kind?: "info" | "warning") => void } =
    $props();

  const api = createNotificationsApi({ httpBase });

  let prefs: Preference[] = $state([]);
  let loaded = $state(false);
  let saving = $state(false);

  // The mention preferences per channel; undefined until loaded.
  const inAppMention = $derived(
    prefs.find((p) => p.event_type === "mention" && p.channel === "in_app"),
  );
  const emailMention = $derived(
    prefs.find((p) => p.event_type === "mention" && p.channel === "email"),
  );

  async function load() {
    try {
      prefs = (await api.getPreferences()).preferences;
    } catch {
      toast(t("settings.notifications.loadFailed"), "warning");
    } finally {
      loaded = true;
    }
  }

  $effect(() => {
    if (auth.mode === "oidc" && auth.user && !loaded) void load();
  });

  async function togglePref(channel: "in_app" | "email", enabled: boolean) {
    saving = true;
    // Optimistic: reflect the new value immediately, roll back on failure.
    prefs = prefs.map((p) =>
      p.event_type === "mention" && p.channel === channel ? { ...p, enabled } : p,
    );
    try {
      await api.setPreference("mention", channel, enabled);
      toast(t("settings.notifications.saved"));
    } catch {
      prefs = prefs.map((p) =>
        p.event_type === "mention" && p.channel === channel ? { ...p, enabled: !enabled } : p,
      );
      toast(t("settings.notifications.saveFailed"), "warning");
    } finally {
      saving = false;
    }
  }
</script>

<header class="mb-5">
  <h2 class="text-lg font-semibold tracking-tight">{t("settings.notifications")}</h2>
  <p class="mt-1 text-sm text-[var(--text-muted)]" style="text-wrap: pretty;">
    {t("settings.notifications.intro")}
  </p>
</header>

{#if auth.mode === "open"}
  <SettingsCard>
    <SettingRow
      title={t("settings.notifications.signedOutTitle")}
      description={t("settings.notifications.signedOutBody")}
    />
  </SettingsCard>
{:else}
  <SettingsCard description={t("settings.notifications.cardNote")}>
    <SettingRow
      title={t("settings.notifications.inApp")}
      description={t("settings.notifications.inAppNote")}
    >
      {#snippet control()}
        <input
          type="checkbox"
          class="toggle toggle-sm toggle-primary"
          checked={inAppMention?.enabled ?? true}
          disabled={!loaded || saving || inAppMention?.toggleable === false}
          onchange={(e) => togglePref("in_app", e.currentTarget.checked)}
          aria-label={t("settings.notifications.inApp")}
        />
      {/snippet}
    </SettingRow>

    <SettingRow
      title={t("settings.notifications.emailMention")}
      description={t("settings.notifications.emailMentionNote")}
    >
      {#snippet control()}
        <input
          type="checkbox"
          class="toggle toggle-sm toggle-primary"
          checked={emailMention?.enabled ?? true}
          disabled={!loaded || saving || emailMention?.toggleable === false}
          onchange={(e) => togglePref("email", e.currentTarget.checked)}
          aria-label={t("settings.notifications.emailMention")}
        />
      {/snippet}
    </SettingRow>
  </SettingsCard>
{/if}
