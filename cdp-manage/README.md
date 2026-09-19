# cdp-manage

Companion module to the [chrome-headless-cdp-ubuntu-vps](../) skill: a
token-authenticated control plane in front of the headless Chrome that
`chrome-headless.service` runs on the browser host.

The CDP endpoint (`127.0.0.1:9222`) has no authentication and is bound to
loopback, so it cannot be driven from another machine. `cdp-manage` fronts it with a
token-authenticated JSON API, a live dashboard, an SSE event feed, a
browser-level websocket for Playwright, and a tab cap so the shared browser cannot
be exhausted by a runaway script.

## Files

| File | Role |
|---|---|
| `server.mjs` | the service (Node >= 22 built-ins only, no npm install) |
| `public/index.html` | dashboard served at `/` |
| `cdp-manage.service` | systemd unit template, runs as `server` |
| `deploy.sh` | installer, runs as root on the browser host |

## Deploy

```bash
sudo bash deploy.sh
```

Installs in place: the unit is rewritten to the directory the script lives in,
`/etc/cdp-manage/env` is written (mode 600), `cdp-manage.service` is enabled and
restarted, and the token is printed so the caller can cache it.

Set `CDP_MANAGE_DEST` to install somewhere else (for example
`sudo CDP_MANAGE_DEST=/opt/cdp-manage bash deploy.sh`), and `CDP_MANAGE_USER` to
run as an account other than `server`. Do not install under `/tmp`: the unit sets
`PrivateTmp=true`, so the service sees an empty private `/tmp` and fails to start.

Then open `http://<browser-host>:9300/` for the dashboard. It asks for the token
once and keeps it in `localStorage`.

The unit needs the browser from the parent skill: it starts after
`chrome-headless.service` and talks to `CDP_HTTP` (default
`http://127.0.0.1:9222`).

## API

All `/api/*` routes need `Authorization: Bearer <token>` (or `?token=` for SSE and
one-off browser links).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Chrome version, endpoint, tab count and cap |
| `GET` | `/api/tabs` | page targets with title, url and LRU timestamps |
| `POST` | `/api/tabs` | open a tab: `{url, background, evict}` |
| `POST` | `/api/tabs/close-all` | close all but the newest, or `{except: [id]}` |
| `POST` | `/api/tabs/prune` | close LRU tabs down to `{keep}` |
| `GET` | `/api/tabs/:id` | one tab |
| `DELETE` | `/api/tabs/:id` | close a tab |
| `POST` | `/api/tabs/:id/navigate` | `{url, wait, timeoutMs}` |
| `POST` | `/api/tabs/:id/reload` | `{ignoreCache, wait}` |
| `POST` | `/api/tabs/:id/activate` | bring to front |
| `POST` | `/api/tabs/:id/eval` | `{expression, awaitPromise}` |
| `GET` | `/api/tabs/:id/text` | title, url, innerText, links, resources (`limit`, `waitMs`) |
| `GET` | `/api/tabs/:id/screenshot` | PNG (`full`, `width`, `height`) |
| `GET` | `/api/events` | SSE: target created/changed/destroyed |
| `GET` | `/healthz` | unauthenticated liveness probe |

Opening a tab past `MGMT_MAX_TABS` evicts the least-recently-used tab and reports
it in `evicted`; pass `"evict": false` to refuse instead.

```bash
TOKEN=$(sudo sed -n 's/^MGMT_TOKEN=//p' /etc/cdp-manage/env)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9300/api/health
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}' http://127.0.0.1:9300/api/tabs
```

Two behaviours worth knowing:

- `/text` waits up to 15 s for `document.readyState === "complete"` before
  reading, so a tab that was just opened does not report an empty body; pass
  `waitMs=0` to read whatever is there right now.
- `/screenshot` foregrounds the tab first. Headless Chrome throttles background
  tabs, and a capture from a background tab can otherwise stall for tens of seconds.

The dashboard polls the tab list every 5 s when `auto` is checked. Capture and text
output survive those refreshes for as long as the selected tab stays selected;
switching tabs resets the detail panel.

## Playwright

The token gate also fronts the browser-level CDP websocket, so Playwright can drive
the shared browser from another machine:

```js
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP(`ws://<browser-host>:9300/pw?token=${token}`);
const context = browser.contexts()[0];
const page = context.pages()[0] ?? await context.newPage();
```

`/cdp` is an alias for `/pw`, and the dashboard's "Playwright URL" button copies
the endpoint with the current token. `browser.close()` only drops the websocket; it
does not stop the shared browser or close pages you did not create.

The tab cap and LRU tracking apply to tabs opened through `/api/tabs`; pages a
Playwright client creates directly bypass them, so reclaim with `/api/tabs/prune`
(or the dashboard) when a script runs away.

## Configuration

`/etc/cdp-manage/env` (read by the unit, mode 600):

| Variable | Default | Notes |
|---|---|---|
| `MGMT_BIND` | `0.0.0.0` | set `127.0.0.1` to require an SSH tunnel |
| `MGMT_PORT` | `9300` | |
| `MGMT_TOKEN` | generated | bearer token |
| `CDP_HTTP` | `http://127.0.0.1:9222` | the Chrome endpoint |
| `MGMT_MAX_TABS` | `10` | open page cap |
| `MGMT_TIMEOUT_MS` | `30000` | per-CDP-command timeout |
| `MGMT_MAX_TEXT_CHARS` | `200000` | `/text` default cap |

## Security

- The `/pw` relay hands a client the browser-level endpoint, so a token holder
  can reach every context and page. Treat the token like full control of the browser.
- The token is the only gate: it travels in cleartext over plain HTTP, so keep the
  listener on the LAN or WireGuard, and set `MGMT_BIND=127.0.0.1` plus
  `ssh -N -L 9300:127.0.0.1:9300 user@<browser-host>` when off-network.
- The service never talks to Chrome's debug port from outside: `9222` stays on
  loopback and must not be published.
- Rotate the token with `MGMT_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | cut -c1-32)`
  in `/etc/cdp-manage/env`, then `systemctl restart cdp-manage`.
- The unit runs as `server` with `ProtectSystem=strict`, `ProtectHome=read-only`
  and `NoNewPrivileges`; it only ever opens a TCP connection to loopback.

## Limits

- The tab cap protects the browser, not the pages: a single tab can still pin CPU
  or memory. `prune` (or the dashboard) is the way to reclaim.
- Screenshots are capped at 4000 px wide and 20000 px tall for full-page captures.
- If Chrome is restarted, the service reconnects on the next request; no state is
  kept beyond the LRU timestamps.
