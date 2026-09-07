#!/usr/bin/env node
// cap-tabs.mjs — Enforce a maximum number of open page tabs in the local
// Chromium instance by closing the oldest pages via CDP.
//
// Usage:
//   node cap-tabs.mjs [MAX]              # default MAX=10
//   CDP_HTTP=http://127.0.0.1:9222 node cap-tabs.mjs 10
//
// Ordering: uses the order returned by GET /json, which Chromium returns in
// visual tab-strip order (leftmost = oldest). This matches user expectation
// of "oldest tab" better than the order from Target.getTargets.
//
// Closing: uses Target.closeTarget over the browser WebSocket. The legacy
// /json/close/{id} endpoint was removed in Chrome 113+.

const MAX = Number.parseInt(process.argv[2] ?? '10', 10);
const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9222';

function log(msg) { process.stdout.write(msg + '\n'); }
function err(msg) { process.stderr.write(msg + '\n'); }

async function getJson(path) {
  const res = await fetch(`${CDP_HTTP}${path}`);
  if (!res.ok) throw new Error(`CDP ${path} → HTTP ${res.status}`);
  return res.json();
}

function rpc(ws) {
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
      else resolve(msg.result);
    }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timed out`)); }
    }, 5000);
  });
}

async function main() {
  if (!Number.isFinite(MAX) || MAX < 0) {
    err(`Invalid MAX: ${process.argv[2]}`);
    process.exit(2);
  }

  // 1. Enumerate page targets via /json — Chromium returns these in visual
  //    tab-strip order, so index 0 is the leftmost (oldest) tab.
  let pages;
  try {
    const all = await getJson('/json');
    pages = all.filter((t) => t.type === 'page');
  } catch (e) {
    err(`CDP unreachable at ${CDP_HTTP}: ${e.message}`);
    process.exit(1);
  }

  const excess = pages.length - MAX;
  if (excess <= 0) {
    log(`OK: ${pages.length}/${MAX} page(s) — no action`);
    return;
  }

  // 2. Open the browser WebSocket so we can call Target.closeTarget (the
  //    legacy /json/close/{id} endpoint was removed in Chrome 113+).
  let browserWs;
  try {
    const ver = await getJson('/json/version');
    browserWs = ver.webSocketDebuggerUrl;
    if (!browserWs) throw new Error('no webSocketDebuggerUrl');
  } catch (e) {
    err(`CDP /json/version failed: ${e.message}`);
    process.exit(1);
  }

  const ws = new WebSocket(browserWs);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket handshake failed')), { once: true });
  });
  const send = rpc(ws);

  const victims = pages.slice(0, excess);
  log(`Closing ${victims.length} oldest tab(s) (${pages.length} → ${MAX}):`);
  let closed = 0;
  for (const v of victims) {
    try {
      const { success } = await send('Target.closeTarget', { targetId: v.id });
      const label = v.url || v.title || v.id;
      log(`  ${success ? 'closed' : 'skipped'}: ${label}`);
      if (success) closed++;
    } catch (e) {
      err(`  error closing ${v.id}: ${e.message}`);
    }
  }
  log(`Done. ${closed}/${victims.length} closed; ${pages.length - closed} remain.`);

  ws.close();
  process.exit(closed > 0 ? 0 : 3);
}

main().catch((e) => { err(e.message); process.exit(1); });
