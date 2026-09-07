# chrome-headless-cdp-ubuntu-vps-skill

Headless Chrome automation skill for an x86_64 Ubuntu VPS: drive a
Chrome-for-Testing `chrome-headless-shell` over the Chrome DevTools Protocol
(CDP) to browse, screenshot, scrape, evaluate JS, and debug web apps.

Adapted from
[cyysky/chromium-cdp-raspbarry-pi-4](https://github.com/cyysky/chromium-cdp-raspbarry-pi-4)
(Raspberry Pi / ARM) to Google's official linux64 Chrome-for-Testing build,
using the dedicated
[chrome-headless-shell](https://developer.chrome.com/docs/automation-and-testing/headless-chrome-shell)
binary.

See [SKILL.md](SKILL.md) for install, verification, and CDP driving examples.

## Layout

| Path | What it is |
| --- | --- |
| `SKILL.md` | The skill instructions (frontmatter + usage) |
| `scripts/chrome-headless.sh` | Launcher: starts the browser with `--remote-debugging-port=9222` |
| `scripts/chrome-headless.service` | systemd unit template for a persistent browser |
| `scripts/cap-tabs.mjs` | Keeps open page tabs capped (default 10) |

## Quick start

```bash
cp scripts/chrome-headless.sh /usr/local/bin/chrome-headless
cp scripts/chrome-headless.service /etc/systemd/system/
systemctl enable --now chrome-headless
curl -s http://127.0.0.1:9222/json/version | jq .Browser
```

Overrides: `BROWSER_BIN`, `CDP_PORT`, `CDP_ORIGIN`, `PROFILE_DIR`. Note that
`BROWSER` is ignored on purpose (VS Code exports it as an external-URL helper
that rejects Chromium flags).
