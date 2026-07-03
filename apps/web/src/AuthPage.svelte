<script lang="ts">
  // The sign-in FALLBACK page, routable at #~login. It is no longer the default
  // gate: a signed-out visitor is sent straight into the server's /auth/login
  // redirect (appGate "redirect") with no interstitial. This page exists so the
  // organization-SSO entry point stays reachable — just the Muesli mark, a short
  // tagline, and the sign-in actions on a clean blank floor.
  //
  // Sign-in is OIDC/SSO only — there is no separate sign-up flow (identity comes
  // wholly from the identity provider, ADR 0012), so we offer "Sign in" (the
  // default OIDC redirect) and "Use organization SSO" (email → the workspace's
  // IdP). The org-SSO path reuses AccountMenu's probe-first flow: an unknown
  // email domain toasts instead of dead-ending on a 404 page. Yjs-free.
  import { t } from "./i18n/index.svelte";
  import { loginUrl, orgLoginUrl } from "./identity";

  // The two faces of the page: the primary sign-in actions, or the org-SSO
  // email form (revealed in place so the page stays a single calm column).
  let mode: "default" | "sso" = $state("default");
  let ssoEmail = $state("");
  let ssoError = $state("");
  let ssoBusy = $state(false);

  /** Probe-first SSO: an unknown email domain shows an inline error rather than
   *  navigating into a 404. A reachable issuer 302s us into the IdP. */
  async function orgSignIn(e: SubmitEvent) {
    e.preventDefault();
    ssoError = "";
    ssoBusy = true;
    const url = orgLoginUrl(ssoEmail.trim());
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status === 404) {
        ssoError = t("account.noSsoForDomain");
        ssoBusy = false;
        return;
      }
    } catch {
      // opaque redirect / network hiccup — let the real navigation decide
    }
    window.location.href = url;
  }

  /** Focus the SSO email field when the form is revealed (a11y-friendly autofocus). */
  function focusInput(node: HTMLInputElement) {
    node.focus();
  }
</script>

<main
  class="flex min-h-screen flex-col items-center justify-center bg-base-200 px-6 text-base-content antialiased"
>
  <div class="flex w-full max-w-sm flex-col items-center gap-6">
    <!-- wordmark IS the mark: lowercase Sentient, like the marketing site -->
    <div class="flex flex-col items-center gap-3">
      <h1 class="wordmark text-6xl leading-none">muesli</h1>
      <p class="max-w-xs text-center text-sm opacity-60" style="text-wrap: balance;">
        {t("auth.tagline")}
      </p>
    </div>

    {#if mode === "default"}
      <div class="flex w-full flex-col gap-2.5">
        <a
          class="btn btn-primary w-full rounded-field transition-transform active:scale-[0.96]"
          href={loginUrl()}
        >
          {t("common.signIn")}
        </a>
        <button
          type="button"
          class="btn btn-ghost w-full rounded-field transition-transform active:scale-[0.96]"
          onclick={() => {
            mode = "sso";
            ssoError = "";
          }}
        >
          {t("auth.signInWithSso")}
        </button>
      </div>
    {:else}
      <form class="flex w-full flex-col gap-2.5" onsubmit={orgSignIn}>
        <p class="text-center text-xs opacity-60" style="text-wrap: pretty;">
          {t("auth.ssoIntro")}
        </p>
        <input
          class="input w-full rounded-field"
          type="email"
          placeholder={t("account.ssoEmailPlaceholder")}
          bind:value={ssoEmail}
          oninput={() => (ssoError = "")}
          required
          use:focusInput
        />
        {#if ssoError}
          <p class="text-center text-xs text-error">{ssoError}</p>
        {/if}
        <button
          class="btn btn-primary w-full rounded-field transition-transform active:scale-[0.96]"
          type="submit"
          disabled={ssoBusy}
        >
          {#if ssoBusy}<span class="loading loading-spinner loading-xs"></span>{/if}
          {t("account.signInWithOrg")}
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm w-full rounded-field transition-transform active:scale-[0.96]"
          onclick={() => {
            mode = "default";
            ssoError = "";
          }}
        >
          {t("auth.backToSignIn")}
        </button>
      </form>
    {/if}
  </div>
</main>
