#!/bin/sh
# muesli CLI installer — https://muesli.md
#
#   curl -fsSL https://muesli.md/install.sh | sh
#
# Downloads the latest muesli CLI release from GitHub, verifies its SHA-256
# against the release's SHA256SUMS, and installs it to MUESLI_INSTALL_DIR
# (default: ~/.local/bin). Environment overrides:
#
#   MUESLI_VERSION      install a specific version, e.g. "0.1.0" (default: latest)
#   MUESLI_INSTALL_DIR  target directory (default: $HOME/.local/bin)
#
# Supported platforms: macOS (arm64, x86_64), Linux (x86_64, aarch64; glibc).
# On Windows, download the .zip from the releases page instead:
#   https://github.com/muesli-dot-md/muesli/releases
#
# POSIX sh, no bashisms: piped through `sh` on whatever the user has.
set -eu

REPO="muesli-dot-md/muesli"
INSTALL_DIR="${MUESLI_INSTALL_DIR:-$HOME/.local/bin}"

say()  { printf '%s\n' "$*"; }
fail() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

# --- platform detection -------------------------------------------------------
os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin)
    case "$arch" in
      arm64)  target="aarch64-apple-darwin" ;;
      x86_64) target="x86_64-apple-darwin" ;;
      *) fail "unsupported macOS architecture: $arch" ;;
    esac ;;
  Linux)
    case "$arch" in
      x86_64)          target="x86_64-unknown-linux-gnu" ;;
      aarch64 | arm64) target="aarch64-unknown-linux-gnu" ;;
      *) fail "unsupported Linux architecture: $arch" ;;
    esac ;;
  *)
    fail "unsupported OS: $os (on Windows, grab the .zip from https://github.com/$REPO/releases)" ;;
esac

# --- resolve version ----------------------------------------------------------
if [ -n "${MUESLI_VERSION:-}" ]; then
  tag="cli-v${MUESLI_VERSION#v}"
else
  # Latest cli-v* tag via the releases API (no jq dependency).
  tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=20" \
    | grep -o '"tag_name": *"cli-v[^"]*"' | head -1 | cut -d'"' -f4) || true
  [ -n "${tag:-}" ] || fail "could not find a CLI release (check https://github.com/$REPO/releases)"
fi
version="${tag#cli-v}"
base="https://github.com/$REPO/releases/download/$tag"
asset="muesli-$target.tar.gz"

say "installing muesli $version ($target)"

# --- download + verify --------------------------------------------------------
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curl -fsSL -o "$tmp/$asset" "$base/$asset" \
  || fail "download failed: $base/$asset"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" \
  || fail "download failed: $base/SHA256SUMS"

want=$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
[ -n "$want" ] || fail "$asset not listed in SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$tmp/$asset" | cut -d' ' -f1)
else
  got=$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)
fi
[ "$got" = "$want" ] || fail "checksum mismatch for $asset (expected $want, got $got)"

# --- install ------------------------------------------------------------------
tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$INSTALL_DIR"
install -m 755 "$tmp/muesli" "$INSTALL_DIR/muesli"

say "installed $INSTALL_DIR/muesli"
"$INSTALL_DIR/muesli" --version

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    say ""
    say "note: $INSTALL_DIR is not on your PATH. Add it with:"
    say "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

say ""
say "get started:  muesli open ./notes.md   (docs: https://docs.muesli.md)"
