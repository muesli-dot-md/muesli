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
// email domain shows an inline error instead of dead-ending on a 404 page.
// Yjs-free. React port of the web AuthPage.svelte.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { loginUrl, orgLoginUrl } from "@/services/identity";
import { useT } from "@/state/i18n";

export function AuthPage() {
  const t = useT();

  // The two faces of the page: the primary sign-in actions, or the org-SSO
  // email form (revealed in place so the page stays a single calm column).
  const [mode, setMode] = useState<"default" | "sso">("default");
  const [ssoEmail, setSsoEmail] = useState("");
  const [ssoError, setSsoError] = useState("");
  const [ssoBusy, setSsoBusy] = useState(false);

  /** Focus the SSO email field when the form is revealed (a11y-friendly
   *  autofocus). */
  const emailRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (mode === "sso") emailRef.current?.focus();
  }, [mode]);

  /** Probe-first SSO: an unknown email domain shows an inline error rather
   *  than navigating into a 404. A reachable issuer 302s us into the IdP. */
  async function orgSignIn(e: FormEvent) {
    e.preventDefault();
    setSsoError("");
    setSsoBusy(true);
    const url = orgLoginUrl(ssoEmail.trim());
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status === 404) {
        setSsoError(t("account.noSsoForDomain"));
        setSsoBusy(false);
        return;
      }
    } catch {
      // opaque redirect / network hiccup — let the real navigation decide
    }
    window.location.href = url;
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[var(--floor)] px-6 text-foreground antialiased">
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        {/* wordmark IS the mark: lowercase Sentient, like the marketing site */}
        <div className="flex flex-col items-center gap-3">
          <h1 className="wordmark text-6xl leading-none">muesli</h1>
          <p className="max-w-xs text-center text-sm opacity-60 [text-wrap:balance]">
            {t("auth.tagline")}
          </p>
        </div>

        {mode === "default" ? (
          <div className="flex w-full flex-col gap-2.5">
            <a className={cn(buttonVariants({ size: "lg" }), "w-full")} href={loginUrl()}>
              {t("common.signIn")}
            </a>
            <Button
              type="button"
              variant="ghost"
              size="lg"
              className="w-full"
              onClick={() => {
                setMode("sso");
                setSsoError("");
              }}
            >
              {t("auth.signInWithSso")}
            </Button>
          </div>
        ) : (
          <form className="flex w-full flex-col gap-2.5" onSubmit={(e) => void orgSignIn(e)}>
            <p className="text-center text-xs opacity-60 [text-wrap:pretty]">
              {t("auth.ssoIntro")}
            </p>
            <Input
              ref={emailRef}
              className="w-full"
              type="email"
              placeholder={t("account.ssoEmailPlaceholder")}
              value={ssoEmail}
              required
              onChange={(e) => {
                setSsoEmail(e.currentTarget.value);
                setSsoError("");
              }}
            />
            {ssoError ? <p className="text-center text-xs text-destructive">{ssoError}</p> : null}
            <Button type="submit" size="lg" className="w-full" disabled={ssoBusy}>
              {ssoBusy ? <Spinner className="size-3.5" /> : null}
              {t("account.signInWithOrg")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => {
                setMode("default");
                setSsoError("");
              }}
            >
              {t("auth.backToSignIn")}
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}

export default AuthPage;
