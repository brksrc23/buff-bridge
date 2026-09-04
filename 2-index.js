// buff-bridge - WhatsApp linked-device bridge for buff-feed-bot (Render edition)
// Uses ONLY the canonical Baileys package (@whiskeysockets/baileys).
// Auth/session state is mirrored to Cloudflare KV (kv-auth-store.js) so it
// survives Render's ephemeral filesystem. One authenticated endpoint:
// POST /send with header "Authorization: <BRIDGE_SECRET>".

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import * as Baileys from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import { restoreAuthFromKV, startMirroring, flushNow, kvStatus, clearKVSnapshot } from './kv-auth-store.js';

const makeWASocket = Baileys.default?.default || Baileys.default;
const { useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason, Browsers } = Baileys;
const fetchVersion = Baileys.fetchLatestBaileysVersion || Baileys.fetchLatestWaWebVersion;

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0'; // Render routes inbound to PORT
const SECRET = process.env.BRIDGE_SECRET || '';
const RECIPIENT = (process.env.RECIPIENT || '14433793297').replace(/\D/g, '');
const AUTH_DIR = process.env.AUTH_DIR || path.join(process.cwd(), 'auth');
const PAIR_PHONE = (process.env.PAIR_PHONE || '').replace(/\D/g, '');
const USE_PAIRING_CODE = process.env.USE_PAIRING_CODE === '1'; // default: QR flow
const PAIR_KEY = process.env.PAIR_KEY || ''; // read-only key for the /pair page, /qr.png, /status - does NOT gate /send
const WORKER_URL = process.env.WORKER_URL || ''; // buff-feed-bot worker base URL for incoming command forwarding

if (!SECRET) { console.error('BRIDGE_SECRET env var is required'); process.exit(1); }

// minimal logger so we don't need pino as a direct dependency
const noop = () => {};
const logger = {
  level: 'warn',
  trace: noop, debug: noop, info: noop,
  warn: (...a) => console.warn('[baileys]', ...a),
  error: (...a) => console.error('[baileys]', ...a),
  fatal: (...a) => console.error('[baileys]', ...a),
  child() { return this; }
};

let sock = null;
let lastQR = null;
let lastQRAt = null;
let connected = false;
let ephemeralState = null; // last disappearing-messages set/readback on the feed chat
let registered = false;
let lastPairingCode = null;
let lastPairingAt = null;

// --- outbound bandwidth measurement (Render free tier: 5GB/month outbound) ---
// Estimates bytes LEAVING Render per send: media upload size + text + protocol
// overhead. Persisted as stats.json inside AUTH_DIR so it rides the KV mirror.
const STATS_FILE = path.join(AUTH_DIR, 'stats.json');
let stats = { month: '', bytesMonth: 0, msgsMonth: 0, day: '', bytesDay: 0, msgsDay: 0 };
let statsWriteTimer = null;

