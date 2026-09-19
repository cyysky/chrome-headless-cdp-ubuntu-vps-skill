#!/usr/bin/env node
// cdp-manage - token-authenticated control plane for the headless Chrome that
// chrome-headless.service exposes on 127.0.0.1:9222.
//
// The CDP endpoint has no authentication and is bound to loopback, so it cannot
// be driven from another machine (and must not be published). This service fronts
// it with a JSON API, an SSE event feed and a dashboard, enforces a tab cap so
// the shared browser cannot be exhausted, and can be reached over the LAN or
// WireGuard with a bearer token.
//
// Playwright and other websocket CDP clients can connect to the shared browser
// through the same token gate: chromium.connectOverCDP(
//   "ws://<host>:<port>/pw?token=<token>").
//
// Zero dependencies: Node >= 22 built-ins only (http, fetch, WebSocket).
//
// Configuration (environment):
//   MGMT_BIND            listen address            (default 0.0.0.0)
//   MGMT_PORT            listen port               (default 9300)
//   MGMT_TOKEN           bearer token, required    (generated if unset)
//   CDP_HTTP             CDP base URL             (default http://127.0.0.1:9222)
//   MGMT_MAX_TABS        open page cap            (default 10)
//   MGMT_TIMEOUT_MS      per-operation timeout   (default 30000)
//   MGMT_MAX_TEXT_CHARS  text extraction cap     (default 200000)

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect as netConnect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const num = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const CONFIG = {
  bind: process.env.MGMT_BIND || "0.0.0.0",
  port: num("MGMT_PORT", 9300),
  token: process.env.MGMT_TOKEN || "",
  cdpHttp: (process.env.CDP_HTTP || "http://127.0.0.1:9222").replace(/\/+$/, ""),
  maxTabs: num("MGMT_MAX_TABS", 10),
  timeoutMs: num("MGMT_TIMEOUT_MS", 30000),
  maxTextChars: num("MGMT_MAX_TEXT_CHARS", 200000),
};

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_VIEWPORT = 4000;
const MAX_FULL_HEIGHT = 20000;

// Browser-level CDP relay for Playwright (chromium.connectOverCDP) and other
// websocket clients: ws://<host>:<port>/pw?token=<token> -> the browser
// endpoint on the CDP port. Raw byte relay, so websocket framing, masking and
// fragmentation pass through untouched.
const CDP_URL = new URL(CONFIG.cdpHttp);
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WS_PATHS = new Set(["/pw", "/cdp"]);
const relays = new Set();

class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// ---------------------------------------------------------------------------
// CDP client: one browser-level websocket, flat sessions per page target.
// ---------------------------------------------------------------------------

class CdpBrowser {
  #ws = null;
  #nextId = 1;
  #pending = new Map();
  #connecting = null;
  #listeners = new Set();
  #sessions = new Map();
  #sessionTargets = new Map();

  constructor(httpBase, timeoutMs) {
    this.httpBase = httpBase;
    this.timeoutMs = timeoutMs;
  }

