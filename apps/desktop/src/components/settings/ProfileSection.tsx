// Settings → Profile (My Account): the desktop's sync identity. Mirrors the
// webapp's Profile page (avatar + read-only identity rows), but the desktop
// has no PATCH /api/me, so every field is read-only. The identity comes from
// the muesli-server we're signed in to (workspaces.identity); when signed
// out / local-only we say so honestly and offer sign-in.
import { useState } from "react";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isSignedIn, type Identity } from "@/services/tauri";
import { useWorkspaces, workspacesStore } from "@/state/workspaces";
import { SettingsCard } from "./SettingsCard";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

export function ProfileSection() {
  const identity = useWorkspaces((s: { identity: Identity | null }) => s.identity);
  const error = useWorkspaces((s: { error: string | null }) => s.error);

  // A signed-in OIDC user (has a name/email/avatar, or at least a "sub"
  // claim, to show). Open-mode servers and signed-out states get their own
  // honest empty states below. `isSignedIn` is a UI predicate only — the sync
  // gate is workspaces.identity + workspace linkage (activeLinked).
  const signedIn = isSignedIn(identity);
  const shownAvatar = identity?.avatar_url ?? null;
  const initial = (identity?.display_name ?? identity?.email ?? "?").trim().charAt(0).toUpperCase();

  const [copied, setCopied] = useState(false);
  async function copyUserId() {
    if (!identity?.id) return;
    try {
      await navigator.clipboard.writeText(identity.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked — nothing to surface here.
    }
  }

  return (
    <SettingsSection
      title="Profile"
      description="Your identity on the connected muesli-server. Manage it from the server."
    >
      {identity?.mode === "open" ? (
        <SettingsCard>
          <SettingsRow
            title="Open server — no account"
            description="This server doesn't require sign-in, so there's no profile to manage. Files sync without an identity."
          />
        </SettingsCard>
      ) : !signedIn ? (
        <SettingsCard>
          <SettingsRow
            title="Not signed in"
            description="Sign in to a muesli-server to load your profile and sync your workspaces."
            control={
              <Button variant="brand" size="sm" onClick={() => workspacesStore.getState().login()}>
                Sign in…
              </Button>
            }
          />
        </SettingsCard>
      ) : (
        <>
          {/* identity card: avatar + display name. Sign-out lives here (the
              primary account flow) and nowhere else in Settings. */}
          <SettingsCard>
            <SettingsRow
              title={identity?.display_name ?? "Signed in"}
              description={identity?.email ?? undefined}
              leading={
                shownAvatar ? (
                  <img src={shownAvatar} alt="" className="h-14 w-14 rounded-full object-cover" />
                ) : (
                  <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary text-2xl font-semibold text-primary-foreground">
                    {initial}
                  </span>
                )
              }
              control={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => workspacesStore.getState().logout()}
                >
                  Sign out
                </Button>
              }
            />
          </SettingsCard>

          {/* read-only identity rows */}
          <SettingsCard>
            <SettingsRow
              title="Email"
              description="Managed by your identity provider."
              control={<span className="text-sm">{identity?.email ?? "—"}</span>}
            />
            <SettingsRow
              title="Display name"
              control={<span className="text-sm">{identity?.display_name ?? "—"}</span>}
            />
            {identity?.id ? (
              <SettingsRow
                title="User ID"
                control={
                  <>
                    <code className="font-mono text-xs text-muted-foreground">{identity.id}</code>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title={copied ? "Copied" : "Copy user ID"}
                      aria-label="Copy user ID"
                      onClick={copyUserId}
                    >
                      <Copy className="opacity-70" aria-hidden="true" />
                    </Button>
                  </>
                }
              />
            ) : null}
          </SettingsCard>
        </>
      )}

      {error ? <p className="mt-3 px-1 text-xs text-destructive">{error}</p> : null}
    </SettingsSection>
  );
}
