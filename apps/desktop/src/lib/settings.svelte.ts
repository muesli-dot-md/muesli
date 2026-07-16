// App-wide settings, persisted to localStorage. A runes singleton so any
// component can read `settings.wsBase` reactively.
//
// There is deliberately NO sync toggle here: sync is active iff the user is
// signed in (workspaces.identity non-null) AND the open workspace is
// server-linked (workspaces.activeLinked) — never a user preference. The old
// persisted `syncEnabled` key is simply ignored on load and dropped on the
// next persist(); signed-out users and local-only workspaces keep the
// local-only open flow.

const STORAGE_KEY = "muesli:settings";

const DEFAULTS = {
  // Fresh installs point at the public server (sign-in server picker spec
  // 2026-07-02, Decision 3). Persisted values always win (load() prefers a
  // stored string), so existing installs are untouched; self-hosters change
  // it in the sign-in dialog's Change… flow or Settings → About. Sign-in
  // against a not-yet-live app.muesli.md fails gracefully via the existing
  // workspaces.error surface; local-only use never touches it.
  wsBase: "wss://app.muesli.md/ws",
  // First-launch onboarding (BYO storage phase 3): true once completed or
  // skipped — or set silently when a logged-in identity is already onboarded
  // on the server (spec §2's silence rule).
  onboarded: false,
  // macOS keychain consent (spec 2026-07-02): true exactly once, when the user
  // accepts the explainer during a sign-in. Declining persists NOTHING
  // (absent/false = not granted) — the explainer re-appears at the next sign-in.
  keychainConsent: false,
  // Seamless updates (spec 2026-07-02, Decision 2): when true a found update
  // downloads silently and the sidebar pill appears only once it is READY;
  // when false the pill appears at `available` and the user drives the
  // download from the popover.
  autoUpdate: true,
};

interface PersistedSettings {
  wsBase: string;
  onboarded: boolean;
  keychainConsent: boolean;
  autoUpdate: boolean;
}

function load(): PersistedSettings {
  if (typeof localStorage === "undefined") return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    return {
      wsBase: typeof parsed.wsBase === "string" ? parsed.wsBase : DEFAULTS.wsBase,
      onboarded: typeof parsed.onboarded === "boolean" ? parsed.onboarded : DEFAULTS.onboarded,
      keychainConsent:
        typeof parsed.keychainConsent === "boolean"
          ? parsed.keychainConsent
          : DEFAULTS.keychainConsent,
      autoUpdate: typeof parsed.autoUpdate === "boolean" ? parsed.autoUpdate : DEFAULTS.autoUpdate,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

class SettingsStore {
  wsBase = $state(DEFAULTS.wsBase);
  onboarded = $state(DEFAULTS.onboarded);
  keychainConsent = $state(DEFAULTS.keychainConsent);
  autoUpdate = $state(DEFAULTS.autoUpdate);

  constructor() {
    const initial = load();
    this.wsBase = initial.wsBase;
    this.onboarded = initial.onboarded;
    this.keychainConsent = initial.keychainConsent;
    this.autoUpdate = initial.autoUpdate;
  }

  private persist(): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          wsBase: this.wsBase,
          onboarded: this.onboarded,
          keychainConsent: this.keychainConsent,
          autoUpdate: this.autoUpdate,
        }),
      );
    } catch {
      // best-effort; ignore quota/availability errors
    }
  }

  setWsBase(value: string): void {
    this.wsBase = value;
    this.persist();
  }

  setOnboarded(value: boolean): void {
    this.onboarded = value;
    this.persist();
  }

  setKeychainConsent(value: boolean): void {
    this.keychainConsent = value;
    this.persist();
  }

  setAutoUpdate(value: boolean): void {
    this.autoUpdate = value;
    this.persist();
  }
}

export const settings = new SettingsStore();
