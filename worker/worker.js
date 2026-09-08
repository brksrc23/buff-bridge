// Buff Feed Bot v2 - X list timeline -> WhatsApp via buff-bridge (Cloudflare Worker, zero deps)
// Delivery: linked-device bridge (Baileys on Render) via BRIDGE_URL - no Meta Cloud API.
// Real-time only: posts that can't be delivered in the moment are DROPPED (no catch-up).
// Privacy: never sends read receipts.
// Required bindings: BUFF_KV (kv), X_LIST_ID (text), BRIDGE_URL (text), BRIDGE_SECRET (secret),
//   ADMIN_PHONE (text, e.g. 14433793297). Optional: STRIP_HANDLES, X_AUTH_TOKEN, X_CT0, VERIFY_TOKEN.

const X_BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const QID_LIST = "1LE3u14FJjPZUHKFGzos2g"; // ListLatestTweetsTimeline (seeded 2026-08-26)
const X_FEATURES = {
  rweb_lists_screen_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: false,
  post_ctas_fetch_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: false,
  responsive_web_grok_imagine_annotation_enabled: false,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_text_conversations_enabled: false,
  responsive_web_enhance_cards_enabled: false
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- X session + timeline (unchanged mechanics from v1) ----------

async function getXSession(env) {
  const raw = await env.BUFF_KV.get("x_session");
  if (raw) {
    try {
      const j = JSON.parse(raw);
      if (j.auth_token && j.ct0) return j;
    } catch (e) {}
  }
  return { auth_token: env.X_AUTH_TOKEN || "", ct0: env.X_CT0 || "" };
}

async function fetchListTimeline(env, cursor) {
  const sess = await getXSession(env);
  const vars = { listId: env.X_LIST_ID, count: 20 };
  if (cursor) vars.cursor = cursor;
  const url = `https://x.com/i/api/graphql/${QID_LIST}/ListLatestTweetsTimeline?variables=${encodeURIComponent(JSON.stringify(vars))}&features=${encodeURIComponent(JSON.stringify(X_FEATURES))}`;
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${X_BEARER}`,
      "x-csrf-token": sess.ct0,
      cookie: `auth_token=${sess.auth_token}; ct0=${sess.ct0}`,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-client-language": "en"
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`X timeline HTTP ${res.status}`);
  return res.text();
}

// ---------- tweet extraction ----------

function tweetContent(result) {
  if (result && result.__typename === "TweetWithVisibilityResults") result = result.tweet;
  if (!result) return null;
  const legacy = result.legacy || {};
  const noteText = result.note_tweet?.note_tweet_results?.result?.text;
  const media = [];
  const ext = legacy.extended_entities?.media || [];
  for (const m of ext) {
    if (m.type === "photo") {
      media.push({ kind: "image", url: m.media_url_https });
    } else if (m.type === "video" || m.type === "animated_gif") {
      const variants = (m.video_info?.variants || []).filter((v) => v.content_type === "video/mp4");
      variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (variants.length) media.push({ kind: "video", url: variants[0].url, gif: m.type === "animated_gif" });
    }
  }
  return { text: noteText || legacy.full_text || "", media, legacy, result };
}

function handleOf(result) {
  const u = result?.core?.user_results?.result;
  return u?.core?.screen_name || u?.legacy?.screen_name || "unknown";
}

function nameOf(result) {
  const u = result?.core?.user_results?.result;
  return u?.core?.name || u?.legacy?.name || handleOf(result);
}

function extractTweets(payload) {
  const out = [];
  const instructions = payload?.data?.list?.tweets_timeline?.timeline?.instructions || [];
  for (const ins of instructions) {
    if (ins.type !== "TimelineAddEntries") continue;
    for (const entry of ins.entries || []) {
      if (!/^tweet-\d+/.test(entry.entryId || "")) continue;
      let result = entry?.content?.itemContent?.tweet_results?.result;
      if (!result) continue;
      if (result.__typename === "TweetWithVisibilityResults") result = result.tweet;
      if (!result) continue;
      const legacy = result.legacy || {};
      const userResult = result.core?.user_results?.result;
      const handle = handleOf(result);
      const name = nameOf(result);
      const authorId = userResult?.rest_id || legacy.user_id_str;

      const content = tweetContent(result);
      let kind = "post";
      let text = content.text;
      let media = content.media;
      let origHandle = null, origName = null, origText = null, quotedHandle = null, quotedName = null, quotedText = null;

      // Retweet: surface the ORIGINAL post's full text/media, label who retweeted.
      const rtRaw = legacy.retweeted_status_result?.result || result.retweeted_status_result?.result;
      const rt = tweetContent(rtRaw);
      if (rtRaw && rt) {
        kind = "retweet";
        origHandle = handleOf(rt.result);
        origName = nameOf(rt.result);
        origText = rt.text;
        if (rt.media.length) media = rt.media;
      }

      // Quote post: surface the comment AND the embedded post, each labeled.
      const qRaw = legacy.quoted_status_result?.result || result.quoted_status_result?.result;
      const q = tweetContent(qRaw);
      if (qRaw && q) {
        kind = kind === "retweet" ? kind : "quote";
        quotedHandle = handleOf(q.result);
        quotedName = nameOf(q.result);
        quotedText = q.text;
        if (!media.length && q.media.length) media = q.media;
      }

      out.push({
        id: legacy.id_str || result.rest_id,
        kind, text, media, handle, name, authorId,
        origHandle, origName, origText, quotedHandle, quotedName, quotedText,
        replyToStatusId: legacy.in_reply_to_status_id_str || null,
        replyToUserId: legacy.in_reply_to_user_id_str || null,
        postedAt: (rtRaw && rt ? (rt.legacy && rt.legacy.created_at) : null) || legacy.created_at || null
      });
    }
  }
  return out;
}

function stripLinks(text) {
  return text
    .replace(/https?:\/\/t\.co\/\w+/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- translation: non-English posts deliver original + English underneath ----------
// Standing rule (Ezra 2026-09-06): a non-English post that CANNOT be translated is DROPPED,
// never delivered untranslated. Rails: Gemini Interactions API first (reliable from Workers -
// the free Google gtx endpoint is effectively blocked from CF edge IPs, ~all calls failed),
// gtx as fallback with a 5-min dead-cache so a blocked gtx doesn't stall every post.
// withTranslation returns null when translation was needed but both rails failed.
let GTX_DEAD_UNTIL = 0;
function hasNonEnglish(text) {
  if (!text) return false;
  const stripped = text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{2018}\u{2019}\u{201C}\u{201D}\u{2013}\u{2014}\u{2026}©®™\u{20E3}\u{E0020}-\u{E007F}]/gu, "");
  return /[^\u0000-\u007F]/.test(stripped) && /\p{L}/u.test(stripped) && /\p{L}[^\u0000-\u007F]|[^\u0000-\u007F]\p{L}/u.test(stripped);
}
async function translateGtx(text) {
  if (Date.now() < GTX_DEAD_UNTIL) return null;
  try {
    const url = "https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=en&q=" + encodeURIComponent(text.slice(0, 4000));
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error("gtx HTTP " + res.status);
    const data = await res.json();
    const out = (Array.isArray(data) ? data : []).map(seg => seg && seg[0] || "").join("").trim();
    return out || null;
  } catch (e) { GTX_DEAD_UNTIL = Date.now() + 5 * 60 * 1000; return null; }
}
async function translateGemini(env, text) {
  try {
    const key = await getGeminiKey(env);
    if (!key) return null;
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ model: GEMINI_MODEL, input: "Translate this social media post to English. Output ONLY the translation, preserving names and numbers. If it is already in English, output it unchanged.\n\n" + text.slice(0, 4000), store: false, generation_config: { temperature: 0, max_output_tokens: 2000, thinking_level: "minimal" } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const out = (data.steps || []).filter((st) => st && st.type === "model_output").flatMap((st) => st.content || []).filter((c) => c && c.type === "text").map((c) => c.text || "").join("").trim();
    if (out) {
      const day = new Date().toISOString().slice(0, 10);
      const bsU = await loadBS(env);
      if (!bsU.gemCalls || bsU.gemCalls.day !== day) bsU.gemCalls = { day, n: 0 };
      bsU.gemCalls.n++; bsU.dirty = true;
    }
    return out || null;
  } catch (e) { return null; }
}
// returns translated string, "" when already-English (no block needed), null on total failure
async function translateToEnglish(env, text) {
  const g = await translateGemini(env, text);
  if (g !== null) return g.toLowerCase() === text.trim().toLowerCase() ? "" : g;
  const x = await translateGtx(text);
  if (x !== null) return x.toLowerCase() === text.trim().toLowerCase() ? "" : x;
  return null;
}
// null => untranslatable, caller drops the whole post (media included)
async function withTranslation(env, text) {
  const clean = text;
  if (!hasNonEnglish(clean)) return clean;
  const tr = await translateToEnglish(env, clean);
  if (tr === null) return null;
  if (tr === "") return clean;
  return clean + "\n\n----------\nEN: " + tr;
}

// ---------- message formatting: every message leads with bold Display Name (@handle) ----------

// v44: original posted timestamp under the username line (Ezra 2026-09-07). Twitter legacy.created_at
// format: "Mon Sep 07 18:04:12 +0000 2026". Unparseable -> line omitted, never a delivery blocker.
const TW_MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function parseTweetTime(s) {
  if (!s || typeof s !== "string") return null;
  const m = /^\w{3} (\w{3}) (\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4}) (\d{4})$/.exec(s);
  if (!m || !(m[1] in TW_MONTHS)) return null;
  const ms = Date.UTC(+m[7], TW_MONTHS[m[1]], +m[2], +m[3], +m[4], +m[5]);
  const off = parseInt(m[6], 10); // +0000 style
  return ms - (off >= 0 ? 1 : -1) * (Math.abs(off) >= 100 ? (Math.floor(Math.abs(off) / 100) * 3600e3 + (Math.abs(off) % 100) * 60e3) : 0);
}
function fmtPosted(ms) {
  if (!ms) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric", year: "2-digit", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(ms)).replace(/,\s*/, " "); // "9/7/26 2:04 PM" - Ezra's requested style
  } catch (e) { return null; }
}

async function formatBody(env, t) {
  // Ezra 2026-09-03: strip t.co/x.com links (content only, no URLs); non-English gets original + English underneath.
  // Returns null when a segment needs translation but both rails failed - caller drops the whole post (Ezra 2026-09-06 rule).
  const clean = async (s) => withTranslation(env, stripLinks(s || "") || "(link only)");
  const when = fmtPosted(parseTweetTime(t.postedAt));
  const tline = when ? `\n${when}` : "";
  if (t.kind === "retweet") {
    const c = await clean(t.origText); if (c === null) return null;
    return `*${t.name} (@${t.handle})* retweeted *${t.origName} (@${t.origHandle})*:${tline}\n\n${c}`;
  }
  if (t.kind === "quote") {
    const c1 = await clean(t.text); if (c1 === null) return null;
    const c2 = await clean(t.quotedText); if (c2 === null) return null;
    return `*${t.name} (@${t.handle})* commented:${tline}\n${c1}\n\n----------\n*${t.quotedName} (@${t.quotedHandle})* posted:\n${c2}`;
  }
  const c = await clean(t.text); if (c === null) return null;
  return `*${t.name} (@${t.handle})*${tline}\n\n${c}`;
}

// ---------- Shabbos hold (2026-09-04, Ezra) ----------
// Bot keeps polling/filtering/deduping, but WhatsApp delivery holds from candle-lighting Friday to tzeit
// hakochavim (72 min, err-longest) Saturday night. Times come from Hebcal for the configured zip, refreshed
// weekly and cached in KV shabbos_times. Held posts are retained with held:true; at window end ONE Gemini
// digest goes out, then live delivery resumes (held posts are already marked seen, so no backlog dump).
// KV overrides: shabbos_auto="0" disables entirely; shabbos_force="on"/"off" for testing;
// shabbos_zip changes the zmanim location (default Pikesville MD - Ezra's home base, followed even when traveling).
const SHABBOS_DEFAULT_ZIP = "21208";
async function fetchShabbosWindow(zip) {
  try {
    const res = await fetch("https://www.hebcal.com/shabbat?cfg=json&m=72&zip=" + encodeURIComponent(zip), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const items = (await res.json()).items || [];
    const candles = items.find((i) => i.category === "candles");
    const havs = items.filter((i) => i.category === "havdalah");
    const havdalah = havs[havs.length - 1]; // last havdalah covers multi-day yom tov spans
    if (!candles || !havdalah) return null;
    return { start: candles.date, end: havdalah.date, zip, fetchedAt: new Date().toISOString() };
  } catch (e) { return null; }
}
async function getShabbosWindow(env) {
  const zip = (await env.BUFF_KV.get("shabbos_zip")) || SHABBOS_DEFAULT_ZIP;
  const cached = await getJSON(env, "shabbos_times", null);
  const now = Date.now();
  if (cached && cached.zip === zip && cached.end && Date.parse(cached.end) > now) return cached;
  const fresh = await fetchShabbosWindow(zip);
  if (fresh) {
    try { await kvPut(env, "shabbos_times", JSON.stringify(fresh)); } catch (e) {}
    return fresh;
  }
  return cached && cached.end && Date.parse(cached.end) > now ? cached : null;
}
async function shabbosHoldActive(env) {
  try {
    const force = await env.BUFF_KV.get("shabbos_force");
    if (force === "on") return true;
    if (force === "off") return false;
    if ((await env.BUFF_KV.get("shabbos_auto")) === "0") return false;
    const win = await getShabbosWindow(env);
    if (win) {
      const now = Date.now();
      if (now >= Date.parse(win.start) && now < Date.parse(win.end)) return true;
    }
  } catch (e) {}
  // Fixed err-longer fallback, also UNIONED with the Hebcal window so a bad/missing fetch never shortens the hold
  try {
    const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const day = et.getDay(), mins = et.getHours() * 60 + et.getMinutes();
    if (day === 5 && mins >= 19 * 60 + 10) return true;
    if (day === 6 && mins < 20 * 60 + 40) return true;
  } catch (e) {}
  return false;
}

async function sendShabbosDigest(env, opts) {
  const o = opts || {};
  const items = o.items || (await getJSON(env, "shabbos_items", []));
  let text;
  if (!items.length) {
    text = "*Shabbos rundown*\nAll quiet - nothing passed the filter in the last day.";
  } else {
    const brief = items.slice(-200).map((t) => ({ account: "@" + t.handle, text: (t.text || t.origText || "").slice(0, 180) }));
    const prompt =
      "You are writing a Shabbos rundown: a full-spectrum recap of these news posts (about 25 hours) for one WhatsApp user who was offline. " +
      "Organize into topic SECTIONS with headers like *WORLD EVENTS*, *MIDDLE EAST*, *US POLITICS*, *WEATHER & DISASTERS*, *ECONOMY*, *OTHER* (use only sections that have content, most important first). " +
      "Within each section, merge updates about the same event into one entry and give the key developments as concise bullets. Cover the whole window, not just the biggest stories. " +
      "Apply the feed's editorial standard: leave out routine commentary, tabloid, celebrity, sports, lifestyle, non-warning weather, and local-interest filler - include only what a breaking-news follower would care about. " +
      "Plain text, WhatsApp formatting (*bold* headers, - bullets), no links, no hashtags. Posts:\n" +
      JSON.stringify(brief);
    let sections;
    try {
      const gemKey = await getGeminiKey(env);
      if (!gemKey) throw new Error("no gemini key");
      const res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": gemKey },
        body: JSON.stringify({ model: GEMINI_MODEL, input: prompt, store: false, generation_config: { temperature: 0.2, max_output_tokens: 4000, thinking_level: "minimal" } }),
        signal: AbortSignal.timeout(40000),
      });
      if (!res.ok) throw new Error("gemini HTTP " + res.status);
      const data = await res.json();
      const out = (data.steps || []).filter((st) => st && st.type === "model_output").flatMap((st) => st.content || []).filter((c) => c && c.type === "text").map((c) => c.text || "").join("").trim();
      if (!out) throw new Error("empty digest");
      sections = out;
    } catch (e) {
      // fallback: plain list of the most recent kept posts
      const lines = items.slice(-20).map((t) => "- " + (t.text || t.origText || "").split("\n")[0].slice(0, 120));
      sections = "*RECENT HEADLINES*\n" + lines.join("\n");
    }
    // split by whole sections if too long for one message (never mid-thought)
    const parts = [];
    let cur = "*Shabbos rundown*\n";
    for (const chunk of sections.split(/(?=^\*[A-Z][^*\n]{2,}\*\s*$)/m)) {
      if (cur.length + chunk.length > 3500 && cur.trim() !== "*Shabbos rundown*") { parts.push(cur); cur = ""; }
      if (chunk.length > 3500) { // a single oversized section: hard-wrap at line boundaries
        for (const line of chunk.split("\n")) {
          if (cur.length + line.length + 1 > 3500) { parts.push(cur); cur = ""; }
          cur += line + "\n";
        }
      } else cur += chunk;
    }
    if (cur.trim()) parts.push(cur);
    if (o.dryRun) return parts;
    for (const part of parts) { await deliverToAll(env, { text: part }); await sleep(400); }
    if (!o.items) { try { await env.BUFF_KV.delete("shabbos_items"); } catch (e) {} }
    return;
  }
  // empty-window path: text holds the "all quiet" note
  if (o.dryRun) return [text];
  await deliverToAll(env, { text });
  if (!o.items) { try { await env.BUFF_KV.delete("shabbos_items"); } catch (e) {} }
}

// ---------- bridge delivery ----------

async function bridgeSend(env, payload, to) {
  const res = await fetch(`${env.BRIDGE_URL}/send`, {
    method: "POST",
    headers: { authorization: env.BRIDGE_SECRET, "content-type": "application/json" },
    body: JSON.stringify({ ...payload, to }),
    signal: AbortSignal.timeout(20000)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`bridge send HTTP ${res.status}: ${json.error || "?"}`);
    err.bridgeDown = res.status === 503;
    throw err;
  }
  return json.id || null;
}

async function getSubscribers(env) {
  try { return JSON.parse((await env.BUFF_KV.get("subscribers")) || "[]"); } catch (e) { return []; }
}

// v41: returns { id, mediaDupe } so caption-folding can tell when the bridge perceptually suppressed
// the caption's carrier media and move the caption on. Other callers keep using bridgeSend directly.
async function bridgeSendFull(env, payload, to) {
  const res = await fetch(`${env.BRIDGE_URL}/send`, {
    method: "POST",
    headers: { authorization: env.BRIDGE_SECRET, "content-type": "application/json" },
    body: JSON.stringify({ ...payload, to }),
    signal: AbortSignal.timeout(20000)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`bridge send HTTP ${res.status}: ${json.error || "?"}`);
    err.bridgeDown = res.status === 503;
    throw err;
  }
  return json || {};
}
async function deliverToAll(env, payload) {
  // fan out to admin + subscribers who haven't paused themselves
  const subs = await getSubscribers(env);
  const targets = [String(env.ADMIN_PHONE).replace(/\D/g, "")];
  for (const s of subs) if (!s.paused && !targets.includes(s.phone)) targets.push(s.phone);
  let firstId = null, mediaDupe = false;
  for (const to of targets) {
    const r = await bridgeSendFull(env, payload, to);
    if (r.id) bsSentAdd(await loadBS(env), to, r.id); // Plan B auto-clear: blob-logged, purged 24h later by bsPurgeSent
    if (r.suppressed === "media-dupe") mediaDupe = true;
    if (!firstId) firstId = r.id;
    await sleep(250);
  }
  return { id: firstId, mediaDupe };
}


// ---------- Plan B: 24h auto-clear of the bot's own feed messages ----------
async function bridgeDelete(env, id, to) {
  const res = await fetch(`${env.BRIDGE_URL}/delete`, {
    method: "POST",
    headers: { authorization: env.BRIDGE_SECRET, "content-type": "application/json" },
    body: JSON.stringify({ id, to }),
    signal: AbortSignal.timeout(15000)
  });
  return res.ok;
}

async function purgeOldSent(env) {
  // Deletes the bot's own feed messages older than 24h (delete-for-everyone). Fail-open: never breaks the poll.
  try {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const list = await env.BUFF_KV.list({ prefix: "sent:" });
    let purged = 0;
    const names = list.keys.map((k) => k.name).slice(0, 80); // bound per run; the rest are caught by the next gated run
    const vals = await Promise.all(names.map((n) => env.BUFF_KV.get(n))); // parallel: sequential gets were adding 25-40s per tick
    for (let i = 0; i < names.length; i++) {
      const at = Number(vals[i]);
      if (!at || at > cutoff) continue;
      const k = { name: names[i] };
      const [, to, id] = k.name.split(":");
      const ok = await bridgeDelete(env, id, to).catch(() => false);
      if (ok) { await env.BUFF_KV.delete(k.name); purged++; }
      await sleep(200);
    }
    return purged;
  } catch (e) { return 0; }
}

// ---------- story-level dedup ----------
// Same story from multiple accounts = deliver once (first wins), later accounts suppressed.
// Fingerprint: normalized content tokens (URLs/mentions/stopwords stripped, diacritics folded, any script).
// Jaccard vs stories delivered in the last 24h; threshold 0.5. Fail-open: any doubt or error -> deliver.
const STORIES_KEY = "stories_v1";
const STOPWORDS = new Set(("a an the and or but if then else of at by for with about into over after before to from in on as is are was were be been it its this that these those he she they we you his her their our your not no yes says said say just now new breaking update watch video photos photo live rt via more will would can could has have had do does did who what when where why how all any both each few most other some such than too very own same so up out off again once here there also only first last amid against between during under trump president").split(" "));
// Fingerprint: content unigrams + entity candidates (capitalized tokens in cased scripts; every content token in
// non-cased scripts like Arabic/Hebrew). Dupe = entity containment >= 0.65 AND unigram containment >= 0.45
// (no entities -> unigram-only at 0.6). Containment (intersection over the smaller set) tolerates short vs long
// versions of the same headline; prefix-match (len>=5) folds inflections like canada/canadian.
function storyFp(text) {
  const raw = (text || "").replace(/https?:\/\/\S+/g, " ").replace(/@\w+/g, " ").replace(/^RT\s+/i, " ");
  const words = raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const u = new Set(), e = new Set();
  for (const w of words) {
    const lw = w.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (lw.length <= 2 || STOPWORDS.has(lw)) continue;
    u.add(lw);
    const latin = /^[A-Za-z\u00c0-\u024f]/.test(w);
    if (!latin || /^\p{Lu}/u.test(w)) e.add(lw);
  }
  return { u, e };
}
function tokEq(a, b) { return a === b || (a.length >= 5 && b.length >= 5 && (a.startsWith(b) || b.startsWith(a))); }
function contSim(a, b) {
  if (!a.size || !b.size) return 0;
  const small = a.size <= b.size ? a : b, large = a.size <= b.size ? b : a;
  let inter = 0;
  for (const w of small) { for (const v of large) { if (tokEq(w, v)) { inter++; break; } } }
  return inter / small.size;
}
function isStoryDupeFp(fp, stories) {
  if (fp.u.size < 4) return false; // too little signal -> deliver
  for (const s of stories) {
    const eu = new Set(s.e || []);
    const uni = contSim(fp.u, new Set(s.u || []));
    const ent = eu.size && fp.e.size ? contSim(fp.e, eu) : null;
    if (ent !== null ? (ent >= 0.65 && uni >= 0.45) : uni >= 0.6) return true;
  }
  return false;
}

// v39 (2026-09-07, approved by Ezra via parent): same-story 2h throttle - "things that were similar".
// A no-media follow-up matching a story DELIVERED within the last 2h is suppressed at a looser bar than
// isStoryDupeFp, UNLESS it introduces 2+ new entity tokens (the mechanical proxy for a real new angle /
// severity jump - those still deliver, per the standing event rule). Posts with media are never touched
// here (media = new angle by rule; exact media dupes are handled by media memory).
function newEntCount(fpE, storyE) {
  let n = 0;
  for (const w of fpE) { let found = false; for (const v of storyE) { if (tokEq(w, v)) { found = true; break; } } if (!found) n++; }
  return n;
}
function isStoryThrottleFp(fp, stories) {
  if (fp.u.size < 4) return false;
  const now = Date.now();
  for (const s of stories) {
    if (now - (s.at || 0) > 2 * 3600 * 1000) continue; // throttle window: 2h from last delivery of the story
    const uni = contSim(fp.u, new Set(s.u || []));
    const eu = new Set(s.e || []);
    const ent = eu.size && fp.e.size ? contSim(fp.e, eu) : null;
    const similar = ent !== null ? (ent >= 0.5 && uni >= 0.35) : uni >= 0.5;
    if (!similar) continue;
    if (eu.size && newEntCount(fp.e, eu) >= 2) continue; // real new angle -> deliver
    return true;
  }
  return false;
}
function isStoryDupeOrThrottle(fp, stories) { return isStoryDupeFp(fp, stories) || isStoryThrottleFp(fp, stories); }

// ---------- media dedup ----------
// Fingerprint media worker-side (Cloudflare egress is free; bridge->WhatsApp upload is the metered part).
// Images: full-byte SHA-256. Videos: SHA-256 over "size + first 1MB" (memory-safe, catches identical re-uploads).
// Returns null on any failure -> fail OPEN (deliver the media; never wrongly suppress).
async function mediaFingerprint(m) {
  try {
    if (m.kind === "image") {
      const res = await fetch(m.url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      const h = await crypto.subtle.digest("SHA-256", buf);
      return "img:" + [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    // video / gif (mp4): size + head bytes
    const res = await fetch(m.url, { headers: { Range: "bytes=0-1048575" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok && res.status !== 206) return null;
    const cr = res.headers.get("content-range"); // "bytes 0-1048575/12345678"
    const size = cr ? cr.split("/")[1] : (res.headers.get("content-length") || "?");
    const head = await res.arrayBuffer();
    const sizeBytes = new TextEncoder().encode(size + ":");
    const combo = new Uint8Array(sizeBytes.length + head.byteLength);
    combo.set(sizeBytes, 0); combo.set(new Uint8Array(head), sizeBytes.length);
    const h = await crypto.subtle.digest("SHA-256", combo.buffer);
    return "vid:" + [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (e) { return null; }
}

async function deliverTweet(env, t) {
  // v41 caption-folding (approved 2026-09-07 11:34): the post text rides the FIRST media the bridge accepts
  // as its caption, instead of a separate text message (~40% fewer messages; Ezra's "200 messages" complaint).
  // WhatsApp rejects captions >1024 chars, so bodies >1000 chars keep the old separate-text behavior.
  // If the bridge perceptually suppresses the carrier media, the caption moves to the next media; if no
  // media carries it (or the post has none), the text sends standalone exactly as before.
  // Returns { suppressed, untranslated }: media suppressed as exact duplicates; untranslated=1 when the post
  // was DROPPED because it needed translation and both rails failed (nothing delivered, media included).
  const body = await formatBody(env, t);
  if (body === null) return { suppressed: 0, untranslated: 1 };
  let suppressed = 0;
  const dedupOff = !!(await env.BUFF_KV.get("dedup_off"));
  const toSend = [];
  for (const m of t.media) {
    const fp = dedupOff ? null : await mediaFingerprint(m);
    if (fp) {
      const bsM = await loadBS(env);
      if (bsMediaHas(bsM, fp)) { suppressed++; continue; } // exact media already sent (boilerplate logos, cross-account re-uploads) - suppress, text+link still goes
      bsMediaSet(bsM, fp);
    }
    toSend.push(m);
  }
  const fold = body.length <= 1000;
  // v47b (approved 2026-09-08 16:25): over-cap posts fold a truncated ~990-char lead + "..." as the
  // caption so photo and text stay visually connected (Ezra's 3:59 PM split-photo); full text still follows.
  let caption = fold ? body : null;
  if (!fold) { const cut = body.slice(0, 990); const sp = cut.lastIndexOf(" "); caption = (sp > 600 ? cut.slice(0, sp) : cut).trimEnd() + "..."; }
  // v47a (bridge v7 album consolidation): the whole media set goes in ONE /send call - the bridge
  // dedups per item and delivers survivors as a single WhatsApp album with the caption on the first.
  // Same caption-migration contract as before: mediaDupe in the response means every media was
  // suppressed, so the text still goes standalone.
  if (toSend.length) {
    const payload = { mediaUrls: toSend.map((m) => ({ kind: m.kind, url: m.url })) };
    if (caption) payload.text = caption;
    const r = await deliverToAll(env, payload);
    if (caption && !(r && r.mediaDupe)) caption = null;
  }
  if (caption || !fold) await deliverToAll(env, { text: body });
  return { suppressed, untranslated: 0 };
}

// ---------- state helpers (batched KV keys to stay under free-tier write quota) ----------

// Fail-soft KV write: when the free-tier daily write budget is exhausted, puts throw - skip writes for 5 min
// instead of dying mid-tick, so polling/classification/digest continue (state just doesn't persist until reset).
let KV_DEAD_UNTIL = 0;
const RECENT_CLASSIFIED = new Set(); // isolate-local: backs up the gem:<id> KV cache while writes are degraded
const UNJUDGED_BACKOFF = new Map(); // v47: id -> { n, next } - escalating backoff on classifier-dead candidates (2026-09-08 neuron-cap retry storm)
async function kvPut(env, key, value, opts) {
  if (Date.now() < KV_DEAD_UNTIL) return false;
  try { await env.BUFF_KV.put(key, value, opts); return true; }
  catch (e) { if (/limit exceeded|10048|429|usage limit/i.test(String(e && e.message || e))) KV_DEAD_UNTIL = Date.now() + 5 * 60 * 1000; return false; } // v47: catch the 429/10048 shape too (yesterday's cap-trip kept retrying failed writes)
}

async function getJSON(env, key, fallback) {
  try { const v = await env.BUFF_KV.get(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
}

// ---------- v29: consolidated state blob - one KV read per tick, at most one throttled write ----------
// Replaces the per-item seen:/gem:/media:/sent: keys that were burning the free-tier daily read+write budgets.
const BS_KEY = "bs_v1";
const BS_SAVE_MIN_MS = 600000; // v45 (2026-09-07 KV-cap flood): one blob write per 10 min unless forced - 2-min cadence alone was ~720 of the 1,000/day free write budget
let BS_CACHE = null; // isolate-local
let COLD_GUARD_CUTOFF = 0; // v44c: set on cold load of a stale blob - see poll() guard
let RETAINED_PENDING = []; // feed_items backlog between 5-min flushes
let FEED_LAST_WRITE = 0;
let LAST_FORCE_SAVE = 0; // v46
async function loadBS(env) {
  if (BS_CACHE) return BS_CACHE;
  let d = null;
  try { d = JSON.parse((await env.BUFF_KV.get(BS_KEY)) || "null"); } catch (e) {}
  if (!d || d.v !== 1) d = { v: 1, born: 0, seen: [], gem: {}, media: {}, sent: [], stories: [], vol: null, gemCalls: null, lastPoll: null, lastDone: null, savedAt: 0, recentDel: [] };
  // v41 one-time purge: the pre-v40 verdict cache is poisoned with default-true entries (uncovered ids Gemini
  // skipped were cached as PASS). Wipe once per isolate on first load post-deploy; legit backlog re-classifies.
  if (d.gemPurgedV41 !== true) { d.gem = {}; d.gemPurgedV41 = true; d.dirty = true; }
  d.dirty = false;
  d.seenSet = new Set(d.seen);
  // v44c cold-start guard (2026-09-07 dupe flood): KV write cap let a stale isolate clobber the blob,
  // reverting the seen ring; fresh isolates then re-delivered. If this cold load is 3-45 min stale,
  // poll() suppresses anything posted at/before the last save (tweet ids embed post time) - those
  // posts were processed when the blob was written. Older than 45 min = genuine outage backlog: deliver.
  const staleMs = Date.now() - (d.savedAt || 0);
  if (d.savedAt && staleMs > 75000 && staleMs <= 45 * 60000) COLD_GUARD_CUTOFF = d.savedAt; // v46: floor 3min -> 75s, pairs with the 2-min force-save throttle - a blob older than ~1 min treats pre-save posts as already processed
  BS_CACHE = d;
  return d;
}
async function saveBS(env, bs, force) {
  if (!bs.dirty && !force) return false;
  if (!force && Date.now() - (bs.savedAt || 0) < BS_SAVE_MIN_MS) return false;
  // v47 merge-at-save: union with the persisted blob before writing, so a stale warm isolate can't clobber newer
  // state (2026-09-07 flood root + the gemCalls/recentDel counter wobble). One extra read per save; reads are cheap.
  try {
    const curRaw = await env.BUFF_KV.get(BS_KEY);
    const cur = curRaw ? JSON.parse(curRaw) : null;
    if (cur && cur.v === 1 && Array.isArray(cur.seen)) {
      const seenSet = new Set();
      const seenOrdered = [];
      for (const id of [...cur.seen, ...bs.seen]) { if (!seenSet.has(id)) { seenSet.add(id); seenOrdered.push(id); } }
      bs.seen = seenOrdered.slice(-1500); bs.seenSet = new Set(bs.seen);
      for (const k of Object.keys(cur.gem || {})) { const lv = bs.gem[k]; if (!lv || (cur.gem[k].at || 0) > (lv.at || 0)) bs.gem[k] = cur.gem[k]; }
      for (const k of Object.keys(cur.media || {})) { if (!bs.media[k]) bs.media[k] = cur.media[k]; }
      const rdMap = new Map();
      for (const x of [...(cur.recentDel || []), ...(bs.recentDel || [])]) { if (x && x.t) rdMap.set(String(x.t).slice(0, 120) + "@" + Math.floor((x.at || 0) / 120000), x); }
      bs.recentDel = [...rdMap.values()].sort((a, b) => a.at - b.at).filter((x) => Date.now() - x.at < 6 * 3600 * 1000).slice(-40);
      const day = new Date().toISOString().slice(0, 10);
      for (const f of ["gemCalls", "waiCalls"]) {
        const a = cur[f], b = bs[f];
        if (a && a.day === day && b && b.day === day) bs[f] = { day, n: Math.max(a.n || 0, b.n || 0) };
        else if (a && a.day === day && (!b || b.day !== day)) bs[f] = a;
      }
      if ((cur.lastDone || "") > (bs.lastDone || "")) bs.lastDone = cur.lastDone;
      if ((cur.lastPoll || "") > (bs.lastPoll || "")) bs.lastPoll = cur.lastPoll;
      const sentMap = new Map();
      for (const s of [...(cur.sent || []), ...(bs.sent || [])]) sentMap.set(JSON.stringify(s), s);
      bs.sent = [...sentMap.values()].slice(-400);
    }
  } catch (e) {}
  bs.savedAt = Date.now();
  const out = { ...bs };
  delete out.dirty; delete out.seenSet;
  let ok = await kvPut(env, BS_KEY, JSON.stringify(out));
  // v47b (approved 2026-09-08 16:25): one immediate retry on transient put failure - a silently failed
  // delivery-tick save left state unsaved for 28 min on 9/8, exposing the 45-min cold-guard cliff.
  if (!ok) { await new Promise((r) => setTimeout(r, 300)); ok = await kvPut(env, BS_KEY, JSON.stringify(out)); }
  if (ok) bs.dirty = false;
  return ok;
}
function bsSeenHas(bs, id) { return bs.seenSet.has(id); }
function bsSeenAdd(bs, id) {
  if (bs.seenSet.has(id)) return;
  bs.seen.push(id); bs.seenSet.add(id); bs.dirty = true;
  if (bs.seen.length > 1500) { bs.seen = bs.seen.slice(-1500); bs.seenSet = new Set(bs.seen); }
}
function bsGemGet(bs, id) { return bs.gem[id] || null; }
function bsGemSet(bs, id, gv) {
  bs.gem[id] = { d: gv.d, r: gv.r, at: Date.now() }; bs.dirty = true;
  const ks = Object.keys(bs.gem);
  if (ks.length > 600) { ks.sort((a, b) => bs.gem[a].at - bs.gem[b].at); for (const k of ks.slice(0, ks.length - 600)) delete bs.gem[k]; }
}
function bsMediaHas(bs, fp) { return !!bs.media[fp]; }
function bsMediaSet(bs, fp) {
  bs.media[fp] = Date.now(); bs.dirty = true;
  const ks = Object.keys(bs.media);
  if (ks.length > 600) { ks.sort((a, b) => bs.media[a] - bs.media[b]); for (const k of ks.slice(0, ks.length - 600)) delete bs.media[k]; }
}
function bsSentAdd(bs, to, id) {
  bs.sent.push({ to, id, at: Date.now() }); bs.dirty = true;
  if (bs.sent.length > 400) bs.sent = bs.sent.slice(-400);
}
// Plan B 24h auto-clear from the blob - no more sent: keyspace scans
async function bsPurgeSent(env, bs) {
  try {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    let purged = 0;
    const old = bs.sent.filter((s) => s.at < cutoff).slice(0, 20); // bounded per run
    for (const s of old) {
      const ok = await bridgeDelete(env, s.id, s.to).catch(() => false);
      if (ok) { bs.sent = bs.sent.filter((x) => x !== s); bs.dirty = true; purged++; }
      await sleep(200);
    }
    return purged;
  } catch (e) { return 0; }
}
const snowMs = (id) => Number((BigInt(id) >> 22n) + 1288834974657n); // tweet id -> post time
const getFilters = (env) => getJSON(env, "filters_v1", { muted: [], linkOnly: [], drop: {} }); // linkOnly: ["*"] or handles; drop: {links,video,image,gif} global content-type switches
const getPendingAdds = (env) => getJSON(env, "pending_adds", []);

// retention for the QUERY feature: last N feed items in one batched KV key (few writes, quota-safe)
const FEED_ITEMS_KEY = "feed_items";
const FEED_ITEMS_MAX = 400;
const getFeedItems = (env) => getJSON(env, FEED_ITEMS_KEY, []);
const getWatches = (env) => getJSON(env, "watches", []); // [{phrase, at}]

function itemText(t) {
  return [t.text, t.origText, t.quotedText, t.handle, t.name].filter(Boolean).join(" ").toLowerCase();
}
const QUERY_STOP = new Set("about anything heard what whats the and for are was did does know tell hey buff bot any some something news update updates on of in is it there say said who that this with from latest recently stuff thing things you".split(" "));
function queryTerms(text) {
  return [...new Set(text.toLowerCase().replace(/[^a-z0-9@_ ]/g, " ").split(/\s+/).filter((s) => s.length >= 3 && !QUERY_STOP.has(s)))];
}
function watchHit(t, watches) {
  const body = itemText(t);
  for (const watch of watches) {
    const terms = watch.phrase.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length && terms.every((term) => body.includes(term))) return watch;
  }
  return null;
}

function isLinkOnly(t) {
  const hasLink = /https?:\/\/t\.co\/\w+/.test(t.text);
  return hasLink && !t.media.length && stripLinks(t.text).length === 0;
}

function passesFilters(t, filters) {
  const h = t.handle.toLowerCase();
  if ((filters.muted || []).map((x) => x.toLowerCase()).includes(h)) return false;
  const lo = (filters.linkOnly || []).map((x) => x.toLowerCase());
  if ((lo.includes("*") || lo.includes(h)) && t.kind === "post" && isLinkOnly(t)) return false;
  const drop = filters.drop || {};
  if (drop.links && t.kind === "post" && isLinkOnly(t)) return false;
  if (drop.video && (t.media || []).some((m) => m.kind === "video" && !m.gif)) return false;
  if (drop.gif && (t.media || []).some((m) => m.gif)) return false;
  if (drop.image && (t.media || []).some((m) => m.kind === "image")) return false;
  return true;
}

// ---------- poll ----------

async function poll(env, maxDeliver, diag) {
  const d = diag || null;
  const mark = (k) => { if (d) d[k] = Date.now() - d._t0; };
  if (d) d._t0 = Date.now();
  if (!env.X_LIST_ID) return "no list id - skipping";
  const bsPre = await loadBS(env);
  const bsSeenHasFast = (x) => bsPre.seenSet.has(x);
  // v33: paginate the list timeline so heavy news days can't bury sparse accounts (pizza index gap 2026-09-06).
  // Stop paging as soon as the scan hits a seen item (normal case: 1 page), cap 4 pages to bound tick wall-time.
  const ids = [];
  const idSet = new Set();
  const raws = []; // v35: keep every page's raw - byId must cover ALL collected ids, not just the last page's (page-1 posts were silently dropped on heavy multi-page ticks)
  let cursor = null, pages = 0, rawBytes = 0;
  while (pages < 4) {
    const raw = await fetchListTimeline(env, cursor);
    rawBytes += raw.length;
    pages++;
    raws.push(raw);
    let sawSeen = false, found = 0, pos = 0; // v37: indexOf literal scan - the regex exec over ~1MB of timeline text was the quiet-tick CPU floor (free-plan 10ms enforcement is average-based)
    const TOK = '"entryId":"tweet-';
    for (;;) {
      const i = raw.indexOf(TOK, pos);
      if (i < 0) break;
      const s = i + TOK.length;
      const e = raw.indexOf('"', s);
      if (e < 0) break;
      const x = raw.slice(s, e);
      pos = e + 1;
      if (idSet.has(x)) continue;
      idSet.add(x); ids.push(x); found++;
      if (bsSeenHasFast(x)) sawSeen = true;
    }
    if (sawSeen) break; // reached known territory - no need to page deeper
    const ci = raw.indexOf('"cursorType":"Bottom"'); // v37: literal cursor extraction, same shape as the old regex
    if (ci < 0 || !found) break;
    const vv = raw.lastIndexOf('"value":"', ci);
    if (vv < 0) break;
    cursor = raw.slice(vv + 9, ci - 2); // between "value":" and the closing quote before ,"cursorType"
    if (!cursor) break;
  }
  if (d) { d.rawBytes = rawBytes; d.pages = pages; mark("tFetch"); }
  if (!ids.length) return "timeline empty";

  const bs = bsPre;
  if (!bs.born) {
    // v29 bootstrap: fresh state blob - mark the whole current timeline seen, deliver nothing (resume from NOW, never a backlog dump)
    bs.born = Date.now();
    for (const id of ids) bsSeenAdd(bs, id);
    await saveBS(env, bs, true);
    return `v29 bootstrap: seeded ${ids.length} timeline ids into the state blob, delivered none`;
  }

  if (COLD_GUARD_CUTOFF) { // v44c: mark pre-save posts seen without delivering; fresh posts flow normally
    let guarded = 0;
    for (const id of ids) {
      try { if (snowMs(id) <= COLD_GUARD_CUTOFF && !bsSeenHas(bs, id)) { bsSeenAdd(bs, id); guarded++; } } catch (e0) {}
    }
    COLD_GUARD_CUTOFF = 0;
    if (guarded) { try { await saveBS(env, bs, true); } catch (e0) {} }
    if (d) d.coldStartGuard = guarded;
  }

  // v44d emergency delivery hold (2026-09-07 flood): KV write cap let a stale isolate clobber the
  // blob and revert the seen ring - every cold poll re-delivered. Until KV writes recover
  // (free-tier daily reset 00:00 UTC), mark everything seen, deliver nothing. Self-expires at
  // 00:10 UTC (8:10 PM EDT) - no redeploy needed; cold-start guard above covers any straggler case.
  if (Date.now() < Date.UTC(2026, 8, 8, 0, 10)) {
    let held = 0;
    for (const id of ids) if (!bsSeenHas(bs, id)) { bsSeenAdd(bs, id); held++; }
    try { await saveBS(env, bs, true); } catch (e0) {}
    return "v44d emergency hold: marked " + held + " seen, delivered 0 (until 00:10 UTC)";
  }

  const paused = !!(await env.BUFF_KV.get("feed_paused"));
  let waDown = await env.BUFF_KV.get("wa_down");
  // v31: per-tick bridge keep-alive + breaker auto-clear. Keeps the Render free-tier instance
  // warm through news lulls (15-min idle spindown was the 2026-09-06 4:10 PM silence), and a
  // healthy response clears wa_down so a mid-restart 503 costs ~1 min, not the 1h TTL.
  try {
    const hp = await fetch(env.BRIDGE_URL + "/health", { signal: AbortSignal.timeout(6000) });
    const hj = await hp.json().catch(() => ({}));
    if (hp.ok && hj.connected && waDown) { await env.BUFF_KV.delete("wa_down"); waDown = null; }
  } catch (e) { /* bridge unreachable - leave breaker state as-is */ }

  const unseen = [];
  let skipped = 0;
  for (let i = 0; i < ids.length; i++) {
    if (bsSeenHas(bs, ids[i])) {
      skipped++;
      if (i + 1 >= 5) break; // same early-stop as before: first seen item at position >=5 ends the scan
      continue;
    }
    unseen.push(ids[i]);
  }

  if (!unseen.length) return `delivered=0 dropped=0 skipped=${skipped} filtered=0 deferred=0${paused ? " paused" : ""}${waDown ? " wa_down" : ""} scan-quiet`;

  const tweets = []; // v35: parse every fetched page so multi-page ticks don't lose earlier-page posts
  for (const r of raws) { try { tweets.push(...extractTweets(JSON.parse(r))); } catch (e) {} }
  mark("tParse");
  if (d) d.tweets = tweets.length;
  mark("tExtract");
  const byId = new Map(tweets.map((t) => [t.id, t]));
  const filters = await getFilters(env);
  const watches = await getWatches(env);
  const retained = []; // pushed into feed_items at the end (one batched write)
  const stories = bs.stories.filter((s) => Date.now() - s.at < 24 * 3600 * 1000); // delivered-story fingerprints, 24h window, lives in the state blob; tick-local appends make same-tick dupes deterministic
  let storyDupes = 0;
  const shabbos = await shabbosHoldActive(env);
  if (shabbos) { try { if (!(await env.BUFF_KV.get("shabbos_digest_pending"))) await kvPut(env, "shabbos_digest_pending", String(Date.now())); } catch (e) {} }
  // Post-window resume gate (full-off Shabbos mode): posts from inside the dark window are marked seen + kept for queries, never delivered
  let resumeCutoff = 0;
  try {
    const win = await getShabbosWindow(env);
    if (win && win.end) { const end = Date.parse(win.end); const ago = Date.now() - end; if (ago > 0 && ago < 3600000) resumeCutoff = end; }
  } catch (e) {}
  let held = 0;
  let shabbosProcessed = 0; // per-tick processing cap during the hold (see break below)
  const heldItems = []; // batched into shabbos_items at tick end (survives the whole window, unlike 400-cap feed_items)

  // pending adds: confirm once a staged account actually shows up in the list timeline
  const pendingAdds = await getPendingAdds(env);
  if (pendingAdds.length) {
    const seenHandles = new Set(tweets.map((t) => t.handle.toLowerCase()));
    const confirmed = pendingAdds.filter((p) => seenHandles.has(p.handle.toLowerCase()));
    if (confirmed.length) {
      await kvPut(env, "pending_adds", JSON.stringify(pendingAdds.filter((p) => !seenHandles.has(p.handle.toLowerCase()))));
      await bridgeSend(env, { text: `Now seeing posts from ${confirmed.map((p) => "@" + p.handle).join(", ")} - add complete.` }, String(env.ADMIN_PHONE).replace(/\D/g, "")).catch(() => {});
    }
  }

  const holding = paused || waDown; // deliveries off: still collect, mark seen, retain for queries - resume from NOW, never a backlog dump

  let delivered = 0, dropped = 0, deferred = 0, filtered = 0, suppressed = 0, untranslated = 0;
  // Gemini gatekeeper: batch-classify this tick's delivery candidates (max 10/tick, cached per tweet). FAIL-OPEN.
  let preDupes = null; // v36
  const feedMode = await getMode(env);
  const acctRules = (!holding && feedMode !== "everything") ? await getAcctRules(env) : {};
  if (!holding && feedMode !== "everything") {
    const gemKey = await getGeminiKey(env);
    if (gemKey) {
      const rules = await getRules(env);
      const cap = shabbos ? 15 : 15; // v36: 15/batch - fewer Gemini calls/day; during the hold, classify only what this tick will process
      const pre = [];
      preDupes = new Set(); // v36: story-dupes resolved BEFORE classify - same check as in-loop, zero Gemini spend
      for (const id of [...unseen].reverse()) {
        const t = byId.get(id);
        if (!t) continue;
        if (t.replyToUserId && t.authorId && t.replyToUserId !== t.authorId) continue;
        if (!passesFilters(t, filters)) continue;
        if (isAlwaysDeliver(t.handle, acctRules)) continue; // v34: bypass accounts never classified
        try { // v36: dupe of an already-delivered story with no new media -> the in-loop check would drop it anyway; skip the judge call
          const hasMedia = (t.media || []).length > 0;
          if (!hasMedia && isStoryDupeOrThrottle(storyFp([t.text, t.origText, t.quotedText].filter(Boolean).join(" ")), stories)) {
            retained.push({ id: t.id, kind: t.kind, text: t.text, media: t.media, handle: t.handle, name: t.name, origHandle: t.origHandle, origName: t.origName, origText: t.origText, quotedHandle: t.quotedHandle, quotedName: t.quotedName, quotedText: t.quotedText, at: Date.now(), storyDupe: true });
            bsSeenAdd(bs, id);
            preDupes.add(id);
            storyDupes++;
            continue;
          }
        } catch (e) {}
        pre.push(t);
        if (pre.length >= cap * 2) break;
      }
      const candidates = [];
      for (let i = 0; i < pre.length; i++) {
        if (bsGemGet(bs, pre[i].id) !== null) continue;
        const bo = UNJUDGED_BACKOFF.get(String(pre[i].id));
        if (bo && Date.now() < bo.next) continue; // v47: classifier was dead for this id recently - back off, don't re-storm
        candidates.push(pre[i]);
        if (candidates.length >= cap) break;
      }
      if (d) d.candidates = candidates.length;
      mark("tPreClassify");
      if (candidates.length) {
        let verdicts = await geminiClassify(env, gemKey, rules, feedMode, candidates, acctRules, (bs.recentDel || []).map((x) => x.t));
        if (!verdicts) verdicts = await waiClassify(env, rules, feedMode, candidates, acctRules, (bs.recentDel || []).map((x) => x.t)); // v42: Workers AI net, only when Gemini is out
        mark("tClassify");
        if (verdicts) for (const [vid, gv] of verdicts) bsGemSet(bs, vid, gv); // null = Gemini unreachable: hold candidates, retry next tick
        else for (const c of candidates) { const k = String(c.id); const b = UNJUDGED_BACKOFF.get(k) || { n: 0, next: 0 }; b.n++; b.next = Date.now() + [5, 15, 30, 60][Math.min(b.n - 1, 3)] * 60000; UNJUDGED_BACKOFF.set(k, b); } // v47: 5/15/30/60-min escalation - breaks the every-90s re-classify storm that ate 10k neurons in 67 min
      }
    }
  }
  let looped = 0;
  for (const id of [...unseen].reverse()) { // oldest-first
    if (shabbos && ++looped > 30) break; // bound total per-tick work during the hold; remainder stays unseen for next tick
    const t = byId.get(id);
    if (!t) continue;
    if (preDupes && preDupes.has(id)) continue; // v36: resolved pre-classify
    if (resumeCutoff && snowMs(id) < resumeCutoff) { // posted inside the Shabbos full-off window: keep for queries, never deliver
      retained.push({ id: t.id, kind: t.kind, text: t.text, media: t.media, handle: t.handle, name: t.name, origHandle: t.origHandle, origName: t.origName, origText: t.origText, quotedHandle: t.quotedHandle, quotedName: t.quotedName, quotedText: t.quotedText, at: Date.now(), windowSkipped: true });
      bsSeenAdd(bs, id);
      skipped++;
      continue;
    }
    // reply filter: drop replies to OTHER users; keep originals + self-thread continuations
    if (t.replyToUserId && t.authorId && t.replyToUserId !== t.authorId) {
      bsSeenAdd(bs, id);
      skipped++;
      continue;
    }
    if (!passesFilters(t, filters)) {
      retained.push({ id: t.id, kind: t.kind, text: t.text, media: t.media, handle: t.handle, name: t.name, origHandle: t.origHandle, origName: t.origName, origText: t.origText, quotedHandle: t.quotedHandle, quotedName: t.quotedName, quotedText: t.quotedText, at: Date.now() });
      bsSeenAdd(bs, id);
      filtered++;
      continue;
    }
    if (!holding && feedMode !== "everything" && !isAlwaysDeliver(t.handle, acctRules)) {
      const gv = parseGem(bsGemGet(bs, id) ? JSON.stringify(bsGemGet(bs, id)) : null);
      if (!gv && feedMode === "breaking") continue; // v34 fail-closed: unjudged stays unseen, retried next tick - quiet over noisy (Ezra 2026-09-06)
      if (gv && gv.d === false) { // gatekeeper dropped it: retain for queries, never deliver
        retained.push({ id: t.id, kind: t.kind, text: t.text, media: t.media, handle: t.handle, name: t.name, origHandle: t.origHandle, origName: t.origName, origText: t.origText, quotedHandle: t.quotedHandle, quotedName: t.quotedName, quotedText: t.quotedText, at: Date.now() });
        bsSeenAdd(bs, id);
        filtered++;
        continue;
      }
    }
    if (holding) {
      retained.push({ id: t.id, kind: t.kind, text: t.text, media: t.media, handle: t.handle, name: t.name, origHandle: t.origHandle, origName: t.origName, origText: t.origText, quotedHandle: t.quotedHandle, quotedName: t.quotedName, quotedText: t.quotedText, at: Date.now() });
      bsSeenAdd(bs, id);
      deferred++;
      continue;
    }
    if (shabbos) {
      // hold: buffer what passed the filter for the end-of-Shabbos digest; mark seen so live delivery resumes from NOW
      retained.push({ id: t.id, kind: t.kind, text: t.text, media: t.media, handle: t.handle, name: t.name, origHandle: t.origHandle, origName: t.origName, origText: t.origText, quotedHandle: t.quotedHandle, quotedName: t.quotedName, quotedText: t.quotedText, at: Date.now(), held: true });
      try {
        const hfp = storyFp([t.text, t.origText, t.quotedText].filter(Boolean).join(" "));
        const hasMedia = (t.media || []).length > 0; // new photos/videos/angles of an event are NOT dupes (2026-09-04 Ezra); identical media is already caught by media memory
        if (!hasMedia && isStoryDupeOrThrottle(hfp, stories)) { bsSeenAdd(bs, t.id); storyDupes++; if (++shabbosProcessed >= 15) break; continue; }
        if (hfp.u.size) stories.push({ u: [...hfp.u].slice(0, 60), e: [...hfp.e].slice(0, 40), at: Date.now() });
      } catch (e) {}
      bsSeenAdd(bs, t.id);
      heldItems.push(retained[retained.length - 1]);
      held++;
      if (++shabbosProcessed >= 15) break; // bound tick wall-time during the hold; the rest stay unseen for the next tick
      continue;
    }
    if (maxDeliver && delivered >= maxDeliver) break; // leave the rest unseen for the next tick
    // story-level dedup: same story already delivered from another account -> suppress (fail-open on any error)
    let fp = null;
    try {
      fp = storyFp([t.text, t.origText, t.quotedText].filter(Boolean).join(" "));
      const hasMedia = (t.media || []).length > 0; // new photos/videos/angles of an event are NOT dupes (2026-09-04 Ezra)
      if (!hasMedia && isStoryDupeOrThrottle(fp, stories)) {
          retained.push({ id: t.id, kind: t.kind, text: t.text, media: t.media, handle: t.handle, name: t.name, origHandle: t.origHandle, origName: t.origName, origText: t.origText, quotedHandle: t.quotedHandle, quotedName: t.quotedName, quotedText: t.quotedText, at: Date.now(), storyDupe: true });
          bsSeenAdd(bs, t.id);
          storyDupes++;
          continue;
      }
    } catch (e) { fp = null; }
    try {
      const dres = await deliverTweet(env, t);
      suppressed += dres.suppressed;
      if (dres.untranslated) {
        untranslated++;
        bsSeenAdd(bs, id); // seen, not delivered: never retry, never show untranslated (Ezra 2026-09-06)
        retained.push({ id: t.id, kind: t.kind, text: t.text, media: t.media, handle: t.handle, name: t.name, origHandle: t.origHandle, origName: t.origName, origText: t.origText, quotedHandle: t.quotedHandle, quotedName: t.quotedName, quotedText: t.quotedText, at: Date.now(), untranslated: true });
        continue;
      }
      if (fp && fp.u.size) stories.push({ u: [...fp.u].slice(0, 60), e: [...fp.e].slice(0, 40), at: Date.now() });
      retained.push({ id: t.id, kind: t.kind, text: t.text, media: t.media, handle: t.handle, name: t.name, origHandle: t.origHandle, origName: t.origName, origText: t.origText, quotedHandle: t.quotedHandle, quotedName: t.quotedName, quotedText: t.quotedText, at: Date.now() });
      const hit = watchHit(t, watches);
      if (hit) {
        await bridgeSend(env, { text: `Watch hit for "${hit.phrase}": see the post above from ${t.name} (@${t.handle}).` }, String(env.ADMIN_PHONE).replace(/\D/g, "")).catch(() => {});
      }
      bsSeenAdd(bs, id); // mark seen only AFTER successful send
      delivered++;
      try { // rolling "already delivered" memory for the gatekeeper (restatement-drop context)
        bs.recentDel = bs.recentDel || [];
        bs.recentDel.push({ t: String(t.text || t.origText || "").replace(/\s+/g, " ").slice(0, 140), at: Date.now() });
        bs.recentDel = bs.recentDel.filter((x) => Date.now() - x.at < 6 * 3600 * 1000).slice(-40);
        bs.dirty = true;
      } catch (e) {}
      await sleep(250);
    } catch (e) {
      if (e.bridgeDown) {
        // bridge not connected: trip circuit breaker, defer everything unsent
        await kvPut(env, "wa_down", String(Date.now()), { expirationTtl: 3600 });
        deferred++;
        break;
      }
      throw e;
    }
  }
  bs.stories = stories.slice(-200); bs.dirty = true;
  if (heldItems.length) {
    try {
      const buf = await getJSON(env, "shabbos_items", []);
      buf.push(...heldItems);
      await kvPut(env, "shabbos_items", JSON.stringify(buf.slice(-300)));
    } catch (e) {}
  }
  mark("tLoop");
  if (retained.length) {
    RETAINED_PENDING.push(...retained);
    if (RETAINED_PENDING.length > 800) RETAINED_PENDING = RETAINED_PENDING.slice(-800);
    if (Date.now() - FEED_LAST_WRITE > 1800000) { // v46: feed_items (the "anything on X?" query store) flushes at most every 30 min (KV write budget)
      const items = await getFeedItems(env);
      items.push(...RETAINED_PENDING);
      if (await kvPut(env, FEED_ITEMS_KEY, JSON.stringify(items.slice(-FEED_ITEMS_MAX)))) { RETAINED_PENDING = []; FEED_LAST_WRITE = Date.now(); }
    }
  }
  // volume stats live in the state blob now
  const vday = new Date().toISOString().slice(0, 10);
  if (!bs.vol || bs.vol.day !== vday) bs.vol = { day: vday, delivered: 0, suppressed: 0, filtered: 0, deferred: 0 };
  bs.vol.delivered += delivered; bs.vol.suppressed += suppressed; bs.vol.filtered += filtered; bs.vol.deferred += deferred;
  if (delivered || suppressed || filtered || deferred) bs.dirty = true;
  const forceSave = delivered > 0 && Date.now() - LAST_FORCE_SAVE > 120000; // v46: force-persist at most every 2 min on delivery ticks (was every delivery - KV write budget); regular 10-min throttle otherwise
  if (forceSave) LAST_FORCE_SAVE = Date.now();
  await saveBS(env, bs, forceSave);
  return `delivered=${delivered} dropped=${dropped} skipped=${skipped} filtered=${filtered} deferred=${deferred} suppressed=${suppressed}${untranslated ? ` untr=${untranslated}` : ""}${storyDupes ? ` storydupes=${storyDupes}` : ""}${held ? ` held=${held}` : ""}${shabbos ? " shabbos" : ""}${paused ? " paused" : ""}${waDown ? " wa_down" : ""}`;
}

// ---------- commands ----------

const HELP_ADMIN = `Buff commands (you are admin):
add @user - track an account (queued to the X list; I'll confirm when posts flow)
remove @user - stop their posts instantly (X list cleanup follows separately)
filter @user linksonly on|off - drop link-only posts from an account
filter all linksonly on|off - same, for every account
filters - show active filters
add subscriber <phone> - add a friend to the feed
remove subscriber <phone> - remove them
subscribers - list them
pause / start - stop/resume the whole feed
watch <topic> - flag when tracked accounts post about it
unwatch <topic> / watches - manage watches
anything on <topic>? - search the last ~400 feed items; I repost the matches
status - bot health
help - this text`;
const HELP_SUB = `Buff commands for you:
pause - stop your own messages
start - resume them
help - this text`;

async function handleCommand(env, from, textRaw) {
  const isAdmin = from === String(env.ADMIN_PHONE).replace(/\D/g, "");
  const subs = await getSubscribers(env);
  const sub = subs.find((s) => s.phone === from);
  if (!isAdmin && !sub) return; // strangers ignored silently
  const text = textRaw.trim();
  const m = text.toLowerCase();
  const reply = (body) => bridgeSend(env, { text: body }, from).catch(() => {});

  if (m === "help") return reply(isAdmin ? HELP_ADMIN : HELP_SUB);

  if (m === "pause") {
    if (isAdmin) { await kvPut(env, "feed_paused", "1"); return reply("Feed paused. Nothing sends until you text: start"); }
    sub.paused = true;
    await kvPut(env, "subscribers", JSON.stringify(subs));
    return reply("Your messages are paused. Text: start - to resume.");
  }
  if (m === "start") {
    if (isAdmin) { await env.BUFF_KV.delete("feed_paused"); return reply("Feed started."); }
    sub.paused = false;
    await kvPut(env, "subscribers", JSON.stringify(subs));
    return reply("You're back on.");
  }
  if (!isAdmin) return reply(HELP_SUB); // subscribers: nothing else

  const modeM = m.match(/^mode\s+(everything|breaking|custom)$/);
  if (modeM) {
    await kvPut(env, "feed_mode", modeM[1]);
    return reply(`Mode set: ${modeM[1]}.`);
  }

  const addM = text.match(/^add\s+@?([A-Za-z0-9_]{1,15})\s*$/i);
  if (addM) {
    const h = addM[1];
    const filters = await getFilters(env);
  const watches = await getWatches(env);
  const retained = []; // pushed into feed_items at the end (one batched write)
    const wasMuted = filters.muted.map((x) => x.toLowerCase()).includes(h.toLowerCase());
    if (wasMuted) {
      filters.muted = filters.muted.filter((x) => x.toLowerCase() !== h.toLowerCase());
      await kvPut(env, "filters_v1", JSON.stringify(filters));
      return reply(`@${h} unmuted - posts flow again immediately.`);
    }
    const pending = await getPendingAdds(env);
    if (pending.some((p) => p.handle.toLowerCase() === h.toLowerCase())) return reply(`@${h} is already queued for the X list.`);
    pending.push({ handle: h, at: Date.now() });
    await kvPut(env, "pending_adds", JSON.stringify(pending));
    return reply(`@${h} queued. X is throttling list edits right now, so the list add happens when that clears - I'll confirm the moment @${h}'s posts actually start flowing.`);
  }
  const rmM = text.match(/^(?:remove|rm)\s+@?([A-Za-z0-9_]{1,15})\s*$/i);
  if (rmM) {
    const h = rmM[1];
    const filters = await getFilters(env);
  const watches = await getWatches(env);
  const retained = []; // pushed into feed_items at the end (one batched write)
    if (!filters.muted.map((x) => x.toLowerCase()).includes(h.toLowerCase())) {
      filters.muted.push(h);
      await kvPut(env, "filters_v1", JSON.stringify(filters));
    }
    const pending = (await getPendingAdds(env)).filter((p) => p.handle.toLowerCase() !== h.toLowerCase());
    await kvPut(env, "pending_adds", JSON.stringify(pending));
    return reply(`@${h} muted - their posts stop right now. (X list removal follows when list edits un-throttle; the mute alone is enough.)`);
  }
  const fM = text.match(/^filter\s+@?([A-Za-z0-9_*]{1,15}|all)\s+linksonly\s+(on|off)\s*$/i);
  if (fM) {
    const filters = await getFilters(env);
  const watches = await getWatches(env);
  const retained = []; // pushed into feed_items at the end (one batched write)
    const k = fM[1].toLowerCase() === "all" ? "*" : fM[1];
    const has = filters.linkOnly.map((x) => x.toLowerCase()).includes(k.toLowerCase());
    if (fM[2].toLowerCase() === "on" && !has) filters.linkOnly.push(k);
    if (fM[2].toLowerCase() === "off") filters.linkOnly = filters.linkOnly.filter((x) => x.toLowerCase() !== k.toLowerCase());
    await kvPut(env, "filters_v1", JSON.stringify(filters));
    return reply(`Link-only filter for ${k === "*" ? "ALL accounts" : "@" + k}: ${fM[2].toUpperCase()}.`);
  }
  if (m === "filters") {
    const filters = await getFilters(env);
  const watches = await getWatches(env);
  const retained = []; // pushed into feed_items at the end (one batched write)
    return reply(`Muted: ${filters.muted.length ? filters.muted.map((x) => "@" + x).join(", ") : "none"}\nLink-only drops: ${filters.linkOnly.length ? filters.linkOnly.map((x) => (x === "*" ? "ALL" : "@" + x)).join(", ") : "none"}`);
  }
  const subM = text.match(/^(add|remove) subscriber\s+\+?(\d{7,15})\s*$/i);
  if (subM) {
    const phone = subM[2];
    if (subM[1].toLowerCase() === "add") {
      if (phone === String(env.ADMIN_PHONE).replace(/\D/g, "") || subs.some((s) => s.phone === phone)) return reply("That number is already on the feed.");
      subs.push({ phone, paused: false, at: Date.now() });
      await kvPut(env, "subscribers", JSON.stringify(subs));
      await bridgeSend(env, { text: "You've been added to Buff, an X news feed. Text: pause - anytime to stop, or: help." }, phone).catch(() => {});
      return reply(`Subscriber added: +${phone}. They got a welcome note with pause/help.`);
    }
    const next = subs.filter((s) => s.phone !== phone);
    await kvPut(env, "subscribers", JSON.stringify(next));
    return reply(next.length === subs.length ? `+${phone} wasn't a subscriber.` : `+${phone} removed.`);
  }
  if (m === "subscribers") {
    return reply(subs.length ? subs.map((s) => `+${s.phone}${s.paused ? " (paused)" : ""}`).join("\n") : "No subscribers yet.");
  }
  if (m === "status") {
    const lastPoll = (await loadBS(env)).lastPoll;
    const lastError = await env.BUFF_KV.get("last_error");
    const pausedF = !!(await env.BUFF_KV.get("feed_paused"));
    const waDown = !!(await env.BUFF_KV.get("wa_down"));
    return reply(`Feed: ${pausedF ? "PAUSED" : "running"}${waDown ? " (bridge down - holding)" : ""}\nLast poll: ${lastPoll || "never"}\nLast error: ${lastError || "none"}`);
  }
  const watchAddM = text.match(/^watch\s+(.{2,60})$/i);
  if (watchAddM && !/^remove\b/i.test(watchAddM[1])) {
    const watches = await getWatches(env);
    const phrase = watchAddM[1].trim().toLowerCase();
    if (watches.some((x) => x.phrase === phrase)) return reply(`Already watching "${phrase}".`);
    watches.push({ phrase, at: Date.now() });
    await kvPut(env, "watches", JSON.stringify(watches));
    return reply(`Watching "${phrase}" - I'll flag it whenever a tracked account posts about it.`);
  }
  const watchRmM = text.match(/^(?:unwatch|watch remove|remove watch)\s+(.{2,60})$/i);
  if (watchRmM) {
    const watches = await getWatches(env);
    const phrase = watchRmM[1].trim().toLowerCase();
    const next = watches.filter((x) => x.phrase !== phrase);
    await kvPut(env, "watches", JSON.stringify(next));
    return reply(next.length === watches.length ? `No watch on "${phrase}".` : `Watch removed: "${phrase}".`);
  }
  if (m === "watches") {
    const watches = await getWatches(env);
    return reply(watches.length ? "Active watches:\n" + watches.map((x) => `- "${x.phrase}"`).join("\n") : "No watches set. Text: watch <topic> - to add one.");
  }

  // QUERY: anything else that looks like a question searches the retained feed items
  if (/\?\s*$/.test(text) || /^(anything|heard|news|update|updates|what('s| is| has)?)\b/i.test(m)) {
    const items = await getFeedItems(env);
    const terms = queryTerms(text);
    if (!items.length) return reply("No feed items stored yet - I start collecting once the feed runs.");
    if (!terms.length) return reply("Ask me with a topic, e.g.: anything on the mayoral race?");
    const scored = [];
    items.forEach((it, idx) => {
      const body = itemText(it);
      let score = 0;
      for (const term of terms) if (body.includes(term)) score++;
      if (score) scored.push({ it, score, idx });
    });
    scored.sort((a, b) => b.score - a.score || b.idx - a.idx);
    const top = scored.slice(0, 4);
    if (!top.length) return reply(`Nothing in the last ${items.length} feed items about that.`);
    const byAccount = {};
    for (const { it } of scored) byAccount[it.handle] = (byAccount[it.handle] || 0) + 1;
    const who = Object.entries(byAccount).map(([h, n]) => `@${h} x${n}`).join(", ");
    await reply(`Found ${scored.length} match${scored.length === 1 ? "" : "es"} in the feed - who said what: ${who}. Reposting the most relevant:`);
    for (const { it } of top) {
      for (const media of it.media || []) {
        await bridgeSend(env, media.kind === "image" ? { imageUrl: media.url } : { videoUrl: media.url }, from).catch(() => {});
        await sleep(250);
      }
      await bridgeSend(env, { text: await formatBody(it) }, from).catch(() => {});
      await sleep(250);
    }
    return;
  }

  return reply(HELP_ADMIN);
}

async function handleIncoming(request, env) {
  if (request.headers.get("authorization") !== env.BRIDGE_SECRET) return new Response("bad auth", { status: 401 });
  const body = await request.json().catch(() => null);
  if (!body || !body.from || !body.text) return Response.json({ ok: false });
  // any live inbound message proves the bridge is alive: clear the circuit
  await env.BUFF_KV.delete("wa_down");
  await handleCommand(env, String(body.from).replace(/\D/g, ""), String(body.text));
  return Response.json({ ok: true });
}


// ---------- Gemini gatekeeper + feed modes ----------
const GEMINI_MODEL = "gemini-3.1-flash-lite";
const DEFAULT_RULES = [
  "Deliver breaking news AND major developments: statements and press conferences from heads of state/government (including the US President and Israeli PM), major policy moves, war/security events, disasters, major market/economic news, and significant updates to ongoing stories.",
  "Major newsworthy events and public gatherings (e.g. prominent delegations meeting officials, major political/community events): deliver substantive coverage from all angles - statements, photos, videos - not just the first break.",
  "Drop commentary, opinion, reaction clips, promos, and routine politics chatter.",
  "Weather: deliver only urgent life/property-threatening WARNINGS for populated areas (tornado warning, severe thunderstorm warning, flash flood warning, hurricane warning). Drop watches, outlooks, mesoscale discussions, and routine forecasts.",
  "Local crime/police incidents: drop routine ones entirely. Keep only mass-casualty events, terror, active manhunts, or attacks with national significance.",
  "War coverage: deliver the first break of a new front or operation and major escalations only. Do NOT deliver each individual strike, raid, or skirmish update.",
];
const VALID_MODES = ["everything", "breaking", "custom"];
const getMode = async (env) => { const m = await env.BUFF_KV.get("feed_mode"); return VALID_MODES.includes(m) ? m : "everything"; };
const getRules = (env) => getJSON(env, "gemini_rules", DEFAULT_RULES);
const DEFAULT_ACCT_RULES = {
  dd_geopolitics: "Deliver only hard footage and verified visual evidence posts (strike aftermath, geolocated video). Drop anything with opinion, framing, or editorial commentary.",
  nypost: "Deliver ONLY hard national breaking news: major crime with national significance, politics/government, national emergencies. Drop tabloid, celebrity, sports, lifestyle, and outrage-bait content entirely.",
};
const getAcctRules = async (env) => ({ ...DEFAULT_ACCT_RULES, ...(await getJSON(env, "acct_rules", {})) }); // KV overrides win; defaults ship in code
const isAlwaysDeliver = (handle, acctRules) => { const r = (acctRules || {})[(handle || "").toLowerCase()]; return !!r && /^\s*always deliver/i.test(r); }; // v34: true bypass - never gated by Gemini
const getGeminiKey = async (env) => env.GEMINI_API_KEY || (await env.BUFF_KV.get("gemini_key")) || null; // legacy single-key getter (translation rail)
// v45: multi-key pooling. GEMINI_API_KEY (or legacy gemini_key) may hold comma-separated keys, each from its OWN
// AI Studio project (the 500/day free cap is per-PROJECT - two keys in one project share one pool, learned 2026-09-07).
const getGeminiKeys = async (env) => {
  const raw = env.GEMINI_API_KEY || (await env.BUFF_KV.get("gemini_key")) || "";
  return raw.split(",").map((k) => k.trim()).filter((k) => k.length > 10);
};
const gemKeyId = async (k) => { // never store/log a full key: sha256 of the last 6 chars
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(k.slice(-6)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
};
async function gemKeyState(env) {
  try { return JSON.parse((await env.BUFF_KV.get("gem_keys")) || "{}") || {}; } catch (e) { return {}; }
}
async function gemKeyCool(env, id, until, daily, errSig) {
  try {
    const st = await gemKeyState(env);
    st[id] = { cool: until, daily: !!daily, at: new Date().toISOString(), sig: (errSig || "").slice(0, 80) };
    await kvPut(env, "gem_keys", JSON.stringify(st));
  } catch (e0) {}
}
function nextPTmidnight() { // Gemini daily quota resets midnight America/Los_Angeles
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
    const ptNow = new Date(`${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}`);
    const next = new Date(ptNow); next.setDate(next.getDate() + 1); next.setHours(0, 0, 0, 0);
    return Date.now() + (next.getTime() - ptNow.getTime());
  } catch (e) { return Date.now() + 8 * 3600e3; }
}

// Classify a batch of candidate posts. FAIL-OPEN: any error, timeout, or malformed answer -> deliver everything.
// gem:<id> values: legacy "1"/"0" bits or {"d":bool,"r":"one-line reason"}. parseGem normalizes.
function parseGem(v) {
  if (v == null) return null;
  if (v === "1") return { d: true };
  if (v === "0") return { d: false };
  try { const j = JSON.parse(v); return j && typeof j.d === "boolean" ? j : null; } catch (e) { return null; }
}

// v43: fallback judge = separate worker buff-wai-judge (llama-3.3-70b-fp8-fast on Workers AI free tier).
// The account API silently drops an "ai" binding on THIS script, so the model runs in its own worker and the
// main worker calls it over HTTPS with a shared secret. Engages ONLY when Gemini is unreachable. Same rules,
// same verdict shape; judge returns covered-ids only. Returns null when unavailable -> caller holds (fail-closed).
async function waiClassify(env, rules, mode, tweets, acctRules, recent) {
  try {
    if (!env.BRIDGE_SECRET || !env.BRIDGE_URL) return null;
    const day0 = new Date().toISOString().slice(0, 10);
    const bsT = await loadBS(env);
    if (bsT.waiCalls && bsT.waiCalls.day === day0 && bsT.waiCalls.n >= 190) return null; // v47: neuron self-throttle (~190 calls ~ 7k of 10k/day free) - stop before the cap, not after
    // Route via the Render bridge: same-account workers.dev subrequests from this worker are blocked (404/1042),
    // and the API token silently drops service/ai bindings on this script. Bridge -> judge is an external hop.
    const res = await fetch(env.BRIDGE_URL.replace(/\/$/, "") + "/judge", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: env.BRIDGE_SECRET },
      body: JSON.stringify({ rules, mode, tweets, acctRules, recent }),
      signal: AbortSignal.timeout(50000),
    });
    if (!res.ok) { try { const msg = `${new Date().toISOString()} workers-ai judge HTTP ${res.status}`; const prev = await env.BUFF_KV.get("last_error"); if (!prev || prev.slice(24) !== msg.slice(24)) await kvPut(env, "last_error", msg); } catch (e0) {} return null; }
    const j = await res.json();
    if (!j || !Array.isArray(j.verdicts) || !j.verdicts.length) {
      try { if (j && j.err) { const msg = `${new Date().toISOString()} judge verdicts:null: ${String(j.err).slice(0, 100)}`; const prev = await env.BUFF_KV.get("last_error"); if (!prev || prev.slice(24) !== msg.slice(24)) await kvPut(env, "last_error", msg); } } catch (e0) {} // v47: this failure was invisible 2026-09-08 (neuron cap read as 4h of "quiet")
      return null;
    }
    const verdicts = new Map();
    for (const pair of j.verdicts) if (Array.isArray(pair) && pair[0] != null && pair[1] && typeof pair[1].d === "boolean") verdicts.set(String(pair[0]), { d: pair[1].d, r: "wai" });
    if (!verdicts.size) return null;
    const day = new Date().toISOString().slice(0, 10);
    const bsU = await loadBS(env);
    if (!bsU.waiCalls || bsU.waiCalls.day !== day) bsU.waiCalls = { day, n: 0 };
    bsU.waiCalls.n += 1; bsU.dirty = true;
    return verdicts;
  } catch (e) {
    try { const msg = `${new Date().toISOString()} workers-ai judge throw: ${String((e && e.message) || e).slice(0, 120)}`; const prev = await env.BUFF_KV.get("last_error"); if (!prev || prev.slice(24) !== msg.slice(24)) await kvPut(env, "last_error", msg); } catch (e0) {}
    return null;
  }
}

async function geminiClassify(env, keyIgnored, rules, mode, tweets, acctRules, recent) {
  try { // v45: pool loop over keys - on quota 429, cool that key and try the next project
    const keys = await getGeminiKeys(env);
    if (!keys.length) return null;
    const kst = await gemKeyState(env);
    const now0 = Date.now();
    const avail = [];
    for (const k of keys) { const id = await gemKeyId(k); const st = kst[id]; if (!st || !st.cool || now0 >= st.cool) avail.push([k, id]); }
    if (!avail.length) return null; // every key cooled -> judge net engages
    let lastStatus = 0, lastBody = "";
    for (const [key, kid] of avail) {
      const r = await geminiClassifyOnce(env, key, rules, mode, tweets, acctRules, recent);
      if (r && r.verdicts) { // success - v46: no per-call KV write (was ~40 writes/hr at poll cadence, the top driver of the 2026-09-08 write-cap approach); daily call counting lives in the blob's gemCalls, cooldown state still writes on change
        return r.verdicts;
      }
      lastStatus = (r && r.status) || 0; lastBody = (r && r.body) || "";
      if (lastStatus === 429) {
        const daily = /limit:\s*500|PerDay/i.test(lastBody);
        await gemKeyCool(env, kid, daily ? nextPTmidnight() : Date.now() + 5 * 60000, daily, lastBody);
        continue; // next key in the pool
      }
      if (lastStatus === 0) continue; // network/timeout/unparseable on this key - try the next before giving up
      break; // 400/403 etc: key itself bad - no point hammering the pool
    }
    return null; // v34 fail-closed: caller holds unjudged posts (judge net engages)
  } catch (e) {
    try {
      const msg = `${new Date().toISOString()} gemini classify throw: ${String((e && e.message) || e).slice(0, 140)}`;
      const prev = await env.BUFF_KV.get("last_error");
      if (!prev || prev.slice(24) !== msg.slice(24)) await kvPut(env, "last_error", msg);
    } catch (e0) {}
    return null;
  }
}

// v45: single-key attempt, split out of the old geminiClassify. Returns {verdicts} | {status, body} (never throws).
async function geminiClassifyOnce(env, key, rules, mode, tweets, acctRules, recent) {
  const verdicts = new Map(tweets.map((t) => [t.id, { d: true }]));
  try {
    const ar = acctRules || {};
    const brief = tweets.map((t) => ({
      id: t.id,
      account: "@" + t.handle,
      accountRule: ar[(t.handle || "").toLowerCase()] || undefined,
      kind: t.kind,
      hasMedia: (t.media || []).length > 0,
      text: (t.text || "").slice(0, 600),
      quoted: t.quotedText ? t.quotedText.slice(0, 300) : undefined,
      original: t.origText ? t.origText.slice(0, 300) : undefined,
    }));
    const prompt =
      "You are the gatekeeper for one user's X-to-WhatsApp news feed. Decide for each post if it is DELIVERED to their phone.\n" +
      "Standing rules:\n- " + rules.join("\n- ") + "\nWhen a post has accountRule, apply it to that post in addition to the standing rules.\n" +
      (mode === "breaking" ? "MODE: BREAKING NEWS ONLY. Deliver only urgent breaking news and on-the-ground event footage; drop everything else, even posts a looser filter would keep.\n" : "MODE: CUSTOM. Judge every post against the standing rules.\n") +
      (recent && recent.length ? "ALREADY DELIVERED to the user in the last few hours (each line = one delivered post):\n- " + recent.slice(-40).join("\n- ") + "\nDrop any post that restates facts already delivered above unless it carries MATERIALLY NEW information (new casualty toll, official finding, genuinely new footage/angle, new location or development). A different outlet repeating the same facts is a DROP.\n" : "") +
      "Posts:\n" + JSON.stringify(brief) + "\n" +
      "Reply with ONLY a JSON array like [{\"id\":\"...\",\"deliver\":true,\"reason\":\"one short line\"}] covering every post id. Reason: max 12 words, plain. No other prose.";
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        input: prompt,
        store: false,
        generation_config: { temperature: 0, max_output_tokens: 2600, thinking_level: "minimal" }, // v36: sized for 15-post batches
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) { // v35b: surface the failure reason - fail-closed silence is invisible without it
      let eb = "";
      try {
        eb = (await res.text()).slice(0, 500); // v36b: enough to capture the quota metric name
        const msg = `${new Date().toISOString()} gemini classify HTTP ${res.status}: ${eb}`;
        const prev = await env.BUFF_KV.get("last_error");
        if (!prev || prev.slice(24) !== msg.slice(24)) await kvPut(env, "last_error", msg);
      } catch (e0) {}
      return { status: res.status, body: eb }; // v45: rotation decides cool/retry
    }
    const data = await res.json();
    let txt = (data.steps || []).filter((st) => st && st.type === "model_output").flatMap((st) => st.content || []).filter((c) => c && c.type === "text").map((c) => c.text || "").join("");
    const start = txt.indexOf("["), end = txt.lastIndexOf("]");
    if (start < 0 || end <= start) { // v35b: unparseable/blocked output - record a snippet
      try {
        const msg = `${new Date().toISOString()} gemini classify unparseable output: ${txt.slice(0, 100) || "(empty)"}`;
        const prev = await env.BUFF_KV.get("last_error");
        if (!prev || prev.slice(24) !== msg.slice(24)) await kvPut(env, "last_error", msg);
      } catch (e0) {}
      return { status: 0, body: "unparseable" }; // v45: another key may behave; pool decides
    }
    const arr = JSON.parse(txt.slice(start, end + 1));
    const covered = new Set();
    for (const v of arr) if (v && v.id && typeof v.deliver === "boolean") { verdicts.set(String(v.id), { d: v.deliver, r: typeof v.reason === "string" ? v.reason.slice(0, 140) : undefined }); covered.add(String(v.id)); }
    // v40 (2026-09-07): the map defaults every candidate to deliver:true - any id Gemini's array skipped would be
    // cached as PASS and delivered UNFILTERED (the fail-open hole inside fail-closed; root cause of off-class
    // deliveries like the WSJ jazz album). Uncovered ids are removed -> held and retried next tick instead.
    for (const vid of [...verdicts.keys()]) if (!covered.has(vid)) verdicts.delete(vid);
    const day = new Date().toISOString().slice(0, 10);
    const bsU = await loadBS(env);
    if (!bsU.gemCalls || bsU.gemCalls.day !== day) bsU.gemCalls = { day, n: 0 };
    bsU.gemCalls.n++; bsU.dirty = true;
  } catch (e) { // v35b: log the exception
    try {
      const msg = `${new Date().toISOString()} gemini classify throw: ${String((e && e.message) || e).slice(0, 140)}`;
      const prev = await env.BUFF_KV.get("last_error");
      if (!prev || prev.slice(24) !== msg.slice(24)) await kvPut(env, "last_error", msg);
    } catch (e0) {}
    return { status: 0, body: String((e && e.message) || e).slice(0, 120) };
  }
  return { verdicts };
}


