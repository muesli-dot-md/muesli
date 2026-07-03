<script lang="ts">
  // Settings → Notifications (sub-project ④c). Per-user notification channels for @mentions:
  // both in-app and email are independently toggleable. Each toggle round-trips through
  // PUT /api/notification-preferences via the authenticated `api_request` command. Sign-in
  // required (preferences are server-side and user-scoped). Literal strings (desktop has no
  // i18n). Ported from the webapp NotificationsSection pattern.
  import { workspaces } from '$lib/workspaces.svelte';
  import { createNotificationsApi, type Preference } from '$lib/notifications/notificationsApi';
  import SettingsCard from './SettingsCard.svelte';
  import SettingRow from './SettingRow.svelte';

  let prefs = $state<Preference[]>([]);
  let loaded = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);

  const signedIn = $derived(!!workspaces.identity);
  const inAppMention = $derived(
    prefs.find((p) => p.event_type === 'mention' && p.channel === 'in_app'),
  );
  const emailMention = $derived(
    prefs.find((p) => p.event_type === 'mention' && p.channel === 'email'),
  );

  async function load() {
    error = null;
    try {
      const api = createNotificationsApi(workspaces.activeServer);
      prefs = (await api.getPreferences()).preferences;
    } catch (e) {
      error = `Couldn't load notification settings: ${e}`;
    } finally {
      loaded = true;
    }
  }

  $effect(() => {
    if (signedIn && !loaded) void load();
  });

  async function togglePref(channel: 'in_app' | 'email', enabled: boolean) {
    saving = true;
    error = null;
    // Optimistic; roll back on failure.
    prefs = prefs.map((p) =>
      p.event_type === 'mention' && p.channel === channel ? { ...p, enabled } : p,
    );
    try {
      const api = createNotificationsApi(workspaces.activeServer);
      await api.setPreference('mention', channel, enabled);
    } catch (e) {
      prefs = prefs.map((p) =>
        p.event_type === 'mention' && p.channel === channel ? { ...p, enabled: !enabled } : p,
      );
      error = `Couldn't save that setting: ${e}`;
    } finally {
      saving = false;
    }
  }
</script>

<header class="mb-5">
  <h2 class="text-lg font-semibold tracking-tight">Notifications</h2>
  <p class="mt-1 text-sm text-[var(--text-muted)]" style="text-wrap: pretty;">
    Choose how muesli reaches you when something needs your attention.
  </p>
</header>

{#if !signedIn}
  <SettingsCard>
    <SettingRow
      title="Sign in to manage notifications"
      description="Notifications are available once you sign in to a muesli-server."
    />
  </SettingsCard>
{:else}
  <SettingsCard description="Turn off both channels to stop mention notifications entirely.">
    <SettingRow
      title="In-app inbox"
      description="Show mention notifications in the bell menu. Turn off to stop them."
    >
      {#snippet control()}
        <input
          type="checkbox"
          class="toggle toggle-sm toggle-primary"
          checked={inAppMention?.enabled ?? true}
          disabled={!loaded || saving || inAppMention?.toggleable === false}
          onchange={(e) => togglePref('in_app', e.currentTarget.checked)}
          aria-label="In-app inbox"
        />
      {/snippet}
    </SettingRow>

    <SettingRow
      title="Email me when I'm mentioned"
      description="Send an email when someone @mentions you in a comment."
    >
      {#snippet control()}
        <input
          type="checkbox"
          class="toggle toggle-sm toggle-primary"
          checked={emailMention?.enabled ?? true}
          disabled={!loaded || saving || emailMention?.toggleable === false}
          onchange={(e) => togglePref('email', e.currentTarget.checked)}
          aria-label="Email me when I'm mentioned"
        />
      {/snippet}
    </SettingRow>
  </SettingsCard>
{/if}

{#if error}
  <p class="mt-3 px-1 text-xs text-error">{error}</p>
{/if}