  async #httpJson(path) {
    let res;
    try {
      res = await fetch(this.httpBase + path);
    } catch (err) {
      throw new HttpError(502, `CDP endpoint unreachable: ${err.message}`);
    }
    if (!res.ok) throw new HttpError(502, `CDP ${path} -> HTTP ${res.status}`);
    return res.json();
  }

  version() {
    return this.#httpJson("/json/version");
  }

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not take the service down.
      }
    }
  }

  async #open() {
    const { webSocketDebuggerUrl } = await this.version();
    if (!webSocketDebuggerUrl) {
      throw new HttpError(502, "CDP exposes no webSocketDebuggerUrl");
    }
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new HttpError(504, "CDP websocket connect timed out")), 10000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new HttpError(502, "CDP websocket failed to connect"));
      }, { once: true });
    });
    ws.addEventListener("message", (event) => this.#onMessage(event.data));
    ws.addEventListener("close", () => this.#onClose(ws));
    ws.addEventListener("error", () => {});
    this.#ws = ws;
    await this.send("Target.setDiscoverTargets", { discover: true });
  }

  async connect() {
    if (this.#ws && this.#ws.readyState === 1) return;
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#open().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  #onClose(ws) {
    if (this.#ws !== ws) return;
    this.#ws = null;
    this.#sessions.clear();
    this.#sessionTargets.clear();
    for (const [, pending] of this.#pending) {
      pending.reject(new HttpError(503, "CDP websocket closed"));
    }
    this.#pending.clear();
    this.#emit({ type: "disconnected" });
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new HttpError(502, msg.error.message, msg.error));
      } else {
        pending.resolve(msg.result ?? {});
      }
      return;
    }
    if (msg.method === "Target.attachedToTarget") {
      const { targetInfo, sessionId } = msg.params;
      this.#sessions.set(targetInfo.targetId, sessionId);
      this.#sessionTargets.set(sessionId, targetInfo.targetId);
    } else if (msg.method === "Target.detachedFromTarget") {
      const targetId = this.#sessionTargets.get(msg.params.sessionId);
      if (targetId) {
        this.#sessions.delete(targetId);
        this.#sessionTargets.delete(msg.params.sessionId);
      }
    }
    this.#emit({ type: "cdp", method: msg.method, params: msg.params });
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const ws = this.#ws;
      if (!ws || ws.readyState !== 1) {
        reject(new HttpError(503, "CDP websocket is not connected"));
        return;
      }
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new HttpError(504, `${method} timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      ws.send(JSON.stringify(message));
    });
  }

  async call(method, params = {}, sessionId) {
    await this.connect();
    return this.send(method, params, sessionId);
  }

  async targets() {
    const { targetInfos } = await this.call("Target.getTargets");
    return targetInfos ?? [];
  }

  async attach(targetId) {
    await this.connect();
    const existing = this.#sessions.get(targetId);
    if (existing) return existing;
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    this.#sessions.set(targetId, sessionId);
    this.#sessionTargets.set(sessionId, targetId);
    return sessionId;
  }

  async detach(targetId) {
    const sessionId = this.#sessions.get(targetId);
    if (!sessionId) return;
    this.#sessions.delete(targetId);
    this.#sessionTargets.delete(sessionId);
    await this.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
}

const cdp = new CdpBrowser(CONFIG.cdpHttp, CONFIG.timeoutMs);

// ---------------------------------------------------------------------------
// Tab bookkeeping: creation order plus LRU, used by the cap and /prune.
// ---------------------------------------------------------------------------

const seen = new Map();

function touch(targetId) {
  const entry = seen.get(targetId) ?? { firstSeen: Date.now() };
  entry.lastUsed = Date.now();
  seen.set(targetId, entry);
  return entry;
}

function statsFor(targetId) {
  const entry = seen.get(targetId);
  return {
    firstSeen: entry?.firstSeen ? new Date(entry.firstSeen).toISOString() : null,
    lastUsed: entry?.lastUsed ? new Date(entry.lastUsed).toISOString() : null,
  };
}

async function pageTargets() {
  const targets = await cdp.targets();
  const pages = targets.filter((t) => t.type === "page");
  const live = new Set(pages.map((t) => t.targetId));
  for (const id of [...seen.keys()]) {
    if (!live.has(id)) seen.delete(id);
  }
  for (const page of pages) {
    if (!seen.has(page.targetId)) touch(page.targetId);
  }
  return pages;
}

function describe(target) {
  return {
    id: target.targetId,
    type: target.type,
    title: target.title || "",
    url: target.url || "",
    attached: Boolean(target.attached),
    openerId: target.openerId ?? null,
    ...statsFor(target.targetId),
  };
}

async function requirePage(targetId) {
  const pages = await pageTargets();
  const page = pages.find((t) => t.targetId === targetId);
  if (!page) throw new HttpError(404, `no page target ${targetId}`);
  touch(targetId);
  return page;
}

async function evictToFit(max, protect = new Set()) {
  const pages = await pageTargets();
  const victims = pages
    .filter((t) => !protect.has(t.targetId))
    .sort((a, b) => (seen.get(a.targetId)?.lastUsed ?? 0) - (seen.get(b.targetId)?.lastUsed ?? 0));
  const evicted = [];
  while (pages.length - evicted.length > max && victims.length > 0) {
    const victim = victims.shift();
    await cdp.call("Target.closeTarget", { targetId: victim.targetId });
    evicted.push({ id: victim.targetId, url: victim.url, title: victim.title });
  }
  return evicted;
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function waitForReady(sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { result } = await cdp.send("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      }, sessionId);
      if (result?.value === "complete") return true;
    } catch {
      // Context is being swapped mid-navigation; retry until the deadline.
    }
    await sleep(200);
  }
  return false;
}

async function navigate(targetId, url, { wait = true, timeoutMs = CONFIG.timeoutMs } = {}) {
  const sessionId = await cdp.attach(targetId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  const result = await cdp.send("Page.navigate", { url }, sessionId);
  if (result.errorText) throw new HttpError(502, `navigation failed: ${result.errorText}`);
  const loaded = wait ? await waitForReady(sessionId, timeoutMs) : false;
  return { frameId: result.frameId, loaderId: result.loaderId, loaded };
}

async function evaluate(targetId, expression, { awaitPromise = false, timeoutMs = CONFIG.timeoutMs } = {}) {
  const sessionId = await cdp.attach(targetId);
  await cdp.send("Runtime.enable", {}, sessionId);
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  }, sessionId);
  if (exceptionDetails) {
    const text = exceptionDetails.exception?.description || exceptionDetails.text || "evaluation failed";
    throw new HttpError(422, text);
  }
  return result?.value;
}

async function readPage(targetId, limit, waitMs = 15000) {
  const sessionId = await cdp.attach(targetId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  // A tab that was just opened in the background can still be loading; reading it
  // straight away would report an empty body, so give it a bounded chance first.
  if (waitMs > 0) await waitForReady(sessionId, waitMs);
  const expression = `(() => {
    const body = document.body ? document.body.innerText : "";
    return {
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      text: body,
      textLength: body.length,
      links: [...document.querySelectorAll("a[href]")].slice(0, 200).map((a) => ({ text: (a.innerText || "").trim().slice(0, 120), href: a.href })),
      resources: performance.getEntriesByType("resource").slice(0, 200).map((r) => ({ name: r.name, type: r.initiatorType, duration: Math.round(r.duration) })),
    };
  })()`;
  const value = await evaluate(targetId, expression);
  if (typeof value?.text === "string" && value.text.length > limit) {
    value.text = value.text.slice(0, limit);
    value.truncated = true;
  }
  return value;
}

async function screenshot(targetId, { full = false, width = 1280, height = 800 } = {}) {
  const sessionId = await cdp.attach(targetId);
  await cdp.send("Page.enable", {}, sessionId);
  // Headless Chrome throttles background tabs, so Page.captureScreenshot on a tab
  // that was opened in the background can stall for tens of seconds (or hit the
  // command timeout). Foregrounding it first brings the capture down to ~100 ms.
  await cdp.call("Target.activateTarget", { targetId });
  await cdp.send("Page.bringToFront", {}, sessionId);
  const viewport = {
    width: clamp(Math.round(width), 64, MAX_VIEWPORT),
    height: clamp(Math.round(height), 64, MAX_VIEWPORT),
    deviceScaleFactor: 1,
    mobile: false,
  };
  await cdp.send("Emulation.setDeviceMetricsOverride", viewport, sessionId);
  try {
    const params = { format: "png", fromSurface: true };
    if (full) {
      const metrics = await cdp.send("Page.getLayoutMetrics", {}, sessionId);
      const size = metrics.cssContentSize ?? metrics.contentSize;
      if (size?.width && size?.height) {
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: clamp(Math.ceil(size.width), 64, MAX_VIEWPORT),
          height: clamp(Math.ceil(size.height), 64, MAX_FULL_HEIGHT),
          deviceScaleFactor: 1,
          mobile: false,
        }, sessionId);
      }
      params.captureBeyondViewport = true;
    }
    const { data } = await cdp.send("Page.captureScreenshot", params, sessionId);
    return Buffer.from(data, "base64");
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride", {}, sessionId).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

const tokenDigest = (value) => createHash("sha256").update(String(value)).digest();
const expectedDigest = tokenDigest(CONFIG.token);

function authorized(req, url) {
  const header = req.headers.authorization || "";
  const provided = header.replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || "";
  if (!provided) return false;
  return timingSafeEqual(tokenDigest(provided), expectedDigest);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch (err) {
        reject(new HttpError(400, `invalid JSON body: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

const sseClients = new Set();

cdp.onEvent((event) => {
  if (sseClients.size === 0) return;
  const name = event.type === "cdp" ? event.method.replace(/^Target\./, "") : event.type;
  const payload = JSON.stringify(event);
  for (const res of sseClients) {
    res.write(`event: ${name}\ndata: ${payload}\n\n`);
  }
});

setInterval(() => {
  for (const res of sseClients) res.write(": ping\n\n");
}, 25000).unref();

function streamEvents(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.write("retry: 3000\n\n");
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
}

async function health() {
  const info = await cdp.version();
  const pages = await pageTargets();
  return {
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    chrome: {
      browser: info.Browser,
      userAgent: info.UserAgent,
      protocolVersion: info["Protocol-Version"],
      endpoint: CONFIG.cdpHttp,
    },
    tabs: { count: pages.length, max: CONFIG.maxTabs },
  };
}

async function route(req, res, url) {
  const method = req.method.toUpperCase();
  const segments = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/healthz") {
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/" && method === "GET") {
    const html = await readFile(join(HERE, "public", "index.html"), "utf8").catch(() => null);
    if (!html) return sendJson(res, 500, { error: "dashboard asset missing" });
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
      "cache-control": "no-store",
    });
    return res.end(html);
  }

  if (!url.pathname.startsWith("/api/")) {
    return sendJson(res, 404, { error: "not found" });
  }
  if (!authorized(req, url)) {
    return sendJson(res, 401, { error: "missing or invalid token" });
  }

  if (url.pathname === "/api/events" && method === "GET") {
    return streamEvents(req, res);
  }

  if (url.pathname === "/api/health" && method === "GET") {
    return sendJson(res, 200, await health());
  }

  if (url.pathname === "/api/tabs") {
    if (method === "GET") {
      const pages = await pageTargets();
      return sendJson(res, 200, { tabs: pages.map(describe), max: CONFIG.maxTabs });
    }
    if (method === "POST") {
      const body = await readJson(req);
      const targetUrl = typeof body.url === "string" && body.url ? body.url : "about:blank";
      const created = await cdp.call("Target.createTarget", {
        url: targetUrl,
        background: body.background !== false,
      });
      touch(created.targetId);
      const evicted = body.evict === false ? [] : await evictToFit(CONFIG.maxTabs, new Set([created.targetId]));
      const pages = await pageTargets();
      const tab = pages.find((t) => t.targetId === created.targetId);
      return sendJson(res, 201, {
        tab: tab ? describe(tab) : { id: created.targetId, url: targetUrl },
        evicted,
        max: CONFIG.maxTabs,
      });
    }
    return sendJson(res, 405, { error: `method ${method} not allowed` });
  }

  if (url.pathname === "/api/tabs/close-all" && method === "POST") {
    const body = await readJson(req);
    const except = new Set(Array.isArray(body.except) ? body.except : []);
    const pages = await pageTargets();
    const closable = pages.filter((t) => !except.has(t.targetId));
    if (closable.length === pages.length && pages.length > 0) {
      const keep = pages.reduce((a, b) =>
        (seen.get(a.targetId)?.lastUsed ?? 0) <= (seen.get(b.targetId)?.lastUsed ?? 0) ? a : b);
      except.add(keep.targetId);
      closable.splice(closable.indexOf(keep), 1);
    }
    const closed = [];
    for (const page of closable) {
      await cdp.call("Target.closeTarget", { targetId: page.targetId });
      closed.push({ id: page.targetId, url: page.url, title: page.title });
    }
    return sendJson(res, 200, { closed, kept: [...except] });
  }

  if (url.pathname === "/api/tabs/prune" && method === "POST") {
    const body = await readJson(req);
    const keep = clamp(Math.round(Number(body.keep ?? CONFIG.maxTabs)), 1, 200);
    const evicted = await evictToFit(keep);
    return sendJson(res, 200, { keep, evicted });
  }

  if (segments[1] === "tabs" && segments[2]) {
    const targetId = segments[2];
    const action = segments[3] ?? null;

    if (!action && method === "GET") {
      const page = await requirePage(targetId);
      return sendJson(res, 200, { tab: describe(page) });
    }
    if (!action && method === "DELETE") {
      await requirePage(targetId);
      await cdp.detach(targetId);
      await cdp.call("Target.closeTarget", { targetId });
      return sendJson(res, 200, { closed: targetId });
    }
    if (action === "activate" && method === "POST") {
      await requirePage(targetId);
      await cdp.call("Target.activateTarget", { targetId });
      return sendJson(res, 200, { active: targetId });
    }
    if (action === "navigate" && method === "POST") {
      await requirePage(targetId);
      const body = await readJson(req);
      if (typeof body.url !== "string" || !body.url) {
        return sendJson(res, 400, { error: "url is required" });
      }
      const timeoutMs = clamp(Number(body.timeoutMs) || CONFIG.timeoutMs, 1000, 120000);
      const result = await navigate(targetId, body.url, { wait: body.wait !== false, timeoutMs });
      return sendJson(res, 200, { tab: describe(await requirePage(targetId)), ...result });
    }
    if (action === "reload" && method === "POST") {
      await requirePage(targetId);
      const body = await readJson(req);
      const sessionId = await cdp.attach(targetId);
      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Page.reload", { ignoreCache: Boolean(body.ignoreCache) }, sessionId);
      const timeoutMs = clamp(Number(body.timeoutMs) || CONFIG.timeoutMs, 1000, 120000);
      const loaded = body.wait === false ? false : await waitForReady(sessionId, timeoutMs);
      return sendJson(res, 200, { tab: describe(await requirePage(targetId)), loaded });
    }
    if (action === "eval" && method === "POST") {
      await requirePage(targetId);
      const body = await readJson(req);
      if (typeof body.expression !== "string" || !body.expression) {
        return sendJson(res, 400, { error: "expression is required" });
      }
      const value = await evaluate(targetId, body.expression, { awaitPromise: Boolean(body.awaitPromise) });
      return sendJson(res, 200, { result: value ?? null });
    }
    if (action === "text" && method === "GET") {
      await requirePage(targetId);
      const limit = clamp(Number(url.searchParams.get("limit")) || CONFIG.maxTextChars, 1, 5000000);
      const waitMs = clamp(Number(url.searchParams.get("waitMs") ?? 15000), 0, 60000);
      return sendJson(res, 200, await readPage(targetId, limit, waitMs));
    }
    if (action === "screenshot" && method === "GET") {
      await requirePage(targetId);
      const full = ["1", "true", "yes"].includes(String(url.searchParams.get("full") || "").toLowerCase());
      const png = await screenshot(targetId, {
        full,
        width: Number(url.searchParams.get("width")) || 1280,
        height: Number(url.searchParams.get("height")) || 800,
      });
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": png.length,
        "cache-control": "no-store",
      });
      return res.end(png);
    }
    return sendJson(res, 405, { error: `method ${method} not allowed for ${url.pathname}` });
  }

  return sendJson(res, 404, { error: "not found" });
}

