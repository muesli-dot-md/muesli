// Settings → About: app metadata, automatic updates, and the server
// connection. The server-URL field lives here since the Sync page was removed
// (sync is always on while signed in to a server-linked workspace, so there
// is nothing else to configure). A change takes effect immediately: the
// refresh() below re-resolves identity (the sync gate + presence identity)
// against the new server, and a live legacy editor session remounts at once
// because EditorPane's mount effect reads settings.wsBase.
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { displayUrl, normalizeServerInput } from "@/services/signInServer";
import { settingsStore, useSettings } from "@/state/settings";
import { workspacesStore } from "@/state/workspaces";
import { SettingsCard } from "./SettingsCard";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

interface Props {
  appVersion: string;
}

export function AboutSection({ appVersion }: Props) {
  const wsBase = useSettings((s: { wsBase: string }) => s.wsBase);
  const autoUpdate = useSettings((s: { autoUpdate: boolean }) => s.autoUpdate);

  function commitServerUrl(el: HTMLInputElement) {
    // Shows/accepts the plain-URL form (displayUrl); saves go through the
    // same normalizer as the sign-in dialog, so the ws parts never surface
    // here and un-normalized values never reach settings. Invalid input
    // reverts the field to the stored value.
    const normalized = normalizeServerInput(el.value);
    if (normalized !== null) {
      settingsStore.getState().setWsBase(normalized);
      // Re-resolve identity + the workspace list against the new server NOW —
      // otherwise the old server's identity keeps driving the sync gate and
      // presence until the next refresh().
      void workspacesStore.getState().refresh();
    } else {
      el.value = displayUrl(settingsStore.getState().wsBase);
    }
  }

  return (
    <SettingsSection title="About">
      <SettingsCard>
        <SettingsRow title="App" control={<span className="text-sm">Muesli</span>} />
        <SettingsRow
          title="Version"
          control={
            <span className="font-mono text-xs tabular-nums">{appVersion}</span>
          }
        />
      </SettingsCard>

      <SettingsCard heading="Updates">
        <SettingsRow
          title="Automatic updates"
          description="Download updates in the background and offer a restart when ready."
          control={
            <Switch
              checked={autoUpdate}
              onCheckedChange={(checked: boolean) =>
                settingsStore.getState().setAutoUpdate(checked)
              }
              aria-label="Automatic updates"
            />
          }
        />
      </SettingsCard>

      {/* Server: the muesli-server endpoint this app signs in to and syncs with. */}
      <SettingsCard heading="Server">
        <SettingsRow
          title="Server URL"
          description="The muesli-server this app signs in to and syncs with."
          stacked
          control={
            <Input
              key={wsBase}
              type="text"
              className="w-full"
              placeholder="https://muesli.example.com"
              defaultValue={displayUrl(wsBase)}
              onBlur={(e) => commitServerUrl(e.currentTarget)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitServerUrl(e.currentTarget);
                }
              }}
              aria-label="Server URL"
            />
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