// ---------- bot power (full OFF/ON: cron detach + bridge suspend / resume + cron attach) ----------
async function cfSchedules(env, attach) {
  if (!env.CF_ADMIN_TOKEN || !env.CF_ACCOUNT_ID) return { skipped: "CF creds not configured" };
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/buff-feed-bot/schedules`, {
    method: "PUT",
    headers: { authorization: `Bearer ${env.CF_ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(attach ? [{ cron: "* * * * *" }] : []),
  });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok && j.success, status: res.status };
}

async function renderPower(env, action) { // "suspend" | "resume"
  if (!env.RENDER_API_KEY || !env.RENDER_SERVICE_ID) return { skipped: "Render creds not configured" };
  const res = await fetch(`https://api.render.com/v1/services/${env.RENDER_SERVICE_ID}/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.RENDER_API_KEY}` },
  });
  return { ok: res.status === 202 || res.status === 200 || res.status === 405, status: res.status }; // 405 = already in that state
}

// ---------- admin dashboard ----------
const ADMIN_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>BUFF Admin</title>\n<style>\n  :root { --bg:#0f1115; --card:#181c24; --line:#262c38; --txt:#e8eaf0; --dim:#8b93a5; --accent:#4da3ff; --green:#3ddc84; --red:#ff5c5c; }\n  * { box-sizing:border-box; }\n  body { margin:0; background:var(--bg); color:var(--txt); font:15px/1.45 -apple-system, system-ui, sans-serif; }\n  .wrap { max-width:860px; margin:0 auto; padding:16px; }\n  h1 { font-size:20px; margin:8px 0 2px; }\n  .sub { color:var(--dim); font-size:13px; margin-bottom:16px; }\n  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin-bottom:14px; }\n  .card h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); margin:0 0 10px; }\n  .row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }\n  .modes button, .pill { border:1px solid var(--line); background:#10141b; color:var(--txt); border-radius:999px; padding:8px 14px; cursor:pointer; font-size:14px; }\n  .modes button.active { background:var(--accent); border-color:var(--accent); color:#04101f; font-weight:600; }\n  .toggle { width:46px; height:26px; border-radius:999px; background:#2a3140; border:1px solid var(--line); position:relative; cursor:pointer; flex:none; }\n  .toggle::after { content:\"\"; position:absolute; top:2px; left:2px; width:20px; height:20px; border-radius:50%; background:#fff; transition:left .15s; }\n  .toggle.on { background:var(--green); }\n  .toggle.on::after { left:22px; }\n  table { width:100%; border-collapse:collapse; }\n  td, th { text-align:left; padding:7px 6px; border-bottom:1px solid var(--line); font-size:14px; }\n  th { color:var(--dim); font-size:12px; font-weight:600; }\n  .muted-h { color:var(--dim); }\n  input[type=text], input[type=password], textarea { width:100%; background:#10141b; border:1px solid var(--line); color:var(--txt); border-radius:8px; padding:9px 10px; font-size:14px; }\n  textarea { min-height:110px; font-family:inherit; }\n  .btn { background:var(--accent); color:#04101f; border:0; border-radius:8px; padding:9px 14px; font-weight:600; cursor:pointer; }\n  .btn.ghost { background:#10141b; color:var(--txt); border:1px solid var(--line); }\n  .btn.danger { background:transparent; color:var(--red); border:1px solid var(--red); padding:4px 10px; font-size:13px; }\n  .chip { display:inline-flex; align-items:center; gap:8px; background:#10141b; border:1px solid var(--line); border-radius:999px; padding:6px 12px; margin:3px 4px 3px 0; font-size:14px; }\n  .chip button { background:none; border:0; color:var(--red); cursor:pointer; font-size:15px; padding:0; }\n  .stat { display:flex; justify-content:space-between; padding:5px 0; font-size:14px; }\n  .stat span:last-child { color:var(--dim); }\n  .ok { color:var(--green); } .bad { color:var(--red); }\n  #login { max-width:380px; margin:18vh auto 0; }\n  .hint { color:var(--dim); font-size:12px; margin-top:6px; }\n  .hidden { display:none; }\n</style>\n</head>\n<body>\n<div id=\"login\" class=\"card\">\n  <h1>BUFF Admin</h1>\n  <p class=\"sub\">Enter the admin key to manage the feed.</p>\n  <input type=\"password\" id=\"key\" placeholder=\"Admin key\" autocomplete=\"off\">\n  <div style=\"height:10px\"></div>\n  <button class=\"btn\" onclick=\"saveKey()\">Open dashboard</button>\n  <div class=\"hint\" id=\"loginErr\"></div>\n</div>\n<div class=\"wrap hidden\" id=\"app\">\n  <h1>BUFF Admin</h1>\n  <div class=\"sub\">X feed to WhatsApp - live control</div>\n\n  <div class=\"card\">\n    <h2>Feed</h2>\n    <div class=\"row\">\n      <div class=\"toggle\" id=\"pauseToggle\" onclick=\"setPaused()\"></div>\n      <div id=\"pauseLabel\">...</div>\n    </div>\n    <div class=\"hint\">Paused = nothing sends, feed keeps collecting. Start = resume from now. Never a backlog dump.</div>\n  </div>\n\n  <div class=\"card\">\n    <h2>Bot power</h2>\n    <div class=\"row\">\n      <button class=\"btn\" id=\"powerBtn\" onclick=\"setPower()\">...</button>\n      <span class=\"hint\" id=\"powerHint\"></span>\n    </div>\n    <div class=\"hint\">OFF = stops polling and suspends the WhatsApp link (full Shabbos mode). ON = resumes. No catch-up either way - it continues from the moment you switch.</div>\n  </div>\n\n  <div class=\"card modes\">\n    <h2>Shabbos</h2>\n    <div class=\"row\">\n      <button data-smode=\"off\" onclick=\"setShabbosMode('off')\">Fully off</button>\n      <button data-smode=\"digest\" onclick=\"setShabbosMode('digest')\">Silent collect + rundown</button>\n    </div>\n    <div class=\"hint\" id=\"smodeHint\"></div>\n  </div>\n\n  <div class=\"card modes\">\n    <h2>Mode</h2>\n    <div class=\"row\">\n      <button data-mode=\"everything\" onclick=\"setMode('everything')\">Everything</button>\n      <button data-mode=\"breaking\" onclick=\"setMode('breaking')\">Breaking news only</button>\n      <button data-mode=\"custom\" onclick=\"setMode('custom')\">Custom (rules)</button>\n    </div>\n    <div class=\"hint\" id=\"modeHint\"></div>\n  </div>\n\n  <div class=\"card\">\n    <h2>Content filters</h2>\n    <table><tbody>\n      <tr><td>Drop bare article-link posts (all accounts)</td><td style=\"text-align:right\"><div class=\"toggle\" id=\"tgLinks\" onclick=\"setDrop('links')\"></div></td></tr>\n      <tr><td>Drop posts with videos</td><td style=\"text-align:right\"><div class=\"toggle\" id=\"tgVideo\" onclick=\"setDrop('video')\"></div></td></tr>\n      <tr><td>Drop posts with images</td><td style=\"text-align:right\"><div class=\"toggle\" id=\"tgImage\" onclick=\"setDrop('image')\"></div></td></tr>\n      <tr><td>Drop posts with GIFs</td><td style=\"text-align:right\"><div class=\"toggle\" id=\"tgGif\" onclick=\"setDrop('gif')\"></div></td></tr>\n      <tr><td>Media memory (skip media already sent)</td><td style=\"text-align:right\"><div class=\"toggle\" id=\"tgDedup\" onclick=\"setDedup()\"></div></td></tr>\n    </tbody></table>\n    <div class=\"hint\">Logo/boilerplate media is handled by media memory - it stays on unless you switch it off here.</div>\n  </div>\n  <div class=\"hint\" style=\"margin:-4px 0 14px\">Account list is managed on X itself. To mute an account or drop its link-only posts without removing it, text the bot: <b>mute @handle</b>, <b>linkonly @handle</b>.</div>\n\n  <div class=\"card\">\n    <h2>Gatekeeper rules (Gemini)</h2>\n    <div class=\"hint\">One rule per line, plain English. Used in Breaking and Custom modes. Default: deliver breaking news AND major updates to ongoing stories; drop routine commentary, opinion, and link-only posts. If Gemini is unreachable, posts deliver anyway (fail open).</div>\n    <div style=\"height:8px\"></div>\n    <textarea id=\"rules\"></textarea>\n    <div style=\"height:8px\"></div>\n    <div class=\"row\">\n      <button class=\"btn\" onclick=\"saveRules()\">Save rules</button>\n      <input type=\"password\" id=\"gemKey\" placeholder=\"Gemini API key(s) - comma-separated, one per AI Studio project, stored as a Cloudflare secret\" style=\"flex:1\">\n      <button class=\"btn ghost\" onclick=\"saveGemKey()\">Install key</button>\n    </div>\n  </div>\n\n  <div class=\"card\">\n    <h2>Status</h2>\n    <div class=\"stat\"><span>Last poll</span><span id=\"sLastPoll\">-</span></div>\n    <div class=\"stat\"><span>Last error</span><span id=\"sLastError\">-</span></div>\n    <div class=\"stat\"><span>WhatsApp link</span><span id=\"sWa\">-</span></div>\n    <div class=\"stat\"><span>Gemini gatekeeper</span><span id=\"sGem\">-</span></div>\n    <div class=\"stat\"><span>Pending account adds</span><span id=\"sPend\">-</span></div>\n    <div class=\"stat\"><span>Today: delivered / dupes skipped / filtered out</span><span id=\"sVol\">-</span></div>\n  </div>\n\n  <div class=\"card\">\n    <h2>Watches</h2>\n    <div class=\"row\" style=\"margin-bottom:8px\">\n      <input type=\"text\" id=\"watchPhrase\" placeholder=\"Alert me when a post mentions...\" style=\"flex:1\">\n      <button class=\"btn\" onclick=\"addWatch()\">Watch</button>\n    </div>\n    <div id=\"watchList\"></div>\n  </div>\n\n  <div class=\"card\">\n    <h2>Subscribers</h2>\n    <div class=\"row\" style=\"margin-bottom:8px\">\n      <input type=\"text\" id=\"subPhone\" placeholder=\"Phone, e.g. 1443...\" style=\"flex:1\">\n      <button class=\"btn\" onclick=\"addSub()\">Add</button>\n    </div>\n    <table><tbody id=\"subRows\"></tbody></table>\n  </div>\n\n  <div class=\"card\">\n    <h2>Access</h2>\n    <div class=\"hint\">Change the dashboard key. Anyone with the key can control the feed - keep it private.</div>\n    <div style=\"height:8px\"></div>\n    <input type=\"password\" id=\"curKey\" placeholder=\"Current key\">\n    <div style=\"height:8px\"></div>\n    <input type=\"password\" id=\"newKey\" placeholder=\"New key (8+ characters)\">\n    <div style=\"height:8px\"></div>\n    <button class=\"btn\" onclick=\"changeKey()\">Change key</button>\n    <span class=\"hint\" id=\"keyMsg\"></span>\n  </div>\n</div>\n<script>\nlet KEY = localStorage.getItem('buff_admin_key') || '';\nasync function api(path, body) {\n  const res = await fetch('/admin/api' + path, {\n    method: body ? 'POST' : 'GET',\n    headers: { 'content-type': 'application/json', 'x-admin-key': KEY },\n    body: body ? JSON.stringify(body) : undefined\n  });\n  if (res.status === 401) { showLogin('Wrong key.'); throw new Error('401'); }\n  return res.json();\n}\nfunction showLogin(err) {\n  document.getElementById('login').classList.remove('hidden');\n  document.getElementById('app').classList.add('hidden');\n  document.getElementById('loginErr').textContent = err || '';\n}\nfunction saveKey() {\n  KEY = document.getElementById('key').value.trim();\n  localStorage.setItem('buff_admin_key', KEY);\n  load();\n}\nfunction esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }\nasync function load() {\n  let s;\n  try { s = await api('/state'); } catch (e) { return; }\n  document.getElementById('login').classList.add('hidden');\n  document.getElementById('app').classList.remove('hidden');\n  const pt = document.getElementById('pauseToggle');\n  pt.classList.toggle('on', !s.paused);\n  document.getElementById('pauseLabel').innerHTML = s.paused ? '<b class=\"bad\">PAUSED</b> - tap to resume' : '<b class=\"ok\">RUNNING</b> - tap to pause';\n  document.querySelectorAll('.modes button').forEach(b => b.classList.toggle('active', b.dataset.mode === s.mode));\n  document.querySelectorAll('[data-smode]').forEach(b => b.classList.toggle('active', b.dataset.smode === (s.shabbosMode || 'off')));\n  document.getElementById('smodeHint').textContent = (s.shabbosMode === 'digest') ? 'Collects silently during Shabbos, then sends one sectioned rundown after havdalah.' : 'Fully dark from candle-lighting to havdalah - no collecting, nothing sent. Resumes live after.';\n  document.getElementById('modeHint').textContent =\n    s.mode === 'everything' ? 'Everything delivers (muted/link-only filters still apply). Gemini is bypassed.' :\n    s.mode === 'breaking' ? 'Gemini passes only breaking news and event footage, plus your always-deliver rules.' :\n    'Gemini judges every post against your rules below.';\n  const pb = document.getElementById('powerBtn');\n  pb.textContent = s.power === 'off' ? 'Turn bot ON' : 'Turn bot OFF';\n  pb.style.background = s.power === 'off' ? 'var(--green)' : 'var(--red)';\n  pb.style.color = s.power === 'off' ? '#04101f' : '#fff';\n  document.getElementById('powerHint').textContent = s.power === 'off' ? 'Bot is fully OFF.' : 'Bot is on.' + (s.powerConfigured ? '' : ' (power control not wired yet)');\n  document.getElementById('sLastPoll').textContent = s.lastPoll || 'never';\n  document.getElementById('sLastError').textContent = s.lastError || 'none';\n  document.getElementById('sWa').innerHTML = s.waDown ? '<b class=\"bad\">down</b>' : '<b class=\"ok\">connected</b>';\n  document.getElementById('sGem').textContent = s.gemini + (s.geminiUsage != null ? ' (' + s.geminiUsage + ' calls today)' : '');\n  document.getElementById('sPend').textContent = s.pendingAdds.length ? s.pendingAdds.map(p => '@' + p.handle).join(', ') : 'none';\n  document.getElementById('rules').value = (s.rules || []).join('\\n');\n  const d = s.drop || {};\n  document.getElementById('tgLinks').classList.toggle('on', !!(d.links || s.linkOnlyAll));\n  document.getElementById('tgVideo').classList.toggle('on', !!d.video);\n  document.getElementById('tgImage').classList.toggle('on', !!d.image);\n  document.getElementById('tgGif').classList.toggle('on', !!d.gif);\n  document.getElementById('tgDedup').classList.toggle('on', !s.dedupOff);\n  const v = s.volume || {};\n  document.getElementById('sVol').textContent = (v.delivered||0) + ' / ' + (v.suppressed||0) + ' / ' + (v.filtered||0);\n  if (s.pendingRemovals && s.pendingRemovals.length) document.getElementById('sPend').textContent += ' | queued X-removals: ' + s.pendingRemovals.map(p => '@' + p.handle).join(', ');\n  document.getElementById('watchList').innerHTML = (s.watches || []).map(w =>\n    '<span class=\"chip\">' + esc(w.phrase) + ' <button onclick=\"delWatch(\\'' + esc(w.phrase) + '\\')\">&times;</button></span>').join('') || '<span class=\"hint\">None.</span>';\n  document.getElementById('subRows').innerHTML = (s.subscribers || []).map(p =>\n    '<tr><td>' + esc(p.phone) + (p.paused ? ' <span class=\"muted-h\">(paused)</span>' : '') + '</td>' +\n    '<td style=\"text-align:right\"><button class=\"btn danger\" onclick=\"delSub(\\'' + esc(p.phone) + '\\')\">Remove</button></td></tr>').join('') || '<tr><td class=\"muted-h\">None.</td></tr>';\n}\nasync function setPaused() { const s = await api('/state'); await api('/pause', { paused: !s.paused }); load(); }\nasync function setMode(m) { await api('/mode', { mode: m }); load(); }\nasync function saveRules() { await api('/rules', { rules: document.getElementById('rules').value.split('\\n').map(x => x.trim()).filter(Boolean) }); load(); }\nasync function saveGemKey() { const k = document.getElementById('gemKey').value.trim(); if (!k) return; await api('/gemini-key', { key: k }); document.getElementById('gemKey').value = ''; load(); }\nasync function addWatch() { const p = document.getElementById('watchPhrase').value.trim(); if (!p) return; await api('/watch-add', { phrase: p }); document.getElementById('watchPhrase').value = ''; load(); }\nasync function delWatch(p) { await api('/watch-del', { phrase: p }); load(); }\nasync function addSub() { const p = document.getElementById('subPhone').value.trim(); if (!p) return; await api('/sub-add', { phone: p }); document.getElementById('subPhone').value = ''; load(); }\nasync function delSub(p) { await api('/sub-del', { phone: p }); load(); }\nasync function setDrop(k) { const s = await api('/state'); const d = s.drop || {}; const body = {}; body[k] = !(k === 'links' ? (d.links || s.linkOnlyAll) : d[k]); await api('/drop', body); load(); }\nasync function setDedup() { const s = await api('/state'); await api('/dedup', { off: !s.dedupOff }); load(); }\nasync function changeKey() {\n  const msg = document.getElementById('keyMsg');\n  const res = await fetch('/admin/api/admin-key', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': KEY }, body: JSON.stringify({ current: document.getElementById('curKey').value, next: document.getElementById('newKey').value }) });\n  const j = await res.json().catch(() => ({}));\n  if (res.ok && j.ok) { KEY = document.getElementById('newKey').value; localStorage.setItem('buff_admin_key', KEY); msg.textContent = 'Key changed - you are now using the new key.'; }\n  else msg.textContent = j.error || 'Failed.';\n}\nasync function setShabbosMode(m) { await api('/shabbos-mode', { mode: m }); load(); }\nasync function setPower() { const s = await api('/state'); const on = s.power === 'off'; if (!confirm(on ? 'Turn the bot ON? It resumes from now, no catch-up.' : 'Turn the bot fully OFF? Polling stops and the WhatsApp link suspends.')) return; const r = await api('/power', { on }); if (!r.ok) alert('Power switch had a problem: ' + JSON.stringify(r.steps)); load(); }\nif (KEY) load(); else showLogin();\n</script>\n</body>\n</html>\n";


const XRELOGIN_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>BUFF - Reconnect X</title>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;background:#0f1115;color:#e8eaf0;max-width:420px;margin:12vh auto;padding:0 16px}input{width:100%;box-sizing:border-box;background:#10141b;border:1px solid #262c38;color:#e8eaf0;border-radius:8px;padding:10px;margin:5px 0;font-size:14px}button{background:#4da3ff;border:0;border-radius:8px;padding:11px 16px;font-weight:600;width:100%;margin-top:10px;cursor:pointer}#out{margin-top:14px;font-size:14px;white-space:pre-wrap}.hint{color:#8b93a5;font-size:12px}</style></head><body>
<h2>Reconnect X session</h2>
<p class="hint">Runs the X login flow server-side and stores fresh session cookies. Values go straight from these fields to the worker - never displayed or logged.</p>
<input type="password" id="ak" placeholder="Admin key" autocomplete="off">
<input type="text" id="u" placeholder="X username or email" autocomplete="off">
<input type="password" id="pw" placeholder="X password" autocomplete="off">
<input type="text" id="em" placeholder="Account email (only if X asks)" autocomplete="off">
<button onclick="go()">Reconnect</button>
<div id="out"></div>
<script>
async function go(){
  const out = document.getElementById('out');
  out.textContent = 'Working... (X login flow can take 10-20s)';
  try {
    const r = await fetch('/admin/api/x-relogin', {method:'POST', headers:{'content-type':'application/json','x-admin-key':document.getElementById('ak').value.trim()}, body: JSON.stringify({username: document.getElementById('u').value.trim(), password: document.getElementById('pw').value, email: document.getElementById('em').value.trim()})});
    const j = await r.json();
    out.textContent = JSON.stringify(j, null, 2);
  } catch(e){ out.textContent = 'request failed: ' + e.message; }
}
</script></body></html>`;

const digits = (s) => String(s || "").replace(/\D/g, "");
const cleanHandle = (s) => String(s || "").trim().replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 20);


// ---------- X session relogin (vault-transported credentials; cookies never leave this worker) ----------
const X_SUBTASK_VERSIONS = {
  action_list: 2, alert_dialog: 1, app_download_cta: 1, check_logged_in_account: 2, choice_selection: 3,
  contacts_live_sync_permission_prompt: 0, cta: 7, email_verification: 2, end_flow: 1, enter_date: 1,
  enter_email: 2, enter_password: 5, enter_phone: 2, enter_recaptcha: 1, enter_text: 5, generic_urt: 3,
  in_app_notification: 1, interest_picker: 3, js_instrumentation: 1, menu_dialog: 1,
  notifications_permission_prompt: 2, open_account: 2, open_home_timeline: 1, open_link: 1,
  phone_verification: 4, privacy_options: 1, security_key: 3, select_avatar: 4, select_banner: 2,
  settings_list: 7, show_code: 1, sign_up: 2, sign_up_review: 4, tweet_selection_urt: 1, update_users: 1,
  upload_media: 1, user_recommendations_list: 4, user_recommendations_urt: 1, wait_spinner: 3, web_modal: 1,
};
const X_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function xLoginFlow(username, password, email, API_HOST) {
  const jar = new Map();
  const collect = (res) => {
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  };
  const baseHeaders = (gt) => ({
    authorization: `Bearer ${X_BEARER}`,
    "content-type": "application/json",
    "user-agent": X_UA,
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": "en",
    origin: "https://x.com",
    referer: "https://x.com/",
    "x-guest-token": gt || "",
    "x-csrf-token": jar.get("ct0") || "",
    "x-twitter-auth-type": jar.has("auth_token") ? "OAuth2Client" : "",
    cookie: [...jar.entries(), ...(gt && !jar.has("gt") ? [["gt", gt]] : [])].map(([k, v]) => `${k}=${v}`).join("; "),
  });
  const g = await fetch("https://" + API_HOST + "/1.1/guest/activate.json", { method: "POST", headers: baseHeaders(null), signal: AbortSignal.timeout(15000) });
  collect(g);
  if (!g.ok) return { error: "guest activate HTTP " + g.status };
  const { guest_token } = await g.json();
  if (!guest_token) return { error: "no guest token" };
  let flowToken = null;
  const seen = [];
  let pendingInputs = null;
  for (let step = 0; step < 14; step++) {
    const body = flowToken
      ? { flow_token: flowToken, subtask_inputs: pendingInputs }
      : { input_flow_data: { flow_context: { debug_overrides: {}, start_location: { location: "manual_link" } }, subtask_versions: X_SUBTASK_VERSIONS } };
    const res = await fetch("https://" + API_HOST + "/1.1/onboarding/task.json" + (flowToken ? "" : "?flow_name=login"), {
      method: "POST", headers: baseHeaders(guest_token), body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    collect(res);
    const rawText = await res.text().catch(() => "");
    let j = {}; try { j = JSON.parse(rawText); } catch (e) {}
    if (!res.ok) return { error: "task HTTP " + res.status, detail: rawText.slice(0, 300), seen };
    flowToken = j.flow_token;
    const tasks = j.subtasks || [];
    const subs = tasks.map((x) => x.subtask_id);
    seen.push(...subs);
    if (jar.has("auth_token") && jar.has("ct0")) return { auth_token: jar.get("auth_token"), ct0: jar.get("ct0"), seen };
    const id = subs[0];
    const task = tasks[0] || {};
    if (id === "LoginJsInstrumentationSubtask") pendingInputs = [{ subtask_id: id, js_instrumentation: { response: '{\"rf\":{\"a4fc506d24bb4843c48a1966940c2796bf4fb7617a2d515ad3297b7df6b459b6\":121,\"bff66e16f1d7ea28c04653dc32479cf416a9c8b67c80cb8ad533b2a44fee82a3\":-1,\"ac4008077a7e6ca03210159dbe2134dea72a616f03832178314bb9931645e4f7\":-22,\"c3a8a81a9b2706c6fec42c771da65a9597c537b8e4d9b39e8e58de9fe31ff239\":-12},\"s\":\"ZHYaDA9iXRxOl2J3AZ9cc23iJx-Fg5E82KIBA_fgeZFugZGYzRtf8Bl3EUeeYgsK30gLFD2jTQx9fAMsnYCw0j8ahEy4Pb5siM5zD6n7YgOeWmFFaXoTwaGY4H0o-jQnZi5yWZRAnFi4lVuCVouNz_xd2BO2sobCO7QuyOsOxQn2CWx7bjD8vPAzT5BS1mICqUWyjZDjLnRZJU6cSQG5YFIHEPBa8Kj-v1JFgkdAfAMIdVvP7C80HWoOqYivQR7IBuOAI4xCeLQEdxlGeT-JYStlP9dcU5St7jI6ExyMeQnRicOcxXLXsan8i5Joautk2M8dAJFByzBaG4wtrPhQ3QAAAZEi-_t7\"}', link: "next_link" } }];
    else if (id === "LoginEnterUserIdentifierSSO") pendingInputs = [{ subtask_id: id, settings_list: { setting_responses: [{ key: "user_identifier", response_data: { text_data: { result: username } } }], link: "next_link" } }];
    else if (id === "LoginEnterUserIdentifier") pendingInputs = [{ subtask_id: id, enter_text: { text: username, link: "next_link" } }];
    else if (id === "LoginEnterAlternateIdentifierSubtask") { if (!email) return { error: "X wants alternate identifier (email) but none given", seen }; pendingInputs = [{ subtask_id: id, enter_text: { text: email, link: "next_link" } }]; }
    else if (id === "LoginEnterPassword") pendingInputs = [{ subtask_id: id, enter_password: { password, link: "next_link" } }];
    else if (id === "AccountDuplicationCheck") pendingInputs = [{ subtask_id: id, check_logged_in_account: { link: "AccountDuplicationCheck_false" } }];
    else if (id === "LoginAcid") {
      const hint = (((task.enter_text || {}).hint_text) || "").toLowerCase();
      if (hint.includes("confirmation code")) return { error: "X wants an email confirmation code", seen, needsCode: true };
      if (!email) return { error: "X wants email confirmation (LoginAcid) but no email given", seen };
      pendingInputs = [{ subtask_id: id, enter_text: { text: email, link: "next_link" } }];
    }
    else if (id === "LoginSuccessSubtask" || id === "SuccessExit") { if (jar.has("auth_token")) return { auth_token: jar.get("auth_token"), ct0: jar.get("ct0"), seen }; return { error: "success subtask but no auth_token cookie", seen }; }
    else if (id === "DenyLoginSubtask") return { error: "X denied the login (DenyLoginSubtask)", seen };
    else if (!id) { if (jar.has("auth_token")) return { auth_token: jar.get("auth_token"), ct0: jar.get("ct0"), seen }; return { error: "no subtasks and no auth_token", seen }; }
    else return { error: "unhandled subtask: " + id, seen, needsManual: true };
  }
  return { error: "flow did not complete in 14 steps", seen };
}

async function adminAuthed(request, env) {
  const configured = (await env.BUFF_KV.get("admin_key")) || env.ADMIN_SECRET || null;
  return configured && request.headers.get("x-admin-key") === configured;
}

async function handleAdminApi(request, env, url) {
  if (!(await adminAuthed(request, env))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const path = url.pathname;
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

  if (path === "/admin/api/state" && request.method === "GET") {
    const filters = await getFilters(env);
    const items = await getFeedItems(env);
    const handleMap = new Map();
    for (const it of items) if (it.handle) handleMap.set(it.handle.toLowerCase(), it.handle);
    for (const h of filters.muted || []) if (h !== "*") handleMap.set(String(h).toLowerCase(), String(h));
    for (const h of filters.linkOnly || []) if (h !== "*") handleMap.set(String(h).toLowerCase(), String(h));
    const lowMuted = (filters.muted || []).map((x) => String(x).toLowerCase());
    const lowLO = (filters.linkOnly || []).map((x) => String(x).toLowerCase());
    const accounts = [...handleMap.values()]
      .map((h) => ({ handle: h, muted: lowMuted.includes(h.toLowerCase()), linkOnly: lowLO.includes(h.toLowerCase()) }))
      .sort((a, b) => a.handle.toLowerCase().localeCompare(b.handle.toLowerCase()));
    const day = new Date().toISOString().slice(0, 10);
    return Response.json({
      paused: !!(await env.BUFF_KV.get("feed_paused")),
      mode: await getMode(env),
      lastPoll: (await loadBS(env)).lastPoll,
      lastError: await env.BUFF_KV.get("last_error"),
      waDown: !!(await env.BUFF_KV.get("wa_down")),
      gemini: env.GEMINI_API_KEY ? "installed (worker secret)" : ((await env.BUFF_KV.get("gemini_key")) ? "installed (legacy KV - reinstall via panel)" : "not set"),
      geminiUsage: ((await loadBS(env)).gemCalls && (await loadBS(env)).gemCalls.day === day) ? (await loadBS(env)).gemCalls.n : 0,
      rules: await getRules(env),
      drop: (filters.drop || {}),
      linkOnlyAll: lowLO.includes("*"),
      dedupOff: !!(await env.BUFF_KV.get("dedup_off")),
      accounts,
      acctRules: await getAcctRules(env),
      pendingAdds: await getPendingAdds(env),
      pendingRemovals: await getJSON(env, "pending_removals", []),
      volume: ((await loadBS(env)).vol && (await loadBS(env)).vol.day === day) ? (await loadBS(env)).vol : { delivered: 0, suppressed: 0, filtered: 0, deferred: 0 },
      power: (await env.BUFF_KV.get("bot_power")) || "on",
      powerConfigured: !!(env.RENDER_API_KEY && env.CF_ADMIN_TOKEN),
      shabbosMode: await getJSON(env, "shabbos_mode", "off"),
      watches: await getWatches(env),
      subscribers: (await getSubscribers(env)).map((s) => ({ phone: s.phone, paused: !!s.paused })),
    });
  }

  if (path === "/admin/api/pause") {
    if (body.paused) await kvPut(env, "feed_paused", "1"); else await env.BUFF_KV.delete("feed_paused");
    return Response.json({ ok: true });
  }
  if (path === "/admin/api/mode" && VALID_MODES.includes(body.mode)) {
    await kvPut(env, "feed_mode", body.mode);
    return Response.json({ ok: true });
  }
  if (path === "/admin/api/shabbos-mode") {
    const smode = body.mode === "digest" ? "digest" : "off";
    await kvPut(env, "shabbos_mode", smode);
    return Response.json({ ok: true, mode: smode });
  }
  if (path === "/admin/api/mute" || path === "/admin/api/linkonly") {
    const h = cleanHandle(body.handle);
    if (!h) return Response.json({ error: "bad handle" }, { status: 400 });
    const filters = await getFilters(env);
    const list = path === "/admin/api/mute" ? "muted" : "linkOnly";
    const on = path === "/admin/api/mute" ? !!body.muted : !!body.on;
    filters[list] = filters[list] || [];
    const low = filters[list].map((x) => String(x).toLowerCase());
    const i = low.indexOf(h.toLowerCase());
    if (on && i < 0) filters[list].push(h);
    if (!on && i >= 0) filters[list].splice(i, 1);
    await kvPut(env, "filters_v1", JSON.stringify(filters));
    return Response.json({ ok: true });
  }
  if (path === "/admin/api/drop") {
    const filters = await getFilters(env);
    filters.drop = filters.drop || {};
    for (const k of ["links", "video", "image", "gif"]) if (k in body) filters.drop[k] = !!body[k];
    await kvPut(env, "filters_v1", JSON.stringify(filters));
    return Response.json({ ok: true });
  }
  if (path === "/admin/api/dedup") {
    if (body.off) await kvPut(env, "dedup_off", "1"); else await env.BUFF_KV.delete("dedup_off");
    return Response.json({ ok: true });
  }
  if (path === "/admin/api/add-account") {
    const h = cleanHandle(body.handle);
    if (!h) return Response.json({ error: "bad handle" }, { status: 400 });
    const pending = await getPendingAdds(env);
    if (!pending.some((p) => String(p.handle).toLowerCase() === h.toLowerCase())) {
      pending.push({ handle: h, at: Date.now() });
      await kvPut(env, "pending_adds", JSON.stringify(pending));
    }
    return Response.json({ ok: true, staged: h });
  }
  if (path === "/admin/api/rules" && Array.isArray(body.rules)) {
    const rules = body.rules.map((r) => String(r).slice(0, 500)).filter(Boolean).slice(0, 40);
    await kvPut(env, "gemini_rules", JSON.stringify(rules));
    return Response.json({ ok: true, count: rules.length });
  }
  if (path === "/admin/api/gemini-key") {
    // Secret-handling (2026-09-04): the Gemini key is a persistent secret. It installs as a
    // Cloudflare Worker SECRET binding via the CF API - never written to KV, never returned by any endpoint.
    const k = String(body.key || "").trim();
    if (k.length < 10) return Response.json({ error: "key too short" }, { status: 400 });
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/buff-feed-bot/secrets`, {
      method: "PUT",
      headers: { authorization: `Bearer ${env.CF_ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "GEMINI_API_KEY", text: k, type: "secret_text" }),
      signal: AbortSignal.timeout(15000)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) return Response.json({ ok: false, error: "cloudflare secret install failed: " + (j.errors?.[0]?.message || r.status) }, { status: 502 });
    // clean up any legacy KV copy so the secret binding is the only resting place
    try { await env.BUFF_KV.delete("gemini_key"); } catch (e) {}
    return Response.json({ ok: true, installed: "worker_secret" });
  }
  if (path === "/admin/api/x-relogin" && request.method === "POST") {
    // Runs the X login flow server-side. Credentials arrive over HTTPS from the panel, cookies go straight to KV. Never logged, never returned.
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const email = String(body.email || "").trim();
    if (!username || !password) return Response.json({ error: "username and password required" }, { status: 400 });
    try {
      let r = await xLoginFlow(username, password, email, "api.x.com");
      if (!r.auth_token && /400|403/.test(String(r.error))) r = await xLoginFlow(username, password, email, "api.twitter.com");
      if (!r.auth_token) return Response.json({ ok: false, error: r.error, detail: r.detail, seen: r.seen }, { status: 502 });
      await kvPut(env, "x_session", JSON.stringify({ auth_token: r.auth_token, ct0: r.ct0, ts: Date.now() }));
      // verify against the real list timeline before declaring success
      let verify = "untested";
      try {
        const t = await fetchListTimeline(env); // reads the session we just wrote to KV
        verify = t.length > 200 ? "ok" : "empty";
      } catch (e) { verify = "verify failed: " + (e.message || e); }
      return Response.json({ ok: true, stored: true, verify, seen: r.seen });
    } catch (e) {
      return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
    }
  }
  if (path === "/admin/api/x-session-set" && request.method === "POST") {
    // Receives X session cookies over HTTPS, validates against the real list timeline, stores in KV only if valid. Never logged or returned.
    const at = String(body.auth_token || "").trim();
    const ct = String(body.ct0 || "").trim();
    if (!at || !ct) return Response.json({ error: "auth_token and ct0 required" }, { status: 400 });
    const vars = { listId: env.X_LIST_ID, count: 5 };
    const url2 = `https://x.com/i/api/graphql/${QID_LIST}/ListLatestTweetsTimeline?variables=${encodeURIComponent(JSON.stringify(vars))}&features=${encodeURIComponent(JSON.stringify(X_FEATURES))}`;
    try {
      const res = await fetch(url2, { headers: { authorization: `Bearer ${X_BEARER}`, "x-csrf-token": ct, cookie: `auth_token=${at}; ct0=${ct}`, "user-agent": X_UA, "x-twitter-active-user": "yes", "x-twitter-auth-type": "OAuth2Session" }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) return Response.json({ ok: false, stored: false, verify: "HTTP " + res.status }, { status: 502 });
      const t = await res.text();
      if (t.length < 200) return Response.json({ ok: false, stored: false, verify: "empty response" }, { status: 502 });
      await kvPut(env, "x_session", JSON.stringify({ auth_token: at, ct0: ct, ts: Date.now() }));
      return Response.json({ ok: true, stored: true, verify: "ok" });
    } catch (e) {
      return Response.json({ ok: false, stored: false, verify: String(e.message || e) }, { status: 500 });
    }
  }
  if (path === "/admin/api/shabbos-preview") {
    // Dry-run the Shabbos digest against recent kept feed items (or the live shabbos_items buffer). Sends nothing.
    const buf = await getJSON(env, "shabbos_items", []);
    const items = buf.length ? buf : (await getFeedItems(env)).slice(-40);
    const parts = await sendShabbosDigest(env, { items, dryRun: true });
    return Response.json({ ok: true, buffered: buf.length, used: items.length, parts: parts && parts.length ? parts.length : 0, preview: parts });
  }

  if (path === "/admin/api/gemini-test") {
    // Dry-run the gatekeeper against the most recent retained feed items. Returns verdicts, never the key.
    const key = await getGeminiKey(env);
    if (!key) return Response.json({ ok: false, error: "no gemini key installed" }, { status: 400 });
    const items = (await getFeedItems(env)).slice(-10);
    if (!items.length) return Response.json({ ok: false, error: "no retained feed items to test" });
    const rules = await getRules(env);
    const mode = await getMode(env);
    const acctRules = await getAcctRules(env);
    // reachability probe first: fail-open would otherwise mask a dead key as "deliver everything"
    let reachable = false, probeErr = null;
    try {
      const probe = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ model: GEMINI_MODEL, input: "Reply with the word OK", store: false, generation_config: { max_output_tokens: 8, thinking_level: "minimal" } }),
        signal: AbortSignal.timeout(20000)
      });
      reachable = probe.ok;
      if (!probe.ok) probeErr = "HTTP " + probe.status;
    } catch (e) { probeErr = String(e.message || e); }
    const verdicts = await geminiClassify(env, key, rules, mode, items, acctRules);
    if (!verdicts) return Response.json({ ok: false, error: "classify failed (fail-closed contract)", geminiReachable: reachable, probeError: probeErr });
    const out = items.map((t) => { const gv = verdicts.get(t.id) || {}; return { id: t.id, account: "@" + t.handle, deliver: gv.d !== false, reason: gv.r, text: (t.text || t.origText || "").slice(0, 80) }; });
    return Response.json({ ok: true, geminiReachable: reachable, probeError: probeErr, mode, tested: out.length, deliver: out.filter((v) => v.deliver).length, drop: out.filter((v) => !v.deliver).length, verdicts: out });
  }
  if (path === "/admin/api/translate-test") {
    // Production-context probe of BOTH translation rails on a Hebrew sample (2026-09-06 "(untranslated)" storm).
    const sample = "\u05de\u05d8\u05d5\u05e1 \u05d0\u05de\u05d6\u05d5\u05df \u05d4\u05ea\u05e8\u05d5\u05e7\u05e7 \u05d1\u05de\u05d9\u05d0\u05de\u05d9";
    const t0 = Date.now();
    GTX_DEAD_UNTIL = 0; // force-probe gtx even if dead-cached
    const gx = await translateGtx(sample);
    const t1 = Date.now();
    const gm = await translateGemini(env, sample);
    const t2 = Date.now();
    return Response.json({ ok: true, sample,
      gtx: { result: gx, ms: t1 - t0, deadCachedUntil: GTX_DEAD_UNTIL || null },
      gemini: { result: gm, ms: t2 - t1 },
      detectionOnEnglish: hasNonEnglish("Breaking: plane crashed in Miami, officials say") });
  }

  if (path === "/admin/api/admin-key") {
    const configured = (await env.BUFF_KV.get("admin_key")) || env.ADMIN_SECRET;
    if (body.current !== configured) return Response.json({ error: "current key wrong" }, { status: 403 });
    const next = String(body.next || "").trim();
    if (next.length < 8) return Response.json({ error: "new key must be 8+ chars" }, { status: 400 });
    await kvPut(env, "admin_key", next);
    return Response.json({ ok: true });
  }
  if (path === "/admin/api/acct-rule") {
    const h = cleanHandle(body.handle);
    if (!h) return Response.json({ error: "bad handle" }, { status: 400 });
    const rules = await getAcctRules(env);
    const rule = String(body.rule || "").trim().slice(0, 500);
    if (rule) rules[h.toLowerCase()] = rule; else delete rules[h.toLowerCase()];
    await kvPut(env, "acct_rules", JSON.stringify(rules));
    return Response.json({ ok: true });
  }
  if (path === "/admin/api/remove-account") {
    // instant delivery stop (mute) + queue the actual X-list removal for the list agent's slow cadence
    const h = cleanHandle(body.handle);
    if (!h) return Response.json({ error: "bad handle" }, { status: 400 });
    const filters = await getFilters(env);
    filters.muted = filters.muted || [];
    if (!filters.muted.map((x) => String(x).toLowerCase()).includes(h.toLowerCase())) {
      filters.muted.push(h);
      await kvPut(env, "filters_v1", JSON.stringify(filters));
    }
    const rem = await getJSON(env, "pending_removals", []);
    if (!rem.some((r) => String(r.handle).toLowerCase() === h.toLowerCase())) {
      rem.push({ handle: h, at: Date.now() });
      await kvPut(env, "pending_removals", JSON.stringify(rem));
    }
    return Response.json({ ok: true, muted: h, queued: true });
  }
  if (path === "/admin/api/power") {
    const on = !!body.on;
    const steps = {};
    if (on) {
      steps.bridge = await renderPower(env, "resume");
      steps.cron = await cfSchedules(env, true);
      await env.BUFF_KV.delete("bot_power");
    } else {
      steps.cron = await cfSchedules(env, false);
      steps.bridge = await renderPower(env, "suspend");
      await kvPut(env, "bot_power", "off");
    }
    return Response.json({ ok: Object.values(steps).every((s) => s.ok !== false), on, steps });
  }
  if (path === "/admin/api/watch-add" || path === "/admin/api/watch-del") {
    const phrase = String(body.phrase || "").trim().slice(0, 120);
    if (!phrase) return Response.json({ error: "bad phrase" }, { status: 400 });
    let watches = await getWatches(env);
    if (path.endsWith("watch-add")) {
      if (!watches.some((w) => w.phrase.toLowerCase() === phrase.toLowerCase())) watches.push({ phrase, at: Date.now() });
    } else {
      watches = watches.filter((w) => w.phrase.toLowerCase() !== phrase.toLowerCase());
    }
    await kvPut(env, "watches", JSON.stringify(watches));
    return Response.json({ ok: true });
  }
  if (path === "/admin/api/sub-add" || path === "/admin/api/sub-del") {
    const phone = digits(body.phone);
    if (phone.length < 10) return Response.json({ error: "bad phone" }, { status: 400 });
    let subs = await getSubscribers(env);
    if (path.endsWith("sub-add")) {
      if (!subs.some((s) => s.phone === phone)) subs.push({ phone, paused: false });
    } else {
      subs = subs.filter((s) => s.phone !== phone);
    }
    await kvPut(env, "subscribers", JSON.stringify(subs));
    return Response.json({ ok: true });
  }
  return Response.json({ error: "unknown admin route" }, { status: 404 });
}

