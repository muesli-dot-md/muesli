# Muesli Presence for VS Code

Tier-2 presence inside VS Code (ADR 0014): when a markdown file you have open
is muesli-linked, this extension joins the document's room as a
**presence-only** participant. You see who else is in the doc (status bar) and
where their cursors are (colored carets + selection highlights); they see
yours.

**Presence only — never content.** Document content keeps flowing through the
CLI bridge (`muesli open <file>`), which materializes remote edits to disk and
ingests your saves. The extension never edits your buffer and never writes to
the shared text. Run `muesli open` alongside it.

## How it finds your documents

The CLI records every link in `links.json`
(macOS `~/Library/Application Support/muesli/links.json`,
Linux `~/.local/share/muesli/links.json`). When the active editor's file
matches an entry (paths canonicalized, so macOS `/tmp` vs `/private/tmp` is
fine), the extension connects to that entry's server and joins the doc's room.

## Install

```sh
code --install-extension muesli-vscode-0.1.0.vsix
```

To rebuild the vsix from source:

```sh
pnpm install                       # from the repo root
pnpm --filter muesli-vscode run package
```

## Usage

1. `muesli open notes.md` (the CLI links the file and starts content sync).
2. Open `notes.md` in VS Code.
3. The status bar shows `muesli: N here`. Click it for the participant list
   and an "Open in browser" shortcut to the web editor.

Remote participants render as a 2px colored caret (hover for their name) and a
translucent highlight for selections. Your own selection is published to the
room (debounced, 250ms).

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `muesli.webOrigin` | `http://localhost:5173` | Web app origin used for "Open in browser" when the linked server is on localhost. In dev, vite serves the app on `:5173` while the server runs on `:8787`; non-local servers open at the server's own origin (single-image deploy, ADR 0017). |
| `muesli.serverOverride` | `""` | Connect to this server instead of the one recorded in `links.json`. |
| `muesli.displayName` | `""` | Name shown to other participants. Defaults to your OS username. |

## Limitations

- **Auth tokens:** the extension reads `MUESLI_TOKEN` (env) or the CLI's
  `credentials.json` file fallback (`MUESLI_TOKEN_STORE=file`). Tokens stored
  in the OS **keychain are not readable** from the extension — launch VS Code
  with `MUESLI_TOKEN` set for those servers. Open-mode servers need no token.
- **Cursor mapping vs. unsaved edits:** cursor positions are mapped through
  the room's shared text. Between your keystroke and the CLI bridge ingesting
  the save, buffer and room can drift slightly; positions clamp and converge
  on save/autosave.
- Presence is tracked for the **active** markdown editor (one room at a time).
- No inline comments or suggestions yet — those stay in the web app for now.
