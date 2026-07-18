// Router shell (port of App.svelte). The reactive hash route picks the view:
// the editor for a doc slug, the 404 page for a dead reserved route, otherwise
// the Home shell — which covers both the home routes ('' / 'f/…' / '~recent' /
// '~trash') AND '~settings/…' (Home renders the embedded Settings view in its
// main panel, so the workspaces sidebar persists rather than being a full-page
// takeover). DocApp is imported lazily so the home screen never loads yjs; once
// loaded, switches are pure component swaps (no reload). The key= remounts
// DocApp per doc (docId + shareToken), which opens/destroys one collab session.

import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useRef,
  type ReactNode,
} from "react";

import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { TooltipProvider } from "@/components/ui/tooltip";

import AuthPage from "@/components/auth/AuthPage";
import ErrorPage from "@/components/auth/ErrorPage";
import NotFound from "@/components/auth/NotFound";
import { SearchPaletteHost } from "@/components/search/SearchPalette";
import { HomeShell } from "@/components/home/HomeShell";

import { decideAppView } from "@/services/appGate";
import { loginUrl } from "@/services/identity";
import { authSessionStore, useAuthSession } from "@/state/authSession";
import { useT } from "@/state/i18n";
import { useRoute } from "@/state/route";
// Self-applying appearance stores (desktop parity): init() pushes the persisted
// CSS vars / data-theme on boot so the gray default (or the user's pick) is
// live everywhere, not only after visiting Settings.
import { themeStore } from "@/state/theme";
import { accentStore } from "@/state/accent";
import { backgroundStore } from "@/state/background";
import { folderColorStore } from "@/state/folderColor";
// Per-user appearance sync (GET/PATCH /api/me/prefs): dormant until
// authSession resolves a signed-in user, purely local otherwise.
import { prefsSync } from "@/state/prefsSync";

const DocApp = lazy(() => import("@/components/doc/DocApp"));

/** Calm blank floor: /api/me in flight, or handing off to the IdP. */
function Splash() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--floor)]">
      <Spinner className="size-8 opacity-40" />
    </div>
  );
}

function CrashPage({ onReset }: { onReset: () => void }) {
  const t = useT();
  return (
    <ErrorPage
      title={t("error.genericTitle")}
      message={t("error.genericBody")}
      action="reload"
      onAction={onReset}
    />
  );
}

// Generic error boundary (svelte:boundary port): a render/runtime crash
// anywhere in the routed view shows a friendly "Something went wrong" page
// with a reload, instead of a white-screen crash or a raw stack trace.
class RouteErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("muesli: routed view crashed", error);
  }

  reset = () => this.setState({ failed: false });

  render() {
    if (this.state.failed) return <CrashPage onReset={this.reset} />;
    return this.props.children;
  }
}

export default function App() {
  const routeCurrent = useRoute((s) => s.current);
  const auth = useAuthSession((s) => s.current);

  const doc = routeCurrent.kind === "doc" ? routeCurrent : null;

  // Top-level gate: a signed-out OIDC visitor is sent STRAIGHT into the
  // server's /auth/login redirect (no interstitial, no extra click) — UNLESS
  // they're opening a shared doc via a ?share=<token> link, which stays a
  // guest-accessible "app" view, or they explicitly visited #~login, the
  // routable sign-in fallback / organization-SSO chooser (AuthPage). Open mode
  // and signed-in users always see the real app.
  const view = decideAppView(routeCurrent, auth);

  // ── boot sequence (ONE mount effect; order mirrors App.svelte's side-effect
  // imports + the desktop AppShell init) ──────────────────────────────────────
  const initRan = useRef(false);
  useEffect(() => {
    if (initRan.current) return;
    initRan.current = true;

    // Theme first (persisted mode, data-theme + .dark class, OS listener),
    // then the persisted accent / background tint / folder color CSS vars.
    themeStore.getState().init();
    accentStore.getState().init();
    backgroundStore.getState().init();
    folderColorStore.getState().init();
    // Sync theme/accent/tint/folder-color per-user through the server once a
    // signed-in identity exists (after the local applies above, so a stored
    // server value wins over the machine-local one at boot).
    prefsSync.start();

    // The auth store's boot probe is idempotent-start in the Svelte original
    // (module-load ensureLoaded); hedge for a port that exposes it explicitly.
    const session = authSessionStore.getState() as { ensureLoaded?: () => void };
    session.ensureLoaded?.();
  }, []);

  useEffect(() => {
    // "redirect" is a full-page navigation into the IdP; the splash stays on
    // screen until the browser leaves.
    if (view === "redirect") window.location.href = loginUrl();
  }, [view]);

  return (
    <TooltipProvider delay={500}>
      {view === "loading" || view === "redirect" ? (
        <Splash />
      ) : view === "auth" ? (
        <AuthPage />
      ) : (
        <RouteErrorBoundary>
          {routeCurrent.kind === "notfound" ? (
            <NotFound kind="page" />
          ) : doc ? (
            <Suspense fallback={null}>
              {/* Keyed per doc (web-analysis §4): a doc switch destroys and
                  reopens the collab session (Y.Doc + provider + editor). */}
              <DocApp
                key={`${doc.docId} ${doc.shareToken ?? ""}`}
                docId={doc.docId}
                shareToken={doc.shareToken}
              />
            </Suspense>
          ) : (
            // The home and settings routes share one persistent shell: Home owns
            // the workspaces sidebar and swaps its main panel between the
            // document browser and the embedded Settings view.
            <HomeShell />
          )}
        </RouteErrorBoundary>
      )}

      {/* Mounted across the real app (home AND editor): owns the ⌘K / Ctrl+K
          and '/' shortcuts. Skipped on the auth/loading shells, which have
          nothing to search. */}
      {view === "app" && <SearchPaletteHost />}
      <Toaster />
    </TooltipProvider>
  );
}
