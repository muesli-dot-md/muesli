# Tauri + SvelteKit + TypeScript

This template should help get you started developing with Tauri, SvelteKit and TypeScript in Vite.

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Svelte](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer).

## Dev notes: macOS Keychain consent — manual test checklist

The desktop shares its token entry with the `muesli` CLI (keyring service
`"muesli"`), so macOS prompts when one signed binary reads the other's entry.
The app shows an in-app explainer first — and ONLY when the user initiates a
sign-in; launch is always silent (spec
`internal/superpowers/specs/2026-07-02-desktop-keychain-consent-design.md`).
Verify on a fresh macOS profile (or after a reset: clear the `muesli:settings`
localStorage key and remove the app's Keychain entry via Keychain Access):

- [ ] Launch shows NO dialog and NO macOS Keychain prompt — ever, regardless
      of the configured server.
- [ ] Local-only use (open folders, edit, never sign in) never shows the
      explainer or an OS prompt.
- [ ] Clicking Sign in (or onboarding's "Connect to a server") shows the
      explainer BEFORE any macOS Keychain prompt.
- [ ] "Not now": no OS prompt; the app stays usable and logged-out; clicking
      Sign in again re-shows the explainer (no sticky decline).
- [ ] "Continue": the macOS Keychain prompt follows; after approving, the
      sign-in completes (a token already in the Keychain signs in directly,
      with no browser device flow).
- [ ] Relaunch after a grant: NO dialog, and the stored token signs the user
      in automatically (silent gate reopen).
- [ ] Escape while the explainer is up = "Not now", and it does NOT dismiss
      anything open beneath the overlay (e.g. the workspace picker).
- [ ] CLI unaffected throughout: `muesli` login/token commands behave the same
      whether or not the app ever granted consent.

## Dev notes: sign-in server picker — manual test checklist

Sign-in always shows WHICH server it will run against, with a Change…
affordance (spec
`internal/superpowers/specs/2026-07-02-desktop-signin-server-picker-design.md`).
Fresh installs default to `wss://muesli.md/ws`; persisted values win. Verify
after clearing the `muesli:settings` localStorage key:

- [ ] Workspace menu → Sign in… shows the dialog with the current server
      (fresh install: `muesli.md`) — no browser window yet.
- [ ] Change… → Save persists: the dialog shows the new host, Settings → Sync
      shows the same value, and it survives a relaunch.
- [ ] Garbage input (inner spaces, `ftp://…`, empty) on Save: inline error
      "Enter a server URL like https://muesli.example.com", the dialog stays
      open in editing mode, nothing is persisted.
- [ ] Continue: the keychain explainer runs first (when consent is not yet
      granted), then the browser device flow — against the server the dialog
      showed.
- [ ] Escape while the URL input is open cancels EDITING only; Escape
      otherwise = Not now — and it dismisses NOTHING beneath the overlay
      (e.g. the workspace picker).
- [ ] Onboarding's "Connect to a server" opens the same dialog; a successful
      login opens the create-workspace wizard; a failed login lands on
      Settings → Sync (the existing error surface).

## Desktop releases & seamless updates

The app self-updates via `tauri-plugin-updater`: it checks
`https://github.com/muesli-dot-md/muesli/releases/latest/download/latest.json`
~10 seconds after launch and every 4 hours. With **Automatic Updates** on (the
default, toggleable in the update pill's popover), a found update downloads
silently and a pill appears at the bottom of the sidebar only once it is ready;
"Restart and Update" installs and relaunches. Updater artifacts are signed with
a minisign key — independent of Apple code signing — and the plugin refuses
unsigned/mismatched artifacts. Dev builds (`pnpm tauri dev`) never check.

### Launch prerequisites

- **Repo visibility:** anonymous clients cannot fetch private Release assets,
  so updates only work once `muesli-dot-md/muesli` (or at least its Releases)
  is public. No token workaround is built.
- **Apple signing:** unsigned, Gatekeeper-quarantined apps can refuse to launch
  after a bundle swap. Self-built copies are fine; public distribution needs
  Developer ID signing + notarization (deferred — see
  `.github/workflows/desktop-macos.yml`). Nothing in the updater blocks on it.

### One-time setup (human)

The updater keypair lives at `apps/desktop/.updater-key` (private key) and
`apps/desktop/.updater-key.pass` (its password) — git-ignored; the public key
is embedded in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). If they
don't exist (fresh clone), regenerate with
`openssl rand -base64 24 > .updater-key.pass && pnpm tauri signer generate -w .updater-key -p "$(cat .updater-key.pass)"`
from `apps/desktop/` and update the `pubkey` in `tauri.conf.json`.

Upload the GitHub Actions secrets on `muesli-dot-md/muesli` (never paste the
values anywhere else):

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo muesli-dot-md/muesli < apps/desktop/.updater-key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo muesli-dot-md/muesli < apps/desktop/.updater-key.pass
```

Keep an offline backup of both files: losing the private key means existing
installs can never verify another update (they'd need a manual reinstall).

### Cutting a release

1. Bump `"version"` in `apps/desktop/src-tauri/tauri.conf.json`.
2. Commit, then tag exactly `desktop-v<that version>` and push the tag:
   `git tag desktop-v0.2.0 && git push origin desktop-v0.2.0`.
3. `.github/workflows/desktop-release.yml` (self-hosted macOS runner) verifies
   the tag matches the config version, builds signed updater artifacts, and
   publishes a GitHub Release with `Muesli.app.tar.gz`, its `.sig`, the `.dmg`,
   and `latest.json` (marked `--latest`). Re-running a release requires
   deleting the existing GitHub release for that tag first
   (`gh release delete desktop-vX.Y.Z`). Any non-desktop release cut from this
   repo must be created with `--latest=false`, otherwise the desktop updater's
   `releases/latest/download/latest.json` endpoint 404s until the next desktop
   release.

### Manual update checklist (per release)

- [ ] Sidebar hairline: appears once the file tree is scrolled, absent at
      scroll-top and on trees too short to scroll.
- [ ] Theme: the workspace-menu segments switch Light/Dark/System live, and the
      dropdown stays open across clicks.
- [ ] Pill + popover flow against a real GitHub (pre-)release once secrets are
      set: with Automatic Updates on, the pill appears only when the download
      is ready; with it off, the pill appears immediately and the button shows
      download progress.
- [ ] "Restart and Update" applies the new version with only a restart (About/
      version reflects the new number after relaunch).
