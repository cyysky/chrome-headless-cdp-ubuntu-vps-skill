---
name: chrome-headless-cdp-ubuntu-vps
description: "Drive a local Chrome-for-Testing headless shell (chrome-headless-shell) on an x86_64 Ubuntu VPS via the Chrome DevTools Protocol (CDP) to open URLs, take screenshots, scrape content, run JavaScript in a page, fill in forms, click buttons, inspect console output or network requests, or otherwise automate anything a real browser can do. Auto-caps tabs at 10 by closing the oldest pages. Do not use for: cloud browser services, raw HTTP requests without a browser, parsing local HTML or JSON files, or non-web tasks."
---

# Headless Chrome CDP (Ubuntu VPS)

Drive a headless Chrome-for-Testing build on an x86_64 Ubuntu VPS via the
Chrome DevTools Protocol (CDP). Use it for browsing, scraping, screenshotting,
JS evaluation, form filling, network/console inspection, and other browser
automation against web apps (e.g. a self-hosted portal behind nginx).

Adapted from
[cyysky/chromium-cdp-raspbarry-pi-4](https://github.com/cyysky/chromium-cdp-raspbarry-pi-4),
which shipped Raspberry Pi (ARM) binaries. This variant uses Google's official
linux64 Chrome-for-Testing build, preferring the dedicated
`chrome-headless-shell` binary per
[Chrome's headless-shell docs](https://developer.chrome.com/docs/automation-and-testing/headless-chrome-shell).

## Prerequisites

An x86_64 Ubuntu host (tested on 24.04) with `curl`, `jq` (optional), and
Node.js 22+ only if you use `scripts/cap-tabs.mjs` (native `WebSocket` global).

### 1. Install Chrome for Testing + headless shell

```bash
CFT_DIR=/opt/chrome-for-testing
curl -fsSL -o /tmp/cft.json \
  https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json
# Pick the stable linux64 URLs for "chrome" and "chrome-headless-shell", then:
mkdir -p "$CFT_DIR"
cd /tmp
curl -fsSLO "$CHROME_ZIP_URL"
curl -fsSLO "$HEADLESS_SHELL_ZIP_URL"
python3 -m zipfile -e chrome-linux64.zip "$CFT_DIR"
python3 -m zipfile -e chrome-headless-shell-linux64.zip "$CFT_DIR"
# python unzip drops exec bits; restore them
find "$CFT_DIR" -type f \( -name chrome -o -name chrome-headless-shell \
  -o -name chrome_crashpad_handler \) -exec chmod +x {} +
```

If the system lacks shared libraries the binary needs, install them:

```bash
apt-get update
apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libasound2t64 libpango-1.0-0 libcairo2
```

Verify:

```bash
"$CFT_DIR"/chrome-headless-shell-linux64/chrome-headless-shell-linux64/chrome-headless-shell --version
```

### 2. Install the launcher and systemd service

```bash
cp scripts/chrome-headless.sh /usr/local/bin/chrome-headless
chmod +x /usr/local/bin/chrome-headless
cp scripts/chrome-headless.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now chrome-headless
```

The launcher honors `BROWSER_BIN`, `CDP_PORT` (default 9222), `CDP_ORIGIN`
(default `*`), and `PROFILE_DIR`. **Do not override via `BROWSER`**: VS Code
and some desktops export `BROWSER` as an external-URL helper that rejects every
Chromium flag (it logs `Ignoring option 'X': not supported for code.`).

## Verify CDP is reachable

```bash
curl -sS http://127.0.0.1:9222/json/version   # browser info + browser WS URL
curl -sS http://127.0.0.1:9222/json           # list page/worker/service_worker targets
ss -tlnp | grep ':9222'                       # confirm LISTEN (localhost only)
```

Keep CDP bound to localhost — it allows full control of the browser with no
authentication, so never expose port 9222 publicly. If you must reach it from
another host, add `--remote-debugging-address=0.0.0.0` and firewall it.

## Browse the web

Pick a tab and drive it over its page-target WebSocket. The newest page is
usually the last entry in `/json`:

```bash
TARGET=$(curl -sS http://127.0.0.1:9222/json | node -e '
  let s=""; process.stdin.on("data", c => s += c).on("end", () => {
    const pages = JSON.parse(s).filter(t => t.type === "page");
    console.log(pages[pages.length - 1]?.webSocketDebuggerUrl ?? "");
  });')

node -e '
  const ws = new WebSocket(process.argv[1]);
  let id = 1;
  const send = (m, p = {}) => ws.send(JSON.stringify({ id: id++, method: m, params: p }));
  ws.addEventListener("open", () => send("Page.enable"));
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id === 1) send("Page.navigate", { url: "https://example.com" });
    if (msg.method === "Page.loadEventFired") ws.close();
  });
' "$TARGET"
```

To open a URL in a **new** page (HTTP endpoint, still available):

```bash
curl -sS -X PUT "http://127.0.0.1:9222/json/new?https://example.com"
```

After any new-tab action, run the tab cap to stay within the limit:

```bash
node scripts/cap-tabs.mjs 10
```

## Debug a web app

Connect to a page target's `webSocketDebuggerUrl` and call CDP methods.
Common ones:

| Goal | Method | Key params |
| --- | --- | --- |
| Capture console output | `Runtime.enable` + listen `Runtime.consoleAPICalled` | — |
| Read DOM / evaluate JS | `Runtime.evaluate` | `expression`, `returnByValue: true` |
| Inject a script (await) | `Runtime.evaluate` | `awaitPromise: true` |
| Reload (clear cache) | `Page.reload` | `ignoreCache: true` |
| Screenshot | `Page.captureScreenshot` | `format: "png"`, `captureBeyondViewport: true` |
| Throttle CPU / network | `Emulation.setCPUThrottlingRate`, `Network.emulateNetworkConditions` | rate / ms |
| Capture HAR | `Network.enable` + listen `Network.responseReceived` | — |
| Close a tab | `Target.closeTarget` | `targetId` |

Sketch:

```bash
TARGET=$(curl -sS http://127.0.0.1:9222/json | node -e '
  let s=""; process.stdin.on("data", c => s += c).on("end", () => {
    const t = JSON.parse(s).find(t => t.type === "page" && t.url.includes("localhost:3000"));
    console.log(t?.webSocketDebuggerUrl ?? "");
  });')

node -e '
  const ws = new WebSocket(process.argv[1]);
  let id = 1;
  const send = (m, p = {}) => ws.send(JSON.stringify({ id: id++, method: m, params: p }));
  ws.addEventListener("open", () => send("Runtime.enable"));
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id === 1) send("Runtime.evaluate", {
      expression: "document.title", returnByValue: true
    });
    if (msg.id === 2) { console.log("title:", msg.result?.result?.value); ws.close(); }
  });
' "$TARGET"
```

Screenshots can be saved from `Page.captureScreenshot.data` (base64 PNG).

## Optional: shared-browser control plane

When several people or scripts share one browser, the raw CDP endpoint on `9222`
has no authentication and is loopback-only. The `cdp-manage/` companion module
fronts it with a token-authenticated JSON API, a dashboard, an SSE event feed, a
browser-level websocket for Playwright and a tab cap:

```bash
sudo bash cdp-manage/deploy.sh   # prints the bearer token
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9300/api/health
```

```js
const browser = await chromium.connectOverCDP(`ws://<host>:9300/pw?token=${token}`);
```

See [cdp-manage/README.md](cdp-manage/README.md). Skip it for single-user,
same-host automation and drive `9222` directly.

## Files

| File | What it is |
| --- | --- |
| `scripts/chrome-headless.sh` | Standalone launcher (defaults to the headless shell under `/opt/chrome-for-testing`) |
| `scripts/chrome-headless.service` | systemd unit so the browser stays up; template — adjust paths if launcher/binaries live elsewhere |
| `scripts/cap-tabs.mjs` | Closes the oldest page tabs over CDP (default max 10) |
| `cdp-manage/` | Optional token-authenticated control plane + dashboard for the shared browser |