function loadStats() {
  try { Object.assign(stats, JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'))); } catch {}
  rollWindows();
}
function rollWindows() {
  const now = new Date();
  const m = now.toISOString().slice(0, 7);
  const d = now.toISOString().slice(0, 10);
  if (stats.month !== m) { stats.month = m; stats.bytesMonth = 0; stats.msgsMonth = 0; }
  if (stats.day !== d) { stats.day = d; stats.bytesDay = 0; stats.msgsDay = 0; }
}
function persistStats() {
  if (statsWriteTimer) return;
  statsWriteTimer = setTimeout(() => {
    statsWriteTimer = null;
    try { fs.mkdirSync(AUTH_DIR, { recursive: true }); fs.writeFileSync(STATS_FILE, JSON.stringify(stats)); } catch {}
  }, 30000); // at most one disk write per 30s; KV mirror batches these at a slow cadence
}
async function estimateOutboundBytes(payload) {
  let bytes = 1024; // WA protocol overhead per message
  if (payload.text) bytes += Buffer.byteLength(payload.text);
  const media = payload.imageUrl || payload.videoUrl;
  if (media) {
    try {
      const r = await fetch(media, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
      const len = parseInt(r.headers.get('content-length') || '0', 10);
      if (len > 0) bytes += len; // download is inbound (free); upload to WA is outbound
    } catch {}
  }
  return bytes;
}
async function recordSend(payload) {
  try {
    const est = await estimateOutboundBytes(payload);
    rollWindows();
    stats.bytesDay += est; stats.msgsDay += 1;
    stats.bytesMonth += est; stats.msgsMonth += 1;
    persistStats();
  } catch {}
}

async function start() {
  const restored = await restoreAuthFromKV(AUTH_DIR);
  loadStats();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  if (!state.creds.registered && state.creds.me && state.creds.me.id) { state.creds.registered = true; }
  registered = !!state.creds.registered;
  startMirroring(AUTH_DIR);
  let version;
  try { ({ version } = await fetchVersion()); } catch (e) { version = undefined; }

  sock = makeWASocket({
    ...(version ? { version } : {}),
    logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false
  });

  sock.ev.on('messages.upsert', (m) => {
    if (!WORKER_URL) return;
    for (const msg of (m.messages || [])) {
      try {
        if (!msg.message || msg.key.fromMe) continue;
        const from = (msg.key.remoteJid || '').replace(/@.*/, '');
        if (!/^\d+$/.test(from)) continue; // ignore groups/status
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        if (!text.trim()) continue;
        fetch(WORKER_URL + '/incoming', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: SECRET },
          body: JSON.stringify({ from, text: text.trim(), id: msg.key.id })
        }).then((r) => { if (!r.ok) console.error('incoming fwd HTTP', r.status); })
          .catch((e) => console.error('incoming fwd failed:', e.message));
      } catch (e) { console.error('incoming fwd error:', e.message); }
    }
  });

  sock.ev.on('creds.update', () => {
    if (!state.creds.registered && state.creds.me && state.creds.me.id) {
      state.creds.registered = true; // normalize: pair succeeded, flag lost to the rc14 companion_reg bug
      console.log('normalized creds.registered=true (me.id present)');
    }
    registered = !!state.creds.registered;
    saveCreds();
  });

  let pairingRequested = false;
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr && !state.creds.registered) {
      lastQR = qr; lastQRAt = new Date().toISOString();
      console.log('QR updated at ' + lastQRAt + ' (scan via GET /qr.png, auth required)');
      qrcode.generate(qr, { small: true });
      if (USE_PAIRING_CODE && PAIR_PHONE && !pairingRequested) {
        pairingRequested = true;
        try {
          const code = await sock.requestPairingCode(PAIR_PHONE);
          lastPairingCode = code;
          lastPairingAt = new Date().toISOString();
          console.log('\n==========================================');
          console.log('  PAIRING CODE: ' + code);
          console.log('  In the WhatsApp Business app (bot account):');
          console.log('  Settings > Linked Devices > Link a Device');
          console.log('  > "Link with phone number instead"');
          console.log('  Enter this code there.');
          console.log('==========================================\n');
        } catch (e) {
          console.error('pairing code failed: ' + e.message);
        }
      }
    }

    if (connection === 'open') {
      connected = true;
      registered = true;
      console.log('WhatsApp connected as', sock.user && sock.user.id);
      flushNow(AUTH_DIR); // paired/session refresh - persist promptly
      // 24h disappearing messages on the feed chat, set from the bot side (Ezra 2026-09-03). Re-asserted on every connect.
      try {
        const feedJid = RECIPIENT + '@s.whatsapp.net';
        await sock.sendMessage(feedJid, { disappearingMessagesInChat: 86400 });
        const chk = await sock.fetchDisappearingDuration(feedJid).catch(() => null);
        const dur = chk && chk[0] && (chk[0].result?.duration ?? chk[0].duration);
        ephemeralState = { set: 86400, readback: dur ?? null, at: new Date().toISOString() };
        console.log('ephemeral 86400 set on feed chat, readback:', dur);
      } catch (e) {
        ephemeralState = { set: null, error: String(e.message || e), at: new Date().toISOString() };
        console.error('ephemeral set failed:', e.message);
      }
    }

    if (connection === 'close') {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error('Logged out - clearing auth dir + KV snapshot, re-pairing in 5s');
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) { console.error('auth dir clear failed:', e.message); }
        try { await clearKVSnapshot(); } catch (e) { console.error('KV clear failed:', e.message); }
        registered = false;
        setTimeout(start, 5000);
        return;
      }
      console.log('connection closed (code ' + code + '), reconnecting in 3s');
      setTimeout(start, registered ? 3000 : 75000);
    }
  });
}

// disappearing messages: cache each chat's timer; send with ephemeralExpiration so messages honor it
// (without the option WhatsApp shows "sender may be on an old version" and nothing disappears - Baileys #1687). Fail-open.
const ephemeralCache = new Map(); // jid -> { duration, at }
async function ephemeralFor(jid) {
  const hit = ephemeralCache.get(jid);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.duration;
  let duration = 0;
  try {
    const res = await sock.fetchDisappearingDuration(jid);
    const row = Array.isArray(res) ? res[0] : res;
    duration = Number((row && (row.duration ?? row.disappearingMode?.duration)) || 0);
  } catch (e) { duration = 0; }
  ephemeralCache.set(jid, { duration, at: Date.now() });
  return duration;
}

async function sendToRecipient({ text, imageUrl, videoUrl, quoteId, to }) {
  const jid = ((to || RECIPIENT) + '').replace(/\D/g, '') + '@s.whatsapp.net';
  let content;
  if (imageUrl) content = { image: { url: imageUrl } };
  else if (videoUrl) content = { video: { url: videoUrl } };
  else if (text) content = { text };
  else throw new Error('body needs one of: text, imageUrl, videoUrl');

  const opts = quoteId ? { quoted: { key: { id: quoteId, remoteJid: jid, fromMe: true } } } : {};
  try { const dur = await ephemeralFor(jid); if (dur > 0) opts.ephemeralExpiration = dur; } catch (e) {}
  try {
    const res = await sock.sendMessage(jid, content, opts);
    return (res && res.key && res.key.id) || null;
  } catch (e) {
    if (opts.quoted) {
      const res = await sock.sendMessage(jid, content);
      return (res && res.key && res.key.id) || null;
    }
    throw e;
  }
}

