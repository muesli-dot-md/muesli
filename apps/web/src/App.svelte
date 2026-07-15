<script lang="ts">
  // Router shell. The reactive hash route picks the view: the editor for a doc
  // slug, the 404 page for a dead reserved route, otherwise the Home shell — which
  // covers both the home routes ('' / 'f/…' / '~recent' / '~trash') AND
  // '~settings/…' (Home renders the embedded Settings view in its main panel, so
  // the workspaces sidebar persists rather than being a full-page takeover).
  // DocApp is imported dynamically so the home screen never loads yjs; once
  // loaded, switches are pure component swaps (no reload). The {#key} remounts
  // DocApp per doc, which opens/destroys one collab session.
  import AuthPage from "./AuthPage.svelte";
  import ErrorPage from "./ErrorPage.svelte";
  import Home from "./Home.svelte";
  import NotFound from "./NotFound.svelte";
  import SearchPalette from "./SearchPalette.svelte";
  import { t } from "./i18n/index.svelte";
  // Self-applying accent store (item 2): pushes the chosen accent onto the
  // document root on boot so the gray default (or the user's pick) is live
  // everywhere, not only after visiting Settings.
  import "./accent.svelte";
  // Self-applying background tint + folder color stores (desktop parity):
  // push the persisted CSS vars on boot, like the accent above.
  import "./background.svelte";
  import "./folderColor.svelte";
  // Per-user appearance sync (GET/PATCH /api/me/prefs): dormant until
  // authSession resolves a signed-in user, purely local otherwise.
  import "./prefsSync.svelte";
  import { decideAppView } from "./appGate";
  import { authSession } from "./authSession.svelte";
  import { loginUrl } from "./identity";
  import { route } from "./route.svelte";

  const doc = $derived(route.current.kind === "doc" ? route.current : null);

  // Top-level gate (Commit 1): a signed-out OIDC visitor is sent STRAIGHT into
  // the server's /auth/login redirect (no interstitial, no extra click) — UNLESS
  // they're opening a shared doc via a ?share=<token> link, which stays a
  // guest-accessible "app" view, or they explicitly visited #~login, the
  // routable sign-in fallback / organization-SSO chooser (AuthPage). Open mode
  // and signed-in users always see the real app.
  const view = $derived(decideAppView(route.current, authSession.current));

  $effect(() => {
    // "redirect" is a full-page navigation into the IdP; the splash below stays
    // on screen until the browser leaves.
    if (view === "redirect") window.location.href = loginUrl();
  });
</script>

{#if view === "loading" || view === "redirect"}
  <!-- /api/me in flight, or handing off to the IdP: a calm blank floor. -->
  <div class="flex min-h-screen items-center justify-center bg-[var(--floor)]">
    <span class="loading loading-spinner loading-lg opacity-40"></span>
  </div>
{:else if view === "auth"}
  <AuthPage />
{:else}
  <!-- Generic error boundary (Commit 2): a render/runtime crash anywhere in the
       routed view shows a friendly "Something went wrong" page with a reload,
       instead of a white-screen crash or a raw stack trace. -->
  <svelte:boundary>
    {#if route.current.kind === "notfound"}
      <NotFound kind="page" />
    {:else if doc}
      {#await import("./DocApp.svelte") then { default: DocApp }}
        {#key `${doc.docId} ${doc.shareToken ?? ""}`}
          <DocApp docId={doc.docId} shareToken={doc.shareToken} />
        {/key}
      {/await}
    {:else}
      <!-- The home and settings routes share one persistent shell: Home owns the
           workspaces sidebar and swaps its main panel between the document
           browser and the embedded Settings view (so settings is no longer a
           full-page takeover — the sidebar stays put). -->
      <Home />
    {/if}

    {#snippet failed(_error, reset)}
      <ErrorPage
        title={t("error.genericTitle")}
        message={t("error.genericBody")}
        action="reload"
        onaction={reset}
      />
    {/snippet}
  </svelte:boundary>
{/if}

<!-- Mounted across the real app (home AND editor): owns the ⌘K / Ctrl+K and '/'
     shortcuts. Skipped on the auth/loading shells, which have nothing to search. -->
{#if view === "app"}
  <SearchPalette />
{/if}
