<script lang="ts">
  // Sign-in dialog (spec 2026-07-02): always shows WHICH server the sign-in
  // will run against, with a gentle Change… affordance for self-hosters.
  // Desktop-only, same centered overlay chrome as KeychainConsentModal. The
  // dialog is strictly UPSTREAM of workspaces.login(): the keychain-consent
  // explainer and the device flow run AFTER the host closes this dialog
  // (onconfirm), completely unchanged.
  import { settings } from '$lib/settings.svelte';
  import { displayHost, displayUrl, normalizeServerInput } from '$lib/signInServer';

  let { onconfirm, oncancel }: { onconfirm: () => void; oncancel: () => void } = $props();

  // Answer at most once per mount (Escape + click races), like the other modals.
  let answered = $state(false);
  // View state: showing (display row) ⇄ editing (URL input). Opens in showing.
  let editing = $state(false);
  let draft = $state('');
  let inputError = $state<string | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);

  const host = $derived(displayHost(settings.wsBase));

  function confirm() {
    if (answered) return;
    answered = true;
    onconfirm();
  }

  function cancel() {
    if (answered) return;
    answered = true;
    oncancel();
  }

  function startEditing() {
    // Prefill with the plain-URL form, never the raw ws(s)://…/ws value —
    // customers type ordinary https addresses; the ws parts are ours.
    draft = displayUrl(settings.wsBase);
    inputError = null;
    editing = true;
  }

  function cancelEditing() {
    editing = false;
    inputError = null;
  }

  function saveServer() {
    const normalized = normalizeServerInput(draft);
    if (normalized === null) {
      // Invalid → inline error, stay editing, persist NOTHING (spec §5).
      inputError = 'Enter a server URL like https://muesli.example.com';
      return;
    }
    settings.setWsBase(normalized);
    editing = false;
    inputError = null;
  }

  // Focus the URL input whenever editing starts.
  $effect(() => {
    if (editing) inputEl?.focus();
  });

  // Escape cancels EDITING first (does NOT close the dialog); outside editing
  // it means "Not now". preventDefault also stands the keymap fallback down
  // when listener order happens to favor us; the real protection is the
  // signIn state guard in escapeFallbackTarget (see keymap.ts).
  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (editing) cancelEditing();
      else cancel();
    }
  }

  // Enter in the URL input submits the edit.
  function onInputKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveServer();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Same overlay chrome as KeychainConsentModal (both vertically centered).
     Deliberately NO backdrop close: dismissing IS "Not now" (Escape or the
     link). -->
<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
  <div
    class="mx-4 flex max-h-[78vh] w-full max-w-xl flex-col gap-3 overflow-y-auto p-5"
    style="background: var(--overlay); box-shadow: var(--shadow-overlay); border-radius: var(--radius-overlay, 0.875rem);"
    role="dialog"
    aria-modal="true"
    aria-label="Sign in to Muesli"
  >
    <h3 class="text-lg font-semibold">Sign in to Muesli</h3>
    <p class="text-sm text-base-content/70" style="text-wrap: pretty;">
      Your account lives on the server you sign in to.
    </p>

    {#if !editing}
      <!-- Server row: label, friendly host in medium weight, Change… link. -->
      <div class="flex items-center gap-3 text-sm">
        <span class="text-base-content/60">Server</span>
        <span class="min-w-0 flex-1 truncate text-right font-medium">{host}</span>
        <button class="consent-skip shrink-0" type="button" onclick={startEditing}>
          Change…
        </button>
      </div>
    {:else}
      <!-- The row swaps to a labeled URL input prefilled with the plain-URL
           form of settings.wsBase (displayUrl). -->
      <div class="flex flex-col gap-1.5">
        <label class="text-sm text-base-content/60" for="signin-server-url">Server</label>
        <div class="flex items-center gap-2">
          <input
            id="signin-server-url"
            type="text"
            class="input input-sm flex-1 border-base-300 bg-base-100"
            placeholder="https://muesli.example.com"
            bind:value={draft}
            bind:this={inputEl}
            onkeydown={onInputKeydown}
            aria-invalid={inputError !== null}
          />
          <button class="btn btn-primary btn-sm" type="button" onclick={saveServer}>
            Save
          </button>
          <button class="consent-skip" type="button" onclick={cancelEditing}>Cancel</button>
        </div>
        {#if inputError}
          <p class="text-xs text-error">{inputError}</p>
        {/if}
      </div>
    {/if}

    <div class="mt-2 flex items-center justify-between">
      <button class="consent-skip" type="button" onclick={cancel}>Not now</button>
      <!-- Disabled while editing so Continue can never sign into a server the
           user typed but did not Save. -->
      <button class="btn btn-primary" type="button" onclick={confirm} disabled={editing}>
        Continue
      </button>
    </div>
  </div>
</div>

<style>
  /* Same look as the shared wizard's .mws-skip (a plain text link, NOT a .btn).
     Copied rather than reused so this desktop-only modal doesn't depend on
     wizard.css having been loaded by another component — identical rationale
     and rules to KeychainConsentModal. */
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