const PAIR_HTML = `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>buff-bridge pairing</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;text-align:center;background:#111;color:#eee;padding-top:32px">
<h2>WhatsApp Business bridge pairing</h2>
<div id=state style="font-size:1.2em;margin:10px">loading...</div>
<img id=qr alt="pairing QR" style="width:320px;height:320px;background:#fff;padding:12px;border-radius:8px;display:none;margin:8px">
<div id=code style="font-size:2em;letter-spacing:4px;margin:10px;font-family:ui-monospace,monospace"></div>
<p style="color:#aaa;max-width:420px;margin:14px auto">WhatsApp Business app (bot account): Settings &gt; Linked Devices &gt; Link a Device &gt; scan the QR with the camera, or tap "Link with phone number instead" and type the code shown above.</p>
<script>
const key=new URLSearchParams(location.search).get('key');
let lastQr=null;
async function tick(){
  try{
    const s=await (await fetch('/status?key='+key)).json();
    if(s.connected){document.getElementById('state').textContent='PAIRED - connected as '+(s.user||'');document.getElementById('qr').style.display='none';document.getElementById('code').textContent='';return;}
    document.getElementById('state').textContent='Waiting for scan... (QR refreshes automatically)';
    if(s.qrAt&&s.qrAt!==lastQr){lastQr=s.qrAt;const img=document.getElementById('qr');img.src='/qr.png?key='+key+'&t='+Date.now();img.style.display='inline-block';}
    document.getElementById('code').textContent=s.pairingCode?('Code: '+s.pairingCode):'';
  }catch(e){document.getElementById('state').textContent='bridge unreachable, retrying...';}
}
tick();setInterval(tick,4000);
</script></body></html>`;
const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, 'http://local');
  const qk = reqUrl.searchParams.get('key');
  const authed = req.headers.authorization === SECRET || qk === SECRET;
  const pairAuthed = authed || (PAIR_KEY && (qk === PAIR_KEY || req.headers.authorization === PAIR_KEY));
  const reply = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && reqUrl.pathname === '/pair') {
    if (!pairAuthed) return reply(401, { error: 'bad auth' });
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    return res.end(PAIR_HTML);
  }
  if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true, connected, registered });
  if (req.method === 'GET' && reqUrl.pathname === '/ephemeral') {
    const key = reqUrl.searchParams.get('key') || '';
    if (!PAIR_KEY || key !== PAIR_KEY) return reply(401, { error: 'bad key' });
    if (!connected || !sock) return reply(503, { error: 'whatsapp not connected' });
    try {
      const feedJid = RECIPIENT + '@s.whatsapp.net';
      const chk = await sock.fetchDisappearingDuration(feedJid);
      const dur = chk && chk[0] && (chk[0].result?.duration ?? chk[0].duration);
      return reply(200, { ok: true, duration: dur ?? null, lastSet: ephemeralState });
    } catch (e) {
      return reply(502, { error: String(e.message || e), lastSet: ephemeralState });
    }
  }
  if (req.method === 'GET' && reqUrl.pathname === '/status') {
    if (!pairAuthed) return reply(401, { error: 'bad auth' });
    rollWindows();
    return reply(200, {
      connected, registered,
      pairingCode: registered ? null : lastPairingCode, pairingAt: lastPairingAt,
      qrAvailable: !registered && !!lastQR, qrAt: lastQRAt,
      kv: kvStatus(), user: sock?.user?.id || null,
      bandwidth: { day: stats.day, bytesDay: stats.bytesDay, msgsDay: stats.msgsDay,
                   month: stats.month, bytesMonth: stats.bytesMonth, msgsMonth: stats.msgsMonth,
                   estMBMonth: +(stats.bytesMonth / 1e6).toFixed(1), note: 'estimate: media upload size + text + 1KB/msg overhead; KV flush bytes in kv.flushedBytesTotal; authoritative figure is Render dashboard > Billing' }
    });
  }
  if (req.method === 'GET' && reqUrl.pathname === '/qr.png') {
    if (!pairAuthed) return reply(401, { error: 'bad auth' });
    if (registered || !lastQR) return reply(404, { error: registered ? 'already paired' : 'no qr yet' });
    try {
      const buf = await QRCode.toBuffer(lastQR, { type: 'png', scale: 10, margin: 2 });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      return res.end(buf);
    } catch (e) { return reply(500, { error: String((e && e.message) || e) }); }
  }
  if (req.method !== 'POST' || reqUrl.pathname !== '/send') return reply(404, { error: 'not found' });
  if (req.headers.authorization !== SECRET) return reply(401, { error: 'bad auth' });

  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    if (!connected || !sock) return reply(503, { error: 'whatsapp not connected' });
    let payload;
    try { payload = JSON.parse(body); } catch { return reply(400, { error: 'bad json' }); }
    try {
      const id = await sendToRecipient(payload);
      recordSend(payload);
      reply(200, { id });
    } catch (e) {
      reply(502, { error: String((e && e.message) || e) });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`buff-bridge listening on http://${HOST}:${PORT} - recipient ${RECIPIENT}`);
});
await start();
