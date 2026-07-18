// macOS keychain-consent explainer (spec 2026-07-02 §4): shown when the user
// initiates a sign-in, BEFORE any keyring touch, so the OS Keychain permission
// prompt never surprises them (launch never shows this — spec Decisions §3).
// Desktop-only. No checkbox, no "don't ask again": declining simply re-asks at
// the next sign-in. Deliberately NO backdrop close: dismissing IS "Not now"
// (Escape or the link). Answers at most once per mount (Escape + click races).
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  onGrant: () => void;
  onDecline: () => void;
}

export function KeychainConsentModal({ onGrant, onDecline }: Props) {
  const answeredRef = useRef(false);

  function grant() {
    if (answeredRef.current) return;
    answeredRef.current = true;
    onGrant();
  }

  function decline() {
    if (answeredRef.current) return;
    answeredRef.current = true;
    onDecline();
  }

  // Escape = "Not now". preventDefault also stands the keymap fallback down
  // when listener order happens to favor us; the real protection is the
  // keychainConsent state guard in escapeFallbackTarget (see keymap.ts).
  useEffect(() => {
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        decline();
      }
    }
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/10 backdrop-blur-xs">
      <div
        className="mx-4 flex max-h-[78vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-xl bg-surface-raised p-4 ring-1 ring-surface-border shadow-[var(--floating-shadow)]"
        role="dialog"
        aria-modal="true"
        aria-label="Muesli uses your Mac's Keychain"
      >
        <h3 className="text-base font-semibold">
          Muesli uses your Mac&apos;s Keychain
        </h3>
        <p className="text-sm text-muted-foreground [text-wrap:pretty]">
          To keep you signed in, Muesli saves your login token in the macOS
          Keychain, the same protected store as your passwords. macOS may ask
          you for permission. Muesli can only reach its own entry, never your
          passwords, and stores nothing else there. Your token goes only to the
          server you sign in to, and Muesli is open source, so you can verify
          this yourself.
        </p>
        <div className="mt-2 flex items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            className="text-muted-foreground"
            onClick={decline}
          >
            Not now
          </Button>
          <Button type="button" variant="brand" onClick={grant}>
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}

export default KeychainConsentModal;
