// media-dedup.js - perceptual media dedup for buff-bridge.
// Byte-exact hashing (worker side) misses independent re-uploads of the same
// photo/footage. This layer computes a perceptual hash (dHash) per image and
// 3 keyframe dHashes per video, and suppresses media that LOOKS the same as
// anything delivered in the last 14 days. Genuinely different angles survive:
// their hashes differ well beyond the Hamming threshold.
// Fail-open everywhere: any error -> media sends normally.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ACCOUNT = process.env.CF_ACCOUNT_ID;
const NAMESPACE = process.env.CF_KV_NAMESPACE_ID;
const TOKEN = process.env.CF_API_TOKEN;
const KV_KEY = 'phash_v1';
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${NAMESPACE}/values`;

const WINDOW_MS = 14 * 24 * 3600 * 1000; // 14-day memory, matches worker media memory
const IMG_THRESHOLD = 6;  // hamming distance (of 64 bits) => same-looking image
const VID_THRESHOLD = 6;  // per-frame threshold
const VID_MIN_FRAMES = 2; // >=2 of 3 keyframes must match for a video dupe

let Jimp = null;
try { ({ Jimp } = await import('jimp')); } catch { console.error('[dedup] jimp unavailable - image pHash disabled (fail-open)'); }
let ffmpegPath = process.env.FFMPEG_PATH || null;
if (!ffmpegPath) { try { ffmpegPath = (await import('ffmpeg-static')).default; } catch { ffmpegPath = null; } }
if (!ffmpegPath) ffmpegPath = 'ffmpeg'; // system binary, if any

// hash hex (16 chars) -> { ts, kind, tag }
const seen = new Map();
let dirty = false;
let stats = { checked: 0, suppressed: 0, errors: 0 };

function hexToBits(hex) { return BigInt('0x' + hex); }
function hamming(a, b) {
  let x = hexToBits(a) ^ hexToBits(b), n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

// 64-bit dHash: resize to 9x8 grayscale, compare horizontal neighbors.
// Returns null on decode failure or a low-variance (blank) frame.
async function dhashBuffer(buf) {
  if (!Jimp) return null;
  const img = await Jimp.read(buf);
  img.resize({ w: 9, h: 8 }).greyscale();
  const px = img.bitmap.data; // RGBA
  const g = [];
  let mean = 0;
  for (let i = 0; i < 72; i++) { const v = px[i * 4]; g.push(v); mean += v; }
  mean /= 72;
  let varSum = 0;
  for (const v of g) varSum += (v - mean) * (v - mean);
  if (Math.sqrt(varSum / 72) < 8) return null; // near-blank frame: useless for dedup
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    bits <<= 1n;
    if (g[y * 9 + x] > g[y * 9 + x + 1]) bits |= 1n;
  }
  return bits.toString(16).padStart(16, '0');
}

function runFFmpeg(args, inputBuf) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }));
    if (inputBuf) p.stdin.write(inputBuf);
    p.stdin.end();
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} reject(new Error('ffmpeg timeout')); }, 45000);
  });
}

// 3 keyframe dHashes for a video buffer; null when extraction impossible.
// MP4 needs a seekable input (moov atom), so go through a temp file, not a pipe.
async function videoHashes(buf) {
  const tmp = path.join(os.tmpdir(), 'dedup-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.mp4');
  try {
    fs.writeFileSync(tmp, buf);
    const probe = await runFFmpeg(['-i', tmp, '-f', 'null', '-']);
    const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe.stderr);
    const dur = m ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) : 0;
    const ats = dur > 2 ? [dur * 0.15, dur * 0.5, dur * 0.85] : [0.5, 1.5, 3];
    const frames = await Promise.all(ats.map((t) =>
      runFFmpeg(['-ss', t.toFixed(2), '-i', tmp, '-an', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'])));
    const hashes = [];
    for (const r of frames) {
      if (!r.stdout.length) continue;
      const h = await dhashBuffer(r.stdout);
      if (h) hashes.push(h);
    }
    return hashes.length >= VID_MIN_FRAMES ? hashes : null;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function evict() {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [k, v] of seen) if (v.ts < cutoff) seen.delete(k);
}

function findDupeImage(h) {
  for (const [k, v] of seen) {
    if (v.kind !== 'img') continue;
    const d = hamming(h, k);
    if (d <= IMG_THRESHOLD) return { dist: d, prev: v };
  }
  return null;
}
function findDupeVideo(hashes) {
  for (const [k, v] of seen) {
    if (v.kind !== 'vid') continue;
    const prevHashes = k.split(',');
    let matches = 0, best = 99;
    for (const h of hashes) {
      let b = 99;
      for (const ph of prevHashes) b = Math.min(b, hamming(h, ph));
      best = Math.min(best, b);
      if (b <= VID_THRESHOLD) matches++;
    }
    if (matches >= VID_MIN_FRAMES) return { dist: best, prev: v };
  }
  return null;
}

async function kvRestore() {
  if (!ACCOUNT || !NAMESPACE || !TOKEN) return;
  try {
    const r = await fetch(`${API}/${encodeURIComponent(KV_KEY)}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    if (r.status === 404) return;
    if (!r.ok) throw new Error('KV GET ' + r.status);
    const arr = JSON.parse(await r.text());
    for (const [k, v] of arr) seen.set(k, v);
    evict();
    console.log(`[dedup] restored ${seen.size} phashes from KV`);
  } catch (e) { console.error('[dedup] KV restore failed (fail-open):', e.message); }
}
async function kvFlush(force) {
  if (!dirty && !force) return;
  if (!ACCOUNT || !NAMESPACE || !TOKEN) return;
  try {
    evict();
    const body = JSON.stringify([...seen.entries()]);
    const r = await fetch(`${API}/${encodeURIComponent(KV_KEY)}`, {
      method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body
    });
    if (!r.ok) throw new Error('KV PUT ' + r.status);
    dirty = false;
  } catch (e) { console.error('[dedup] KV flush failed:', e.message); }
}

