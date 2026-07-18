// Settings → Notifications (sub-project ④c). Per-user notification channels
// for @mentions: both in-app and email are independently toggleable. Each
// toggle round-trips through PUT /api/notification-preferences. Auth-only
// (open mode shows a sign-in nudge, like ProfileSection). React port of the
// web settings/NotificationsSection.svelte.
import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { createNotificationsApi, type Preference } from "@/services/notificationsApi";
import { httpBase, type AuthInfo } from "@/services/identity";
import { useT } from "@/state/i18n";
import { SettingsCard } from "./SettingsCard";
import { SettingsRow } from "./SettingsRow";

interface Props {
  auth: AuthInfo;
  toast: (msg: string, kind?: "info" | "warning") => void;
}

const api = createNotificationsApi({ httpBase });

export function NotificationsSection({ auth, toast }: Props) {
  const t = useT();

  const [prefs, setPrefs] = useState<Preference[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  // The mention preferences per channel; undefined until loaded.
  const inAppMention = prefs.find(
    (p) => p.event_type === "mention" && p.channel === "in_app",
  );
  const emailMention = prefs.find(
    (p) => p.event_type === "mention" && p.channel === "email",
  );

  useEffect(() => {
    if (!(auth.mode === "oidc" && auth.user) || loaded) return;
    let cancelled = false;
    api
      .getPreferences()
      .then((res) => {
        if (!cancelled) setPrefs(res.preferences);
      })
      .catch(() => {
        if (!cancelled) toast(t("settings.notifications.loadFailed"), "warning");
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.mode, auth.user, loaded]);

  async function togglePref(channel: "in_app" | "email", enabled: boolean) {
    setSaving(true);
    // Optimistic: reflect the new value immediately, roll back on failure.
    setPrefs((cur) =>
      cur.map((p) =>
        p.event_type === "mention" && p.channel === channel ? { ...p, enabled } : p,
      ),
    );
    try {
      await api.setPreference("mention", channel, enabled);
      toast(t("settings.notifications.saved"));
    } catch {
      setPrefs((cur) =>
        cur.map((p) =>
          p.event_type === "mention" && p.channel === channel
            ? { ...p, enabled: !enabled }
            : p,
        ),
      );
      toast(t("settings.notifications.saveFailed"), "warning");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <header className="mb-5">
        <h2 className="text-lg font-semibold tracking-tight">
          {t("settings.notifications")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground [text-wrap:pretty]">
          {t("settings.notifications.intro")}
        </p>
      </header>

      {auth.mode === "open" ? (
        <SettingsCard>
          <SettingsRow
            title={t("settings.notifications.signedOutTitle")}
            description={t("settings.notifications.signedOutBody")}
          />
        </SettingsCard>
      ) : (
        <SettingsCard description={t("settings.notifications.cardNote")}>
          <SettingsRow
            title={t("settings.notifications.inApp")}
            description={t("settings.notifications.inAppNote")}
            control={
              <Switch
                checked={inAppMention?.enabled ?? true}
                disabled={!loaded || saving || inAppMention?.toggleable === false}
                onCheckedChange={(checked: boolean) => void togglePref("in_app", checked)}
                aria-label={t("settings.notifications.inApp")}
              />
            }
          />

          <SettingsRow
            title={t("settings.notifications.emailMention")}
            description={t("settings.notifications.emailMentionNote")}
            control={
              <Switch
                checked={emailMention?.enabled ?? true}
                disabled={!loaded || saving || emailMention?.toggleable === false}
                onCheckedChange={(checked: boolean) => void togglePref("email", checked)}
                aria-label={t("settings.notifications.emailMention")}
              />
            }
          />
        </SettingsCard>
      )}
    </>
  );
}

export default NotificationsSection;
