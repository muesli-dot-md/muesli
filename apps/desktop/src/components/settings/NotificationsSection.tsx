// Settings → Notifications: per-user notification channels for @mentions —
// both in-app and email are independently toggleable. Each toggle round-trips
// through PUT /api/notification-preferences via the authenticated
// `api_request` command (optimistic, rolled back on failure). Sign-in
// required (preferences are server-side and user-scoped).
import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import {
  createNotificationsApi,
  type Preference,
} from "@/services/notifications/notificationsApi";
import type { Identity } from "@/services/tauri";
import { useWorkspaces, workspacesStore } from "@/state/workspaces";
import { SettingsCard } from "./SettingsCard";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

export function NotificationsSection() {
  const identity = useWorkspaces(
    (s: { identity: Identity | null }) => s.identity,
  );
  const signedIn = !!identity;

  const [prefs, setPrefs] = useState<Preference[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inAppMention = prefs.find(
    (p) => p.event_type === "mention" && p.channel === "in_app",
  );
  const emailMention = prefs.find(
    (p) => p.event_type === "mention" && p.channel === "email",
  );

  useEffect(() => {
    if (!signedIn || loaded) return;
    let cancelled = false;
    (async () => {
      setError(null);
      try {
        const server: string = workspacesStore.getState().activeServer;
        const api = createNotificationsApi(server);
        const r = await api.getPreferences();
        if (!cancelled) setPrefs(r.preferences);
      } catch (e) {
        if (!cancelled) setError(`Couldn't load notification settings: ${e}`);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn, loaded]);

  async function togglePref(channel: "in_app" | "email", enabled: boolean) {
    setSaving(true);
    setError(null);
    // Optimistic; roll back on failure.
    setPrefs((prev) =>
      prev.map((p) =>
        p.event_type === "mention" && p.channel === channel
          ? { ...p, enabled }
          : p,
      ),
    );
    try {
      const server: string = workspacesStore.getState().activeServer;
      const api = createNotificationsApi(server);
      await api.setPreference("mention", channel, enabled);
    } catch (e) {
      setPrefs((prev) =>
        prev.map((p) =>
          p.event_type === "mention" && p.channel === channel
            ? { ...p, enabled: !enabled }
            : p,
        ),
      );
      setError(`Couldn't save that setting: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection
      title="Notifications"
      description="Choose how muesli reaches you when something needs your attention."
    >
      {!signedIn ? (
        <SettingsCard>
          <SettingsRow
            title="Sign in to manage notifications"
            description="Notifications are available once you sign in to a muesli-server."
          />
        </SettingsCard>
      ) : (
        <SettingsCard description="Turn off both channels to stop mention notifications entirely.">
          <SettingsRow
            title="In-app inbox"
            description="Show mention notifications in the bell menu. Turn off to stop them."
            control={
              <Switch
                checked={inAppMention?.enabled ?? true}
                disabled={!loaded || saving || inAppMention?.toggleable === false}
                onCheckedChange={(checked: boolean) =>
                  void togglePref("in_app", checked)
                }
                aria-label="In-app inbox"
              />
            }
          />

          <SettingsRow
            title="Email me when I'm mentioned"
            description="Send an email when someone @mentions you in a comment."
            control={
              <Switch
                checked={emailMention?.enabled ?? true}
                disabled={!loaded || saving || emailMention?.toggleable === false}
                onCheckedChange={(checked: boolean) =>
                  void togglePref("email", checked)
                }
                aria-label="Email me when I'm mentioned"
              />
            }
          />
        </SettingsCard>
      )}

      {error ? (
        <p className="mt-3 px-1 text-xs text-destructive">{error}</p>
      ) : null}
    </SettingsSection>
  );
}