// ---------------------------------------------------------------------------
// Playwright relay: ws://<host>:<port>/pw?token=<token> (or /cdp) pipes raw
// websocket bytes to the browser-level CDP endpoint, so Playwright clients and
// other websocket CDP clients can drive the shared browser through the token gate.
// ---------------------------------------------------------------------------

function rejectUpgrade(socket, status, reason) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
  socket.destroy();
}

function upstreamHandshake(upstreamUrl, key) {
  return [
    `GET ${upstreamUrl.pathname}${upstreamUrl.search} HTTP/1.1`,
    `Host: ${upstreamUrl.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n");
}

async function proxyCdp(req, socket, head) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!WS_PATHS.has(url.pathname)) return rejectUpgrade(socket, 404, "Not Found");
  if (!authorized(req, url)) return rejectUpgrade(socket, 401, "Unauthorized");

  const key = req.headers["sec-websocket-key"];
  if (!key) return rejectUpgrade(socket, 400, "Bad Request");

  let info;
  try {
    info = await cdp.version();
  } catch (err) {
    console.error(`[cdp-manage] relay: ${err.message}`);
    return rejectUpgrade(socket, 502, "Bad Gateway");
  }
  if (!info.webSocketDebuggerUrl) return rejectUpgrade(socket, 502, "Bad Gateway");

  const upstreamUrl = new URL(info.webSocketDebuggerUrl);
  const upstream = netConnect(upstreamUrl.port ? Number(upstreamUrl.port) : 80, upstreamUrl.hostname);
  upstream.setNoDelay(true);
  socket.setNoDelay(true);

  const abort = () => {
    relays.delete(socket);
    upstream.destroy();
    socket.destroy();
  };
  socket.on("error", abort);
  upstream.on("error", abort);
  socket.on("close", () => {
    relays.delete(socket);
    upstream.destroy();
  });
  upstream.on("close", () => {
    relays.delete(socket);
    socket.destroy();
  });

  upstream.once("connect", () => {
    upstream.write(upstreamHandshake(upstreamUrl, randomBytes(16).toString("base64")));
  });

  let buffered = Buffer.alloc(0);
  const onData = (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf("\r\n\r\n");
    if (end === -1) {
      if (buffered.length > 16384) abort();
      return;
    }
    upstream.off("data", onData);
    const header = buffered.subarray(0, end).toString("latin1");
    if (!/^HTTP\/1\.[01] 101/.test(header)) {
      console.error(`[cdp-manage] relay rejected upstream: ${header.split("\r\n")[0]}`);
      return rejectUpgrade(socket, 502, "Bad Gateway");
    }
    const protocols = req.headers["sec-websocket-protocol"];
    const lines = [
      "HTTP/1.1 101 Switching Protocols",
      "upgrade: websocket",
      "connection: Upgrade",
      `sec-websocket-accept: ${createHash("sha1").update(key + WS_GUID).digest("base64")}`,
    ];
    if (protocols) lines.push(`sec-websocket-protocol: ${String(protocols).split(",")[0].trim()}`);
    socket.write(lines.join("\r\n") + "\r\n\r\n");

    const extra = buffered.subarray(end + 4);
    if (extra.length) upstream.write(extra);
    if (head && head.length) upstream.write(head);
    relays.add(socket);
    console.log(`[cdp-manage] relay open ${url.pathname} -> ${upstreamUrl.host}${upstreamUrl.pathname}`);
    socket.pipe(upstream);
    upstream.pipe(socket);
  };
  upstream.on("data", onData);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  route(req, res, url).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    const body = { error: err.message ?? String(err) };
    if (err instanceof HttpError && err.detail) body.detail = err.detail;
    if (status >= 500) console.error(`[cdp-manage] ${req.method} ${url.pathname}:`, err);
    if (!res.headersSent) sendJson(res, status, body);
    else res.end();
  });
});

server.requestTimeout = 120000;
server.headersTimeout = 65000;

server.on("upgrade", (req, socket, head) => {
  proxyCdp(req, socket, head).catch((err) => {
    console.error(`[cdp-manage] relay failed:`, err);
    socket.destroy();
  });
});

function shutdown(signal) {
  console.log(`[cdp-manage] ${signal} received, shutting down`);
  for (const res of sseClients) res.end();
  sseClients.clear();
  for (const socket of relays) socket.destroy();
  relays.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

if (!CONFIG.token) {
  CONFIG.token = randomBytes(24).toString("base64url");
  console.warn(`[cdp-manage] MGMT_TOKEN unset, using ephemeral token: ${CONFIG.token}`);
}
if (!LOOPBACK.has(CONFIG.bind) && !process.env.MGMT_TOKEN) {
  console.warn(`[cdp-manage] listening on ${CONFIG.bind} with an ephemeral token; set MGMT_TOKEN to make it stable`);
}

server.listen(CONFIG.port, CONFIG.bind, () => {
  console.log(`[cdp-manage] listening on http://${CONFIG.bind}:${CONFIG.port} -> ${CONFIG.cdpHttp} (max ${CONFIG.maxTabs} tabs)`);
});
