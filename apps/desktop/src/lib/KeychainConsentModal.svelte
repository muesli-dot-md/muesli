<script lang="ts">
  // macOS keychain-consent explainer (spec 2026-07-02 §4): shown when the user
  // initiates a sign-in, BEFORE any keyring touch, so the OS Keychain
  // permission prompt never surprises them (launch never shows this — spec
  // Decisions §3). Desktop-only — deliberately NOT in the shared
  // workspace-setup package (the web app has no keychain). Plain English copy,
  // matching what desktop onboarding displays (the desktop has no i18n
  // catalog; it uses the shared package's built-in EN the same way). No
  // checkbox, no "don't ask again": declining simply re-asks at the next
  // sign-in.
  let { ongrant, ondecline }: { ongrant: () => void; ondecline: () => void } = $props();

  // Answer at most once per mount (Escape + click races), like OnboardingFlow.
  let answered = $state(false);

  function grant() {
    if (answered) return;
    answered = true;
    ongrant();
  }

  function decline() {
    if (answered) return;
    answered = true;
    ondecline();
  }

  // Escape = "Not now". preventDefault also stands the keymap fallback down
  // when listener order happens to favor us; the real protection is the
  // keychainConsent state guard in escapeFallbackTarget (see keymap.ts).
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      decline();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Same overlay chrome as the onboarding flow in AppShell (both vertically
     centered). Deliberately NO backdrop close: dismissing IS "Not now"
     (Escape or the link). -->
<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
  <div
    class="mx-4 flex max-h-[78vh] w-full max-w-xl flex-col gap-3 overflow-y-auto p-5"
    style="background: var(--overlay); box-shadow: var(--shadow-overlay); border-radius: var(--radius-overlay, 0.875rem);"
    role="dialog"
    aria-modal="true"
    aria-label="Muesli uses your Mac's Keychain"
  >
    <h3 class="text-lg font-semibold">Muesli uses your Mac's Keychain</h3>
    <p class="text-sm text-base-content/70" style="text-wrap: pretty;">
      To keep you signed in, Muesli saves your login token in the macOS Keychain, the same protected
      store as your passwords. macOS may ask you for permission. Muesli can only reach its own
      entry, never your passwords, and stores nothing else there. Your token goes only to the server
      you sign in to, and Muesli is open source, so you can verify this yourself.
    </p>
    <div class="mt-2 flex items-center justify-between">
      <button class="consent-skip" type="button" onclick={decline}>Not now</button>
      <button class="btn btn-primary" type="button" onclick={grant}>Continue</button>
    </div>
  </div>
</div>

<style>
  /* Same look as the shared wizard's .mws-skip (a plain text link, NOT a .btn —
     host apps re-skin .btn globally). Copied rather than reused so this
     desktop-only modal doesn't depend on wizard.css having been loaded by
     another component. */
  .consent-skip {
    appearance: none;
    background: none;
    border: 0;
    padding: 0.25rem 0;
    font-size: 0.875rem;
    color: color-mix(in oklch, currentColor 55%, transparent);
    cursor: pointer;
    text-decoration: none;
    transition: color 120ms ease;
  }
  .consent-skip:hover {
    color: color-mix(in oklch, currentColor 80%, transparent);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .consent-skip:focus-visible {
    outline: 2px solid var(--color-primary, currentColor);
    outline-offset: 2px;
    border-radius: 4px;
  }
</style>