export async function initDedup() {
  await kvRestore();
  setInterval(() => kvFlush(false), 5 * 60 * 1000).unref(); // slow dirty flush; KV write budget safe (~12/hr max, only when dirty)
  const onExit = () => kvFlush(true).finally(() => process.exit(0));
  process.on('SIGTERM', onExit); // kv-auth-store has its own; both run
  process.on('SIGINT', onExit);
}

// Returns { dupe:true, dist, prevAt } when media is same-looking as something
// already delivered in the window; { dupe:false } otherwise. Fail-open.
export async function checkMedia({ imageUrl, videoUrl }) {
  const url = imageUrl || videoUrl;
  const kind = imageUrl ? 'img' : 'vid';
  const tag = url.split('/').pop().slice(0, 40);
  stats.checked++;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('media GET ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (kind === 'img') {
      const h = await dhashBuffer(buf);
      if (!h) return { dupe: false };
      const hit = findDupeImage(h);
      if (hit) {
        stats.suppressed++;
        console.log(`[dedup] SUPPRESSED image dupe dist=${hit.dist} tag=${tag} prevAt=${new Date(hit.prev.ts).toISOString()}`);
        return { dupe: true, dist: hit.dist, prevAt: hit.prev.ts };
      }
      seen.set(h, { ts: Date.now(), kind, tag }); dirty = true;
      return { dupe: false };
    }
    const hashes = await videoHashes(buf);
    if (!hashes) return { dupe: false };
    const hit = findDupeVideo(hashes);
    if (hit) {
      stats.suppressed++;
      console.log(`[dedup] SUPPRESSED video dupe dist=${hit.dist} tag=${tag} prevAt=${new Date(hit.prev.ts).toISOString()}`);
      return { dupe: true, dist: hit.dist, prevAt: hit.prev.ts };
    }
    seen.set(hashes.join(','), { ts: Date.now(), kind, tag }); dirty = true;
    return { dupe: false };
  } catch (e) {
    stats.errors++;
    console.error(`[dedup] check failed (fail-open) tag=${tag}:`, e.message);
    return { dupe: false };
  }
}

export function dedupStatus() {
  return { enabled: !!Jimp, ffmpeg: !!ffmpegPath, size: seen.size, ...stats };
}
