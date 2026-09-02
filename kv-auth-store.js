// kv-auth-store.js - mirror Baileys' multi-file auth dir into one Cloudflare KV blob.
// Render free tier has an ephemeral filesystem; this makes the WhatsApp session
// survive restarts, redeploys, and spindowns. One KV key, debounced writes
// (CF KV free plan = 1000 writes/day, so we batch instead of per-file writes).
import fs from 'node:fs';
import path from 'node:path';

const ACCOUNT = process.env.CF_ACCOUNT_ID;
const NAMESPACE = process.env.CF_KV_NAMESPACE_ID;
const TOKEN = process.env.CF_API_TOKEN;
const KV_KEY = process.env.KV_KEY || 'bridge:auth';

const DEBOUNCE_MS = 15000;   // write this long after the last fs change
const MIN_INTERVAL_MS = 30000; // never PUT more often than this
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${NAMESPACE}/values`;

let dirty = false;
let dirtyStatsOnly = false;
let timer = null;
let statsTimer = null;
let flushedBytesTotal = 0;
let lastFlush = 0;
let flushing = false;
let lastFlushOk = null;
let lastFlushAt = null;

async function kvGet() {
  const res = await fetch(`${API}/${encodeURIComponent(KV_KEY)}`, {
    headers: { authorization: `Bearer ${TOKEN}` }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV GET ${res.status}: ${await res.text()}`);
  return res.text();
}

async function kvPut(value) {
  const res = await fetch(`${API}/${encodeURIComponent(KV_KEY)}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: value
  });
  if (!res.ok) throw new Error(`KV PUT ${res.status}: ${await res.text()}`);
}


// Delete the KV snapshot entirely (used when WhatsApp logs the device out -
// the stored session is dead and must not be restored again).
export async function clearKVSnapshot() {
  if (!ACCOUNT || !NAMESPACE || !TOKEN) return;
  const res = await fetch(`${API}/${encodeURIComponent(KV_KEY)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${TOKEN}` }
  });
  if (!res.ok && res.status !== 404) throw new Error(`KV DELETE ${res.status}: ${await res.text()}`);
  dirty = false; dirtyStatsOnly = false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (statsTimer) { clearTimeout(statsTimer); statsTimer = null; }
}

// Load the snapshot from KV into the auth dir. Returns #files restored (0 = fresh).
export async function restoreAuthFromKV(dir) {
  if (!ACCOUNT || !NAMESPACE || !TOKEN) {
    console.log('[kv] CF_ACCOUNT_ID/CF_KV_NAMESPACE_ID/CF_API_TOKEN not set - auth is EPHEMERAL');
    return 0;
  }
  let snap;
  try { snap = await kvGet(); } catch (e) {
    console.error('[kv] restore failed, starting fresh:', e.message);
    return 0;
  }
  if (!snap) { console.log('[kv] no snapshot in KV - fresh auth'); return 0; }
  try {
    const files = JSON.parse(snap);
    fs.mkdirSync(dir, { recursive: true });
    let n = 0;
    for (const [name, content] of Object.entries(files)) {
      if (/[/\\]/.test(name)) continue; // never write outside dir
      fs.writeFileSync(path.join(dir, name), content);
      n++;
    }
    console.log(`[kv] restored ${n} auth files from KV (${snap.length} bytes)`);
    return n;
  } catch (e) {
    console.error('[kv] snapshot corrupt, starting fresh:', e.message);
    return 0;
  }
}

function snapshotDir(dir) {
  const files = {};
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    try { if (fs.statSync(p).isFile()) files[name] = fs.readFileSync(p, 'utf8'); } catch {}
  }
  return files;
}

export async function flushNow(dir) {
  if (flushing || !ACCOUNT || !TOKEN) return;
  flushing = true;
  try {
    const blob = JSON.stringify(snapshotDir(dir));
    await kvPut(blob);
    lastFlush = Date.now();
    lastFlushOk = true;
    lastFlushAt = new Date().toISOString();
    flushedBytesTotal += blob.length;
    dirty = false;
    dirtyStatsOnly = false;
    console.log(`[kv] flushed auth snapshot (${blob.length} bytes, ${Object.keys(JSON.parse(blob)).length} files)`);
  } catch (e) {
    lastFlushOk = false;
    console.error('[kv] flush failed:', e.message);
  } finally {
    flushing = false;
  }
}

function scheduleFlush(dir) {
  if (timer) clearTimeout(timer);
  const wait = Math.max(DEBOUNCE_MS, MIN_INTERVAL_MS - (Date.now() - lastFlush));
  timer = setTimeout(() => { timer = null; if (dirty) flushNow(dir); }, wait);
}

// stats.json changes alone get a slow flush (5 min); auth file changes flush fast.
const STATS_DEBOUNCE_MS = 300000;
function scheduleStatsFlush(dir) {
  if (statsTimer) return;
  statsTimer = setTimeout(() => { statsTimer = null; if (dirtyStatsOnly && !flushing) flushNow(dir); }, STATS_DEBOUNCE_MS);
}

// Watch the auth dir and persist snapshots on change, debounced.
export function startMirroring(dir) {
  if (!ACCOUNT || !NAMESPACE || !TOKEN) return;
  try {
    fs.watch(dir, (event, name) => {
      if (name === 'stats.json') { dirtyStatsOnly = true; if (!timer) scheduleStatsFlush(dir); }
      else { dirty = true; if (statsTimer) { clearTimeout(statsTimer); statsTimer = null; } scheduleFlush(dir); }
    });
  } catch (e) {
    console.error('[kv] fs.watch failed, falling back to 60s polling:', e.message);
  }
  // belt and braces: periodic dirty check (also covers fs.watch misses)
  setInterval(() => { if (dirty && !timer) scheduleFlush(dir); else if (dirtyStatsOnly && !statsTimer && !timer) scheduleStatsFlush(dir); }, 60000).unref();

  const onExit = async (sig) => {
    console.log(`[kv] ${sig} - final flush`);
    if (timer) { clearTimeout(timer); timer = null; }
    if (dirty || dirtyStatsOnly) await flushNow(dir);
    process.exit(0);
  };
  process.on('SIGTERM', () => onExit('SIGTERM'));
  process.on('SIGINT', () => onExit('SIGINT'));
  console.log('[kv] mirroring auth dir to KV key "' + KV_KEY + '"');
}

export function kvStatus() {
  return { configured: !!(ACCOUNT && NAMESPACE && TOKEN), key: KV_KEY, dirty, lastFlushOk, lastFlushAt, flushedBytesTotal };
}
