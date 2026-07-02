<script lang="ts">
  // Drive-style account area, shared by the Home, editor, and settings headers.
  // Signed in: avatar button → identity header · Profile · Settings · theme
  // control · Workspace settings · Sign out. Signed out: Sign in + organization
  // SSO. Open mode (no auth at all): just Settings + theme. Profile/Settings
  // navigate to the full settings page (#~settings/…, settings.md §1) — the old
  // modals are gone. Yjs-free (identity.ts only).
  import CircleUser from "@lucide/svelte/icons/circle-user";
  import LogOut from "@lucide/svelte/icons/log-out";
  import Settings from "@lucide/svelte/icons/settings";
  import User from "@lucide/svelte/icons/user";
  import Users from "@lucide/svelte/icons/users";
  import ThemeModeControl from "./ThemeModeControl.svelte";
  import { t } from "./i18n/index.svelte";
  import { loginUrl, orgLoginUrl, type AuthInfo } from "./identity";
  import { gotoSettings } from "./route.svelte";

  let {
    auth,
    toast,
    onsignout,
    onworkspace,
  }: {
    auth: AuthInfo;
    toast: (msg: string, kind?: "info" | "warning") => void;
    onsignout: () => void | Promise<void>;
    /** Opens the host's WorkspacePanel modal (Home/editor headers own its state).
     *  Omitted in the settings header, where it routes to the workspace settings
     *  pages instead of opening the legacy modal. */
    onworkspace?: () => void;
  } = $props();

  /** Workspace settings: open the host modal when given, else go to the page. */
  const openWorkspace = () => (onworkspace ? onworkspace() : gotoSettings("general"));

  let ssoEmail = $state("");

  const initial = $derived(
    (auth.user?.display_name ?? auth.user?.email ?? "?").trim().charAt(0).toUpperCase(),
  );

  /** Close the CSS-only dropdown before acting (same blur trick as before). */
  function item(e: MouseEvent, action: () => void) {
    (e.currentTarget as HTMLElement).blur();
    action();
  }

  /** Probe-first SSO flow: unknown email domain → toast, not a dead-end page. */
  async function orgSignIn(e: SubmitEvent) {
    e.preventDefault();
    const url = orgLoginUrl(ssoEmail.trim());
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status === 404) {
        toast(t("account.noSsoForDomain"), "warning");
        return;
      }
    } catch {
      // opaque redirect / network hiccup — let the real navigation decide
    }
    window.location.href = url;
  }
</script>

{#snippet avatar(cls: string)}
  {#if auth.user?.avatar_url}
    <img src={auth.user.avatar_url} alt="" class="{cls} rounded-full object-cover" />
  {:else}
    <span
      class="{cls} flex items-center justify-center rounded-full bg-primary font-semibold text-primary-content"
    >
      {initial}
    </span>
  {/if}
{/snippet}

{#if auth.mode === "oidc"}
  {#if auth.user}
    <div class="dropdown dropdown-end">
      <!-- The visible circle matches the + New button's 40px height exactly
           (control-dimension consistency); hover feedback is a ring, not padding.
           div trigger, not <button>: Safari/Firefox don't focus buttons on click,
           and daisyUI dropdowns open via :focus-within -->
      <div
        tabindex="0"
        role="button"
        class="btn btn-circle btn-ghost h-10 w-10 p-0 hover:ring-4 hover:ring-base-300/70"
        title={auth.user.email ?? auth.user.display_name ?? t("account.title")}
      >
        {@render avatar("h-10 w-10 text-sm")}
      </div>
      <div
        class="dropdown-content z-20 mt-1 w-64 rounded-box border border-base-300 bg-base-100 p-2 shadow"
      >
        <div class="flex items-center gap-3 px-3 py-2">
          {@render avatar("h-9 w-9 shrink-0 text-base")}
          <div class="min-w-0">
            <p class="truncate text-sm font-medium">{auth.user.display_name ?? "—"}</p>
            {#if auth.user.email}
              <p class="truncate text-xs opacity-60">{auth.user.email}</p>
            {/if}
          </div>
        </div>
        <button
          class="btn btn-ghost btn-sm w-full justify-start gap-2"
          onclick={(e) => item(e, () => gotoSettings("profile"))}
        >
          <User class="h-4 w-4 opacity-70" aria-hidden="true" />
          {t("account.profile")}
        </button>
        <button
          class="btn btn-ghost btn-sm w-full justify-start gap-2"
          onclick={(e) => item(e, () => gotoSettings())}
        >
          <Settings class="h-4 w-4 opacity-70" aria-hidden="true" />
          {t("common.settings")}
        </button>
        <div class="px-3 py-2">
          <ThemeModeControl />
        </div>
        <button
          class="btn btn-ghost btn-sm w-full justify-start gap-2"
          onclick={(e) => item(e, openWorkspace)}
        >
          <Users class="h-4 w-4 opacity-70" aria-hidden="true" />
          {t("ws.title")}
        </button>
        <button
          class="btn btn-ghost btn-sm w-full justify-start gap-2"
          onclick={() => void onsignout()}
        >
          <LogOut class="h-4 w-4 opacity-70" aria-hidden="true" />
          {t("account.signOut")}
        </button>
      </div>
    </div>
  {:else}
    <a class="btn btn-primary btn-sm" href={loginUrl()}>{t("common.signIn")}</a>
    <div class="dropdown dropdown-end">
      <div tabindex="0" role="button" class="btn btn-ghost btn-sm">{t("account.useOrgSso")}</div>
      <div
        class="dropdown-content z-20 mt-1 w-72 rounded-box border border-base-300 bg-base-100 p-3 shadow"
      >
        <form class="flex flex-col gap-2" onsubmit={orgSignIn}>
          <input
            class="input input-sm w-full"
            type="email"
            placeholder={t("account.ssoEmailPlaceholder")}
            bind:value={ssoEmail}
            required
          />
          <button class="btn btn-sm btn-primary" type="submit">
            {t("account.signInWithOrg")}
          </button>
        </form>
      </div>
    </div>
  {/if}
{:else}
  <!-- open mode: no identity, but Settings (theme, default view, language) still apply -->
  <div class="dropdown dropdown-end">
    <div tabindex="0" role="button" class="btn btn-circle btn-ghost" title={t("common.settings")}>
      <CircleUser class="h-6 w-6 opacity-70" aria-hidden="true" />
    </div>
    <div
      class="dropdown-content z-20 mt-1 w-64 rounded-box border border-base-300 bg-base-100 p-2 shadow"
    >
      <button
        class="btn btn-ghost btn-sm w-full justify-start gap-2"
        onclick={(e) => item(e, () => gotoSettings("preferences"))}
      >
        <Settings class="h-4 w-4 opacity-70" aria-hidden="true" />
        {t("common.settings")}
      </button>
      <div class="px-3 py-2">
        <ThemeModeControl />
      </div>
    </div>
  </div>
{/if}
