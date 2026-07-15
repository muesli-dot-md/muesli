<script lang="ts">
  // Settings → Profile (My Account): the desktop's sync identity. Mirrors the
  // webapp's Profile page (avatar + read-only identity rows), but the desktop has
  // no PATCH /api/me, so every field is read-only. The identity comes from the
  // muesli-server we're signed in to (workspaces.identity); when signed out /
  // local-only we say so honestly and offer sign-in. Literal strings (no i18n).
  import { Copy } from "lucide-svelte";
  import { isSignedIn } from "$lib/tauri";
  import { workspaces } from "$lib/workspaces.svelte";
  import SettingsCard from "./SettingsCard.svelte";
  import SettingRow from "./SettingRow.svelte";

  const identity = $derived(workspaces.identity);
  // A signed-in OIDC user (has a name/email/avatar, or at least a "sub" claim,
  // to show). Open-mode servers and signed-out states get their own honest
  // empty states below. Shared with SyncSection's read-only summary so the
  // two surfaces can't disagree about whether the user is signed in.
  const signedIn = $derived(isSignedIn(identity));
  const shownAvatar = $derived(identity?.avatar_url ?? null);
  const initial = $derived(
    (identity?.display_name ?? identity?.email ?? "?").trim().charAt(0).toUpperCase(),
  );

  let copied = $state(false);
  async function copyUserId() {
    if (!identity?.id) return;
    try {
      await navigator.clipboard.writeText(identity.id);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard blocked — nothing to surface here.
    }
  }
</script>

<header class="mb-5">
  <h2 class="text-lg font-semibold tracking-tight">Profile</h2>
  <p class="mt-1 text-sm text-[var(--text-muted)]" style="text-wrap: pretty;">
    Your identity on the connected muesli-server. Manage it from the server.
  </p>
</header>

{#if identity?.mode === "open"}
  <SettingsCard>
    <SettingRow
      title="Open server — no account"
      description="This server doesn't require sign-in, so there's no profile to manage. Files sync without an identity."
    />
  </SettingsCard>
{:else if !signedIn}
  <SettingsCard>
    <SettingRow
      title="Not signed in"
      description="Sign in to a muesli-server to load your profile and sync your workspaces."
    >
      {#snippet control()}
        <button class="btn btn-primary btn-sm" onclick={() => workspaces.login()}>Sign in…</button>
      {/snippet}
    </SettingRow>
  </SettingsCard>
{:else}
  <!-- identity card: avatar + display name. Sign-out lives here (the primary
       account flow) rather than duplicated in Sync settings. -->
  <SettingsCard>
    <SettingRow
      title={identity?.display_name ?? "Signed in"}
      description={identity?.email ?? undefined}
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
        <button class="btn btn-ghost btn-sm" onclick={() => workspaces.logout()}>Sign out</button>
      {/snippet}
    </SettingRow>
  </SettingsCard>

  <!-- read-only identity rows -->
  <SettingsCard>
    <SettingRow title="Email" description="Managed by your identity provider.">
      {#snippet control()}
        <span class="text-sm">{identity?.email ?? "—"}</span>
      {/snippet}
    </SettingRow>
    <SettingRow title="Display name">
      {#snippet control()}
        <span class="text-sm">{identity?.display_name ?? "—"}</span>
      {/snippet}
    </SettingRow>
    <SettingRow
      title="Sign-in"
      description="You're signed in through your server's identity provider."
    >
      {#snippet control()}
        <span class="text-sm">{identity?.mode === "oidc" ? "Single sign-on" : "Server"}</span>
      {/snippet}
    </SettingRow>
    {#if identity?.id}
      <SettingRow title="User ID">
        {#snippet control()}
          <code class="font-mono text-xs text-[var(--text-muted)]">{identity.id}</code>
          <button
            class="btn btn-ghost btn-xs"
            title={copied ? "Copied" : "Copy user ID"}
            aria-label="Copy user ID"
            onclick={copyUserId}
          >
            <Copy size={14} class="opacity-70" aria-hidden="true" />
          </button>
        {/snippet}
      </SettingRow>
    {/if}
  </SettingsCard>
{/if}

{#if workspaces.error}
  <p class="mt-3 px-1 text-xs text-error">{workspaces.error}</p>
{/if}
