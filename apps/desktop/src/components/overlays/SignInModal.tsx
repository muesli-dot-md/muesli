// Sign-in dialog (spec 2026-07-02): always shows WHICH server the sign-in
// will run against, with a gentle Change… affordance for self-hosters. The
// dialog is strictly UPSTREAM of workspaces.login(): the keychain-consent
// explainer and the device flow run AFTER the host closes this dialog
// (onConfirm), completely unchanged. Deliberately NO backdrop close:
// dismissing IS "Not now" (Escape or the link). Answers at most once per
// mount (Escape + click races).
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { displayHost, displayUrl, normalizeServerInput } from "@/services/signInServer";
import { settingsStore, useSettings } from "@/state/settings";

interface Props {
  onConfirm: () => void;
  onCancel: () => void;
}

export function SignInModal({ onConfirm, onCancel }: Props) {
  const wsBase = useSettings((s: { wsBase: string }) => s.wsBase);
  const host = displayHost(wsBase);

  // Answer at most once per mount (Escape + click races), like the other modals.
  const answeredRef = useRef(false);
  // View state: showing (display row) ⇄ editing (URL input). Opens in showing.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function confirm() {
    if (answeredRef.current) return;
    answeredRef.current = true;
    onConfirm();
  }

  function cancel() {
    if (answeredRef.current) return;
    answeredRef.current = true;
    onCancel();
  }

  function startEditing() {
    // Prefill with the plain-URL form, never the raw ws(s)://…/ws value —
    // customers type ordinary https addresses; the ws parts are ours.
    setDraft(displayUrl(settingsStore.getState().wsBase));
    setInputError(null);
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
    setInputError(null);
  }

  function saveServer() {
    const normalized = normalizeServerInput(draft);
    if (normalized === null) {
      // Invalid → inline error, stay editing, persist NOTHING (spec §5).
      setInputError("Enter a server URL like https://muesli.example.com");
      return;
    }
    settingsStore.getState().setWsBase(normalized);
    setEditing(false);
    setInputError(null);
  }

  // Focus the URL input whenever editing starts.
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // Escape cancels EDITING first (does NOT close the dialog); outside editing
  // it means "Not now". preventDefault also stands the keymap fallback down
  // when listener order happens to favor us; the real protection is the
  // signIn state guard in escapeFallbackTarget (see keymap.ts).
  useEffect(() => {
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        if (editing) cancelEditing();
        else cancel();
      }
    }
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/10 backdrop-blur-xs">
      <div
        className="mx-4 flex max-h-[78vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-xl bg-surface-raised p-4 ring-1 ring-surface-border shadow-[var(--floating-shadow)]"
        role="dialog"
        aria-modal="true"
        aria-label="Sign in to Muesli"
      >
        <h3 className="text-base font-semibold">Sign in to Muesli</h3>
        <p className="text-sm text-muted-foreground [text-wrap:pretty]">
          Your account lives on the server you sign in to.
        </p>

        {!editing ? (
          // Server row: label, friendly host in medium weight, Change… link.
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">Server</span>
            <span className="min-w-0 flex-1 truncate text-right font-medium">{host}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0 text-muted-foreground"
              onClick={startEditing}
            >
              Change…
            </Button>
          </div>
        ) : (
          // The row swaps to a labeled URL input prefilled with the plain-URL
          // form of settings.wsBase (displayUrl).
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-muted-foreground" htmlFor="signin-server-url">
              Server
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="signin-server-url"
                ref={inputRef}
                type="text"
                className="flex-1"
                placeholder="https://muesli.example.com"
                value={draft}
                onChange={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  // Enter in the URL input submits the edit.
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveServer();
                  }
                }}
                aria-invalid={inputError !== null}
              />
              <Button type="button" variant="brand" size="sm" onClick={saveServer}>
                Save
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={cancelEditing}
              >
                Cancel
              </Button>
            </div>
            {inputError ? <p className="text-xs text-destructive">{inputError}</p> : null}
          </div>
        )}

        <div className="mt-2 flex items-center justify-between">
          <Button type="button" variant="ghost" className="text-muted-foreground" onClick={cancel}>
            Not now
          </Button>
          {/* Disabled while editing so Continue can never sign into a server
              the user typed but did not Save. */}
          <Button type="button" variant="brand" onClick={confirm} disabled={editing}>
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}

export default SignInModal;