// ---------- entrypoints ----------

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const t0 = Date.now();
        // heartbeat FIRST (fire-and-forget): proves the cron fired and keeps the Render free-tier socket warm; awaiting it costs up to 10s of the tick budget
        fetch(env.BRIDGE_URL + "/status", { headers: { authorization: env.BRIDGE_SECRET }, signal: AbortSignal.timeout(10000) }).catch(() => {});
        // Shabbos FULL-OFF (the default since 2026-09-06, Ezra): inside the window the tick goes fully dark -
        // no X fetch, no Gemini, no state writes. "digest" mode keeps the silent-collect + post-havdalah rundown.
        const holdNow = await shabbosHoldActive(env);
        if (holdNow && (await getJSON(env, "shabbos_mode", "off")) !== "digest") return;
        const bs = await loadBS(env);
        // Shabbos release FIRST: window over + digest pending -> send the one rundown before the poll can eat the
        // tick's time budget. pending flag deleted only AFTER a successful send, so a killed tick retries next minute.
        try {
          if (!holdNow && (await env.BUFF_KV.get("shabbos_digest_pending"))) {
            await sendShabbosDigest(env);
            await env.BUFF_KV.delete("shabbos_digest_pending");
          }
        } catch (e) {}
        // v38 single-poller lease (2026-09-07): the bridge poller (90s) is the primary engine; cron polls only
        // when the poller is stale (>150s) or the bridge is unreachable. Kills the cross-engine re-classification
        // that was doubling Gemini burn and double-processing ~35% of posts. Lease rides the bridge /status fetch -
        // zero extra KV writes (a KV lease at poll cadence alone would exceed the 1k/day free write budget).
        try {
          const stR = await fetch(env.BRIDGE_URL + "/status", { headers: { authorization: env.BRIDGE_SECRET }, signal: AbortSignal.timeout(4000) });
          const stJ = await stR.json();
          const age = stJ && stJ.workerPoll && stJ.workerPoll.ageSec;
          if (typeof age === "number" && age < 150) {
            bs.lastPoll = `${new Date().toISOString()} tick-skip (poller active, ${age}s)`;
            bs.dirty = true;
            await saveBS(env, bs, false);
            return;
          }
        } catch (e) {} // any error -> poll as today (fail toward freshness)
        try {
          bs.lastPoll = `${new Date().toISOString()} tick`;
          bs.dirty = true;
          const purged = new Date().getUTCMinutes() % 15 === 0 ? await bsPurgeSent(env, bs) : 0; // Plan B auto-clear from the blob, gated to every 15th tick
          const result = await poll(env, 6); // cap per-tick deliveries so the run stays inside the cron time budget; remainder flows next minute
          const done = `${new Date().toISOString()} ${result}${purged ? ` purged=${purged}` : ""} (${Date.now() - t0}ms)`;
          bs.lastPoll = done; bs.lastDone = done; bs.dirty = true;
          await saveBS(env, bs, new Date().getUTCMinutes() % 5 === 0); // health markers persist every 5th tick (delivery ticks force-saved inside poll)
        } catch (e) {
          try { await saveBS(env, bs, false); } catch (e0) {}
          try {
            const msg = `${new Date().toISOString()} ${e.message}`;
            const prev = await env.BUFF_KV.get("last_error");
            if (!prev || prev.slice(24) !== msg.slice(24)) await kvPut(env, "last_error", msg);
          } catch (e2) {}
        }
      })()
    );
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/admin" && request.method === "GET") return new Response(ADMIN_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (url.pathname === "/admin/x-relogin" && request.method === "GET") return new Response(XRELOGIN_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (url.pathname.startsWith("/admin/api/")) return handleAdminApi(request, env, url);
    if (url.pathname === "/incoming" && request.method === "POST") return handleIncoming(request, env);
    if (url.pathname === "/health") {
      const bsH = await loadBS(env);
      const lastPoll = bsH.lastPoll;
      const lastDone = bsH.lastDone;
      const lastError = await env.BUFF_KV.get("last_error");
      const pausedF = !!(await env.BUFF_KV.get("feed_paused"));
      const waDown = !!(await env.BUFF_KV.get("wa_down"));
      const subs = await getSubscribers(env);
      const filters = await getFilters(env);
  const watches = await getWatches(env);
  const retained = []; // pushed into feed_items at the end (one batched write)
      const pending = await getPendingAdds(env);
      return Response.json({ ok: true, lastPoll, lastDone, lastError, paused: pausedF, waDown, subscribers: subs.length, filters, pendingAdds: pending, mode: await getMode(env) });
    }
    if (url.pathname === "/poll-now" && [env.VERIFY_TOKEN, env.BRIDGE_SECRET].includes(url.searchParams.get("key"))) {
      const diag = url.searchParams.get("diag") ? {} : null;
      try {
        if (url.searchParams.get("wai")) { // v42 probe: is the Workers AI fallback judge reachable?
          const r = await waiClassify(env, ["Deliver only urgent breaking news about wars, disasters, or major attacks.", "When in doubt, DROP."], "breaking", [{ id: "probe1", handle: "testfeed", kind: "post", media: [], text: "Sunny skies and mild temperatures expected across the region today." }, { id: "probe2", handle: "testfeed", kind: "post", media: [], text: "BREAKING: Massive explosion reported at a port facility, multiple casualties confirmed, emergency crews responding." }], {}, []);
          return Response.json({ waiReachable: r !== null, verdicts: r ? [...r] : null, bridgeAuthBound: !!env.BRIDGE_SECRET });
        }
        if (url.searchParams.get("classifyprobe")) { // v47: on-demand A/B - classify POSTed tweets with BOTH rails, no state changes, no delivery
          const body = await request.json().catch(() => ({}));
          const tw = Array.isArray(body.tweets) ? body.tweets.slice(0, 15) : [];
          if (!tw.length) return Response.json({ error: "POST { tweets: [...] } (max 15)" }, { status: 400 });
          const rules = await getRules(env);
          const mode = await getMode(env);
          const acctRules = await getAcctRules(env);
          const g = await geminiClassify(env, null, rules, mode, tw, acctRules, []);
          const w = await waiClassify(env, rules, mode, tw, acctRules, []);
          const ser = (m) => (m ? Object.fromEntries([...m].map(([k, v]) => [k, v])) : null);
          return Response.json({ mode, n: tw.length, gemini: ser(g), wai: ser(w) });
        }
        // v37b: the bridge-side poller (cron-throttle fallback) calls this around the clock - it must not wake
        // the feed during a full-off Shabbos window (same early-return as the cron handler; digest mode collects silently)
        if (await shabbosHoldActive(env) && (await getJSON(env, "shabbos_mode", "off")) !== "digest") return Response.json(diag ? { result: "shabbos-dark", diag } : { result: "shabbos-dark" });
        const result = await poll(env, 6, diag); // v38: poller per-poll cap matches cron - drains dribble, never dump
        return Response.json(diag ? { result, diag } : { result });
      } catch (e) {
        return Response.json({ error: String(e && e.message || e), diag }, { status: 500 });
      }
    }
    return new Response("buff", { status: 200 });
  }
};
