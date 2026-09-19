#!/usr/bin/env bash
# Launch Chrome for Testing in headless mode with the Chrome DevTools
# Protocol (CDP) enabled for browser automation and screenshots.
#
# Adapted from https://github.com/cyysky/chromium-cdp-raspbarry-pi-4
# (scripts/chrome-debug.sh.example). That repo ships Raspberry Pi binaries,
# so this host uses Google's official linux64 Chrome-for-Testing build.
# Per the Chrome docs, CDP automation should run on the dedicated
# chrome-headless-shell binary:
#   https://developer.chrome.com/docs/automation-and-testing/headless-chrome-shell
#
# NOTE: the reference launcher honored $BROWSER, but dev hosts (VS Code)
# export $BROWSER as an external-URL helper that rejects every Chromium
# flag. Override with BROWSER_BIN instead.
#
# Customize via:
#   BROWSER_BIN   — browser binary (default: chrome-headless-shell, falls
#                   back to the full Chrome-for-Testing binary)
#   CDP_PORT      — debugger port (default: 9222)
#   CDP_ORIGIN    — allowed origin for the DevTools UI (default: *)
#   PROFILE_DIR   — user data dir (default: $HOME/.cache/aimonitor-chrome)
#
#   CHROME_UA     user-agent override (default: unset). Headless Chrome
#                   advertises HeadlessChrome/<ver>, which Cloudflare Turnstile
#                   fingerprints and answers with a challenge page. Setting a
#                   normal desktop Chrome UA string avoids that.
# Usage:
#   ./scripts/chrome-headless.sh                    # foreground
#   CDP_PORT=9223 BROWSER_BIN=chromium ./scripts/chrome-headless.sh
#
# Then drive it over CDP:
#   curl -s http://127.0.0.1:9222/json/version
set -e

CFT_DIR="${CFT_DIR:-/opt/chrome-for-testing}"
BROWSER_BIN="${BROWSER_BIN:-}"

if [ -z "$BROWSER_BIN" ]; then
  if [ -x "$CFT_DIR/chrome-headless-shell-linux64/chrome-headless-shell-linux64/chrome-headless-shell" ]; then
    BROWSER_BIN="$CFT_DIR/chrome-headless-shell-linux64/chrome-headless-shell-linux64/chrome-headless-shell"
  elif [ -x "$CFT_DIR/chrome-linux64/chrome" ]; then
    BROWSER_BIN="$CFT_DIR/chrome-linux64/chrome"
  else
    echo "no Chrome binary found; install under $CFT_DIR or set BROWSER_BIN" >&2
    exit 1
  fi
fi

CDP_PORT="${CDP_PORT:-9222}"
CDP_ORIGIN="${CDP_ORIGIN:-*}"
PROFILE_DIR="${PROFILE_DIR:-$HOME/.cache/aimonitor-chrome}"
CHROME_UA="${CHROME_UA:-}"

mkdir -p "$PROFILE_DIR"

case "$BROWSER_BIN" in
  *chrome-headless-shell*) HEADLESS_ARGS=() ;;
  *) HEADLESS_ARGS=(--headless=new) ;;
esac

if [ -n "$CHROME_UA" ]; then
  UA_ARGS=(--user-agent="$CHROME_UA")
else
  UA_ARGS=()
fi

exec "$BROWSER_BIN" \
  "${HEADLESS_ARGS[@]}" \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --disable-crash-reporter \
  --remote-debugging-port="$CDP_PORT" \
  --remote-allow-origins="$CDP_ORIGIN" \
  --user-data-dir="$PROFILE_DIR" \
  "${UA_ARGS[@]}" \
  "$@"
