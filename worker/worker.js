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

async function fetchListTimeline(env) {
  const sess = await getXSession(env);
  const vars = { listId: env.X_LIST_ID, count: 20 };
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
        replyToUserId: legacy.in_reply_to_user_id_str || null
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

// ---------- translation: non-English posts deliver original + English underneath (fail open) ----------
// Free Google gtx endpoint, no key needed. Only fires when non-English letters are detected.
function hasNonEnglish(text) {
  if (!text) return false;
  return /[^\u0000-\u007F]/.test(text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}©®™\u{20E3}\u{E0020}-\u{E007F}]/gu, "")) && /[^\u0000-\u007F]*\p{L}/u.test(text) && /\p{L}[^\u0000-\u007F]|[^\u0000-\u007F]\p{L}/u.test(text);
}
async function translateToEnglish(text) {
  // returns translated string, or null on any failure (caller delivers original + "(untranslated)")
  try {
    const url = "https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=en&q=" + encodeURIComponent(text.slice(0, 4000));
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    const out = (Array.isArray(data) ? data : []).map(seg => seg && seg[0] || "").join("").trim();
    if (!out) return null;
    // same language already (gtx echo) or identical -> no translation block needed
    if (out.toLowerCase() === text.trim().toLowerCase()) return "";
    return out;
  } catch (e) { return null; }
}
async function withTranslation(text) {
  const clean = text;
  if (!hasNonEnglish(clean)) return clean;
  const tr = await translateToEnglish(clean);
  if (tr === null) return clean + "\n\n(untranslated)";
  if (tr === "") return clean;
  return clean + "\n\n----------\nEN: " + tr;
}

// ---------- message formatting: every message leads with bold Display Name (@handle) ----------

async function formatBody(t) {
  // Ezra 2026-09-03: strip t.co/x.com links (content only, no URLs); non-English gets original + English underneath
  const clean = async (s) => withTranslation(stripLinks(s || "") || "(link only)");
  if (t.kind === "retweet") {
    return `*${t.name} (@${t.handle})* retweeted *${t.origName} (@${t.origHandle})*:\n\n${await clean(t.origText)}`;
  }
  if (t.kind === "quote") {
    return `*${t.name} (@${t.handle})* commented:\n${await clean(t.text)}\n\n----------\n*${t.quotedName} (@${t.quotedHandle})* posted:\n${await clean(t.quotedText)}`;
  }
  return `*${t.name} (@${t.handle})*\n\n${await clean(t.text)}`;
}

// ---------- Shabbos hold (2026-09-04, Ezra) ----------
// Bot keeps polling/filtering/deduping, but WhatsApp delivery holds Fri evening -> Sat night (America/New_York).
// Held posts are retained with held:true; at window end ONE Gemini digest goes out, then live delivery resumes
// (held posts are already marked seen, so no backlog dump). Err longer: Fri 7:10 PM -> Sat 8:40 PM ET.
// KV overrides: shabbos_auto="0" disables entirely; shabbos_force="on"/"off" for testing.
async function shabbosHoldActive(env) {
  try {
    const force = await env.BUFF_KV.get("shabbos_force");
    if (force === "on") return true;
    if (force === "off") return false;
    if ((await env.BUFF_KV.get("shabbos_auto")) === "0") return false;
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
    const brief = items.slice(-120).map((t) => ({ account: "@" + t.handle, text: (t.text || t.origText || "").slice(0, 180) }));
    const prompt =
      "You are writing a Shabbos rundown: a full-spectrum recap of these news posts (about 25 hours) for one WhatsApp user who was offline. " +
      "Organize into topic SECTIONS with headers like *WORLD EVENTS*, *MIDDLE EAST*, *US POLITICS*, *WEATHER & DISASTERS*, *ECONOMY*, *OTHER* (use only sections that have content, most important first). " +
      "Within each section, merge updates about the same event into one entry and give the key developments as concise bullets. Cover the whole window, not just the biggest stories. " +
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

async function deliverToAll(env, payload) {
  // fan out to admin + subscribers who haven't paused themselves
  const subs = await getSubscribers(env);
  const targets = [String(env.ADMIN_PHONE).replace(/\D/g, "")];
  for (const s of subs) if (!s.paused && !targets.includes(s.phone)) targets.push(s.phone);
  let firstId = null;
  for (const to of targets) {
    const id = await bridgeSend(env, payload, to);
    if (id) {
      // Plan B auto-clear: log every feed message so the poll loop can delete it for everyone after 24h
      try { await env.BUFF_KV.put(`sent:${to}:${id}`, String(Date.now()), { expirationTtl: 26 * 3600 }); } catch (e) {}
    }
    if (!firstId) firstId = id;
    await sleep(250);
  }
  return firstId;
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
    for (const k of list.keys) {
      const at = Number(await env.BUFF_KV.get(k.name));
      if (!at || at > cutoff) continue;
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
  // media first (no captions), then the labeled text message. Returns count of media suppressed as exact duplicates.
  let suppressed = 0;
  const dedupOff = !!(await env.BUFF_KV.get("dedup_off"));
  for (const m of t.media) {
    const fp = dedupOff ? null : await mediaFingerprint(m);
    if (fp) {
      const dupe = await env.BUFF_KV.get(`media:${fp}`);
      if (dupe) { suppressed++; continue; } // exact media already sent (boilerplate logos, cross-account re-uploads) - suppress, text+link still goes
      await env.BUFF_KV.put(`media:${fp}`, t.id, { expirationTtl: 14 * 86400 });
    }
    await deliverToAll(env, m.kind === "image" ? { imageUrl: m.url } : { videoUrl: m.url });
    await sleep(250);
  }
  await deliverToAll(env, { text: await formatBody(t) });
  return suppressed;
}

// ---------- state helpers (batched KV keys to stay under free-tier write quota) ----------

async function getJSON(env, key, fallback) {
  try { const v = await env.BUFF_KV.get(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
}
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

async function poll(env, maxDeliver) {
  if (!env.X_LIST_ID) return "no list id - skipping";
  const raw = await fetchListTimeline(env);
  const ids = [...new Set([...raw.matchAll(/"entryId":"tweet-(\d+)"/g)].map((m) => m[1]))];
  if (!ids.length) return "timeline empty";

  const seeded = await env.BUFF_KV.get("seeded");
  if (!seeded) {
    for (const id of ids) await env.BUFF_KV.put(`seen:${id}`, "1", { expirationTtl: 14 * 86400 });
    await env.BUFF_KV.put("seeded", "1");
    return `seeded ${ids.length} tweets, delivered none`;
  }

  const paused = !!(await env.BUFF_KV.get("feed_paused"));
  const waDown = await env.BUFF_KV.get("wa_down");

  const unseen = [];
  let skipped = 0, checked = 0;
  for (const id of ids) {
    checked++;
    if (await env.BUFF_KV.get(`seen:${id}`)) {
      skipped++;
      if (checked >= 5) break;
      continue;
    }
    unseen.push(id);
  }

  if (!unseen.length) return `delivered=0 dropped=0 skipped=${skipped} filtered=0 deferred=0${paused ? " paused" : ""}${waDown ? " wa_down" : ""} scan-quiet`;

  const payload = JSON.parse(raw);
  const tweets = extractTweets(payload);
  const byId = new Map(tweets.map((t) => [t.id, t]));
  const filters = await getFilters(env);
  const watches = await getWatches(env);
  const retained = []; // pushed into feed_items at the end (one batched write)
  const stories = (await getJSON(env, STORIES_KEY, [])).filter((s) => Date.now() - s.at < 24 * 3600 * 1000); // delivered-story fingerprints, 24h window; tick-local appends make same-tick dupes deterministic
  let storyDupes = 0;
  const shabbos = await shabbosHoldActive(env);
  if (shabbos) { try { if (!(await env.BUFF_KV.get("shabbos_digest_pending"))) await env.BUFF_KV.put("shabbos_digest_pending", String(Date.now())); } catch (e) {} }
  let held = 0;
  const heldItems = []; // batched into shabbos_items at tick end (survives the whole window, unlike 400-cap feed_items)

  // pending adds: confirm once a staged account actually shows up in the list timeline
  const pendingAdds = await getPendingAdds(env);
  if (pendingAdds.length) {
    const seenHandles = new Set(tweets.map((t) => t.handle.toLowerCase()));
    const confirmed = pendingAdds.filter((p) => seenHandles.has(p.handle.toLowerCase()));
    if (confirmed.length) {
      await env.BUFF_KV.put("pending_adds", JSON.stringify(pendingAdds.filter((p) => !seenHandles.has(p.handle.toLowerCase()))));
      await bridgeSend(env, { text: `Now seeing posts from ${confirmed.map((p) => "@" + p.handle).join(", ")} - add complete.` }, String(env.ADMIN_PHONE).replace(/\D/g, "")).catch(() => {});
    }
  }

  const holding = paused || waDown; // deliveries off: still collect, mark seen, retain for queries - resume from NOW, never a backlog dump

  let delivered = 0, dropped = 0, deferred = 0, filtered = 0, suppressed = 0;
  // Gemini gatekeeper: batch-classify this tick's delivery candidates (max 10/tick, cached per tweet). FAIL-OPEN.
  const feedMode = await getMode(env);
  if (!holding && feedMode !== "everything") {
    const gemKey = await getGeminiKey(env);
    if (gemKey) {
      const rules = await getRules(env);
      const candidates = [];
      for (const id of [...unseen].reverse()) {
        const t = byId.get(id);
        if (!t) continue;
        if (t.replyToUserId && t.authorId && t.replyToUserId !== t.authorId) continue;
        if (!passesFilters(t, filters)) continue;
        if ((await env.BUFF_KV.get(`gem:${id}`)) !== null) continue;
        candidates.push(t);
        if (candidates.length >= 10) break;
      }
      if (candidates.length) {
        const verdicts = await geminiClassify(env, gemKey, rules, feedMode, candidates, await getAcctRules(env));
        for (const [vid, gv] of verdicts) await env.BUFF_KV.put(`gem:${vid}`, JSON.stringify(gv), { expirationTtl: 14 * 86400 });
      }
    }
  }
  for (const id of [...unseen].reverse()) { // oldest-first
    const t = byId.get(id);
    if (!t) continue;
    // reply filter: drop replies to OTHER users; keep originals + self-thread continuations
    if (t.replyToUserId && t.authorId && t.replyToUserId !== t.authorId) {
      await env.BUFF_KV.put(`seen:${id}`, "1", { expirationTtl: 14 * 86400 });
      skipped++;
      continue;
    }
    if (!passesFilters(t, filters)) {
      retained.push({ id: t.id, kind: t.kind, text: t.text, media: t.media, handle: t.handle, name: t.name, origHandle: t.origHandle, origName: t.origName, origText: t.origText, quotedHandle: t.quotedHandle, quotedName: t.quotedName, quotedText: t.quotedText, at: Date.now() });
      await env.BUFF_KV.put(`seen:${id}`, "1", { expirationTtl: 14 * 86400 });
      filtered++;
      continue;
    }
    if (!holding && feedMode !== "everything") {
      const gv = parseGem(await env.BUFF_KV.get(`gem:${id}`));
      if (gv && gv.d === false) { // gatekeeper dropped it: retain for queries, never deliver
        retained.push({ id: t.id, kind: t.kind, text: t.text, media: t.media, handle: t.handle, name: t.name, origHandle: t.origHandle, origName: t.origName, origText: t.origText, quotedHandle: t.quotedHandle, quotedName: t.quotedName, quotedText: t.quotedText, at: Date.now() });
        await env.BUFF_KV.put(`seen:${id}`, "1", { expirationTtl: 14 * 86400 });
        filtered++;
        continue;
      }
    }
    if (holding) {
      retained.push({ id: t.id, kind: t.kind, text: t.text, media: t.media, handle: t.handle, name: t.name, origHandle: t.origHandle, origName: t.origName, origText: t.origText, quotedHandle: t.quotedHandle, quotedName: t.quotedName, quotedText: t.quotedText, at: Date.now() });
      await env.BUFF_KV.put(`seen:${id}`, "1", { expirationTtl: 14 * 86400 });
      deferred++;
      continue;
    }
    if (shabbos) {
      // hold: buffer what passed the filter for the end-of-Shabbos digest; mark seen so live delivery resumes from NOW
      retained.push({ id: t.id, kind: t.kind, text: t.text, media: t.media, handle: t.handle, name: t.name, origHandle: t.origHandle, origName: t.origName, origText: t.origText, quotedHandle: t.quotedHandle, quotedName: t.quotedName, quotedText: t.quotedText, at: Date.now(), held: true });
      try {
        const hfp = storyFp([t.text, t.origText, t.quotedText].filter(Boolean).join(" "));
        if (isStoryDupeFp(hfp, stories)) { await env.BUFF_KV.put(`seen:${t.id}`, "1", { expirationTtl: 14 * 86400 }); storyDupes++; continue; }
        if (hfp.u.size) stories.push({ u: [...hfp.u].slice(0, 60), e: [...hfp.e].slice(0, 40), at: Date.now() });
      } catch (e) {}
      await env.BUFF_KV.put(`seen:${t.id}`, "1", { expirationTtl: 14 * 86400 });
      heldItems.push(retained[retained.length - 1]);
      held++;
      continue;
    }
    if (maxDeliver && delivered >= maxDeliver) break; // leave the rest unseen for the next tick
    // story-level dedup: same story already delivered from another account -> suppress (fail-open on any error)
    let fp = null;
    try {
      fp = storyFp([t.text, t.origText, t.quotedText].filter(Boolean).join(" "));
      if (isStoryDupeFp(fp, stories)) {
          retained.push({ id: t.id, kind: t.kind, text: t.text, media: t.media, handle: t.handle, name: t.name, origHandle: t.origHandle, origName: t.origName, origText: t.origText, quotedHandle: t.quotedHandle, quotedName: t.quotedName, quotedText: t.quotedText, at: Date.now(), storyDupe: true });
          await env.BUFF_KV.put(`seen:${t.id}`, "1", { expirationTtl: 14 * 86400 });
          storyDupes++;
          continue;
      }
    } catch (e) { fp = null; }
    try {
      suppressed += await deliverTweet(env, t);
      if (fp && fp.u.size) stories.push({ u: [...fp.u].slice(0, 60), e: [...fp.e].slice(0, 40), at: Date.now() });
      retained.push({ id: t.id, kind: t.kind, text: t.text, media: t.media, handle: t.handle, name: t.name, origHandle: t.origHandle, origName: t.origName, origText: t.origText, quotedHandle: t.quotedHandle, quotedName: t.quotedName, quotedText: t.quotedText, at: Date.now() });
      const hit = watchHit(t, watches);
      if (hit) {
        await bridgeSend(env, { text: `Watch hit for "${hit.phrase}": see the post above from ${t.name} (@${t.handle}).` }, String(env.ADMIN_PHONE).replace(/\D/g, "")).catch(() => {});
      }
      await env.BUFF_KV.put(`seen:${id}`, "1", { expirationTtl: 14 * 86400 }); // mark seen only AFTER successful send
      delivered++;
      await sleep(250);
    } catch (e) {
      if (e.bridgeDown) {
        // bridge not connected: trip circuit breaker, defer everything unsent
        await env.BUFF_KV.put("wa_down", String(Date.now()), { expirationTtl: 3600 });
        deferred++;
        break;
      }
      throw e;
    }
  }
  try { await env.BUFF_KV.put(STORIES_KEY, JSON.stringify(stories.slice(-120))); } catch (e) {}
  if (heldItems.length) {
    try {
      const buf = await getJSON(env, "shabbos_items", []);
      buf.push(...heldItems);
      await env.BUFF_KV.put("shabbos_items", JSON.stringify(buf.slice(-300)));
    } catch (e) {}
  }
  if (retained.length) {
    const items = await getFeedItems(env);
    items.push(...retained);
    await env.BUFF_KV.put(FEED_ITEMS_KEY, JSON.stringify(items.slice(-FEED_ITEMS_MAX)));
    // volume stats for the dashboard: one read-modify-write per poll, not per tweet
    const vday = new Date().toISOString().slice(0, 10);
    const vkey = `vol:${vday}`;
    const vol = (await getJSON(env, vkey, null)) || { delivered: 0, suppressed: 0, filtered: 0, deferred: 0 };
    vol.delivered += delivered; vol.suppressed += suppressed; vol.filtered += filtered; vol.deferred += deferred;
    await env.BUFF_KV.put(vkey, JSON.stringify(vol), { expirationTtl: 7 * 86400 });
  }
  return `delivered=${delivered} dropped=${dropped} skipped=${skipped} filtered=${filtered} deferred=${deferred} suppressed=${suppressed}${storyDupes ? ` storydupes=${storyDupes}` : ""}${held ? ` held=${held}` : ""}${shabbos ? " shabbos" : ""}${paused ? " paused" : ""}${waDown ? " wa_down" : ""}`;
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
    if (isAdmin) { await env.BUFF_KV.put("feed_paused", "1"); return reply("Feed paused. Nothing sends until you text: start"); }
    sub.paused = true;
    await env.BUFF_KV.put("subscribers", JSON.stringify(subs));
    return reply("Your messages are paused. Text: start - to resume.");
  }
  if (m === "start") {
    if (isAdmin) { await env.BUFF_KV.delete("feed_paused"); return reply("Feed started."); }
    sub.paused = false;
    await env.BUFF_KV.put("subscribers", JSON.stringify(subs));
    return reply("You're back on.");
  }
  if (!isAdmin) return reply(HELP_SUB); // subscribers: nothing else

  const modeM = m.match(/^mode\s+(everything|breaking|custom)$/);
  if (modeM) {
    await env.BUFF_KV.put("feed_mode", modeM[1]);
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
      await env.BUFF_KV.put("filters_v1", JSON.stringify(filters));
      return reply(`@${h} unmuted - posts flow again immediately.`);
    }
    const pending = await getPendingAdds(env);
    if (pending.some((p) => p.handle.toLowerCase() === h.toLowerCase())) return reply(`@${h} is already queued for the X list.`);
    pending.push({ handle: h, at: Date.now() });
    await env.BUFF_KV.put("pending_adds", JSON.stringify(pending));
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
      await env.BUFF_KV.put("filters_v1", JSON.stringify(filters));
    }
    const pending = (await getPendingAdds(env)).filter((p) => p.handle.toLowerCase() !== h.toLowerCase());
    await env.BUFF_KV.put("pending_adds", JSON.stringify(pending));
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
    await env.BUFF_KV.put("filters_v1", JSON.stringify(filters));
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
      await env.BUFF_KV.put("subscribers", JSON.stringify(subs));
      await bridgeSend(env, { text: "You've been added to Buff, an X news feed. Text: pause - anytime to stop, or: help." }, phone).catch(() => {});
      return reply(`Subscriber added: +${phone}. They got a welcome note with pause/help.`);
    }
    const next = subs.filter((s) => s.phone !== phone);
    await env.BUFF_KV.put("subscribers", JSON.stringify(next));
    return reply(next.length === subs.length ? `+${phone} wasn't a subscriber.` : `+${phone} removed.`);
  }
  if (m === "subscribers") {
    return reply(subs.length ? subs.map((s) => `+${s.phone}${s.paused ? " (paused)" : ""}`).join("\n") : "No subscribers yet.");
  }
  if (m === "status") {
    const lastPoll = await env.BUFF_KV.get("last_poll");
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
    await env.BUFF_KV.put("watches", JSON.stringify(watches));
    return reply(`Watching "${phrase}" - I'll flag it whenever a tracked account posts about it.`);
  }
  const watchRmM = text.match(/^(?:unwatch|watch remove|remove watch)\s+(.{2,60})$/i);
  if (watchRmM) {
    const watches = await getWatches(env);
    const phrase = watchRmM[1].trim().toLowerCase();
    const next = watches.filter((x) => x.phrase !== phrase);
    await env.BUFF_KV.put("watches", JSON.stringify(next));
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
const getGeminiKey = async (env) => env.GEMINI_API_KEY || (await env.BUFF_KV.get("gemini_key")) || null;

// Classify a batch of candidate posts. FAIL-OPEN: any error, timeout, or malformed answer -> deliver everything.
// gem:<id> values: legacy "1"/"0" bits or {"d":bool,"r":"one-line reason"}. parseGem normalizes.
function parseGem(v) {
  if (v == null) return null;
  if (v === "1") return { d: true };
  if (v === "0") return { d: false };
  try { const j = JSON.parse(v); return j && typeof j.d === "boolean" ? j : null; } catch (e) { return null; }
}

async function geminiClassify(env, key, rules, mode, tweets, acctRules) {
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
      "Posts:\n" + JSON.stringify(brief) + "\n" +
      "Reply with ONLY a JSON array like [{\"id\":\"...\",\"deliver\":true,\"reason\":\"one short line\"}] covering every post id. Reason: max 12 words, plain. No other prose.";
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        input: prompt,
        store: false,
        generation_config: { temperature: 0, max_output_tokens: 1400, thinking_level: "minimal" },
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return verdicts; // fail open
    const data = await res.json();
    let txt = (data.steps || []).filter((st) => st && st.type === "model_output").flatMap((st) => st.content || []).filter((c) => c && c.type === "text").map((c) => c.text || "").join("");
    const start = txt.indexOf("["), end = txt.lastIndexOf("]");
    if (start < 0 || end <= start) return verdicts; // fail open
    const arr = JSON.parse(txt.slice(start, end + 1));
    for (const v of arr) if (v && v.id && typeof v.deliver === "boolean") verdicts.set(String(v.id), { d: v.deliver, r: typeof v.reason === "string" ? v.reason.slice(0, 140) : undefined });
    const day = new Date().toISOString().slice(0, 10);
    const ukey = `gem_usage:${day}`;
    const used = parseInt((await env.BUFF_KV.get(ukey)) || "0", 10) + 1;
    await env.BUFF_KV.put(ukey, String(used), { expirationTtl: 3 * 86400 });
  } catch (e) { /* fail open */ }
  return verdicts;
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
const ADMIN_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>BUFF Admin</title>\n<style>\n  :root { --bg:#0f1115; --card:#181c24; --line:#262c38; --txt:#e8eaf0; --dim:#8b93a5; --accent:#4da3ff; --green:#3ddc84; --red:#ff5c5c; }\n  * { box-sizing:border-box; }\n  body { margin:0; background:var(--bg); color:var(--txt); font:15px/1.45 -apple-system, system-ui, sans-serif; }\n  .wrap { max-width:860px; margin:0 auto; padding:16px; }\n  h1 { font-size:20px; margin:8px 0 2px; }\n  .sub { color:var(--dim); font-size:13px; margin-bottom:16px; }\n  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin-bottom:14px; }\n  .card h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); margin:0 0 10px; }\n  .row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }\n  .modes button, .pill { border:1px solid var(--line); background:#10141b; color:var(--txt); border-radius:999px; padding:8px 14px; cursor:pointer; font-size:14px; }\n  .modes button.active { background:var(--accent); border-color:var(--accent); color:#04101f; font-weight:600; }\n  .toggle { width:46px; height:26px; border-radius:999px; background:#2a3140; border:1px solid var(--line); position:relative; cursor:pointer; flex:none; }\n  .toggle::after { content:\"\"; position:absolute; top:2px; left:2px; width:20px; height:20px; border-radius:50%; background:#fff; transition:left .15s; }\n  .toggle.on { background:var(--green); }\n  .toggle.on::after { left:22px; }\n  table { width:100%; border-collapse:collapse; }\n  td, th { text-align:left; padding:7px 6px; border-bottom:1px solid var(--line); font-size:14px; }\n  th { color:var(--dim); font-size:12px; font-weight:600; }\n  .muted-h { color:var(--dim); }\n  input[type=text], input[type=password], textarea { width:100%; background:#10141b; border:1px solid var(--line); color:var(--txt); border-radius:8px; padding:9px 10px; font-size:14px; }\n  textarea { min-height:110px; font-family:inherit; }\n  .btn { background:var(--accent); color:#04101f; border:0; border-radius:8px; padding:9px 14px; font-weight:600; cursor:pointer; }\n  .btn.ghost { background:#10141b; color:var(--txt); border:1px solid var(--line); }\n  .btn.danger { background:transparent; color:var(--red); border:1px solid var(--red); padding:4px 10px; font-size:13px; }\n  .chip { display:inline-flex; align-items:center; gap:8px; background:#10141b; border:1px solid var(--line); border-radius:999px; padding:6px 12px; margin:3px 4px 3px 0; font-size:14px; }\n  .chip button { background:none; border:0; color:var(--red); cursor:pointer; font-size:15px; padding:0; }\n  .stat { display:flex; justify-content:space-between; padding:5px 0; font-size:14px; }\n  .stat span:last-child { color:var(--dim); }\n  .ok { color:var(--green); } .bad { color:var(--red); }\n  #login { max-width:380px; margin:18vh auto 0; }\n  .hint { color:var(--dim); font-size:12px; margin-top:6px; }\n  .hidden { display:none; }\n</style>\n</head>\n<body>\n<div id=\"login\" class=\"card\">\n  <h1>BUFF Admin</h1>\n  <p class=\"sub\">Enter the admin key to manage the feed.</p>\n  <input type=\"password\" id=\"key\" placeholder=\"Admin key\" autocomplete=\"off\">\n  <div style=\"height:10px\"></div>\n  <button class=\"btn\" onclick=\"saveKey()\">Open dashboard</button>\n  <div class=\"hint\" id=\"loginErr\"></div>\n</div>\n<div class=\"wrap hidden\" id=\"app\">\n  <h1>BUFF Admin</h1>\n  <div class=\"sub\">X feed to WhatsApp - live control</div>\n\n  <div class=\"card\">\n    <h2>Feed</h2>\n    <div class=\"row\">\n      <div class=\"toggle\" id=\"pauseToggle\" onclick=\"setPaused()\"></div>\n      <div id=\"pauseLabel\">...</div>\n    </div>\n    <div class=\"hint\">Paused = nothing sends, feed keeps collecting. Start = resume from now. Never a backlog dump.</div>\n  </div>\n\n  <div class=\"card\">\n    <h2>Bot power</h2>\n    <div class=\"row\">\n      <button class=\"btn\" id=\"powerBtn\" onclick=\"setPower()\">...</button>\n      <span class=\"hint\" id=\"powerHint\"></span>\n    </div>\n    <div class=\"hint\">OFF = stops polling and suspends the WhatsApp link (full Shabbos mode). ON = resumes. No catch-up either way - it continues from the moment you switch.</div>\n  </div>\n\n  <div class=\"card modes\">\n    <h2>Mode</h2>\n    <div class=\"row\">\n      <button data-mode=\"everything\" onclick=\"setMode('everything')\">Everything</button>\n      <button data-mode=\"breaking\" onclick=\"setMode('breaking')\">Breaking news only</button>\n      <button data-mode=\"custom\" onclick=\"setMode('custom')\">Custom (rules)</button>\n    </div>\n    <div class=\"hint\" id=\"modeHint\"></div>\n  </div>\n\n  <div class=\"card\">\n    <h2>Content filters</h2>\n    <table><tbody>\n      <tr><td>Drop bare article-link posts (all accounts)</td><td style=\"text-align:right\"><div class=\"toggle\" id=\"tgLinks\" onclick=\"setDrop('links')\"></div></td></tr>\n      <tr><td>Drop posts with videos</td><td style=\"text-align:right\"><div class=\"toggle\" id=\"tgVideo\" onclick=\"setDrop('video')\"></div></td></tr>\n      <tr><td>Drop posts with images</td><td style=\"text-align:right\"><div class=\"toggle\" id=\"tgImage\" onclick=\"setDrop('image')\"></div></td></tr>\n      <tr><td>Drop posts with GIFs</td><td style=\"text-align:right\"><div class=\"toggle\" id=\"tgGif\" onclick=\"setDrop('gif')\"></div></td></tr>\n      <tr><td>Media memory (skip media already sent)</td><td style=\"text-align:right\"><div class=\"toggle\" id=\"tgDedup\" onclick=\"setDedup()\"></div></td></tr>\n    </tbody></table>\n    <div class=\"hint\">Logo/boilerplate media is handled by media memory - it stays on unless you switch it off here.</div>\n  </div>\n  <div class=\"hint\" style=\"margin:-4px 0 14px\">Account list is managed on X itself. To mute an account or drop its link-only posts without removing it, text the bot: <b>mute @handle</b>, <b>linkonly @handle</b>.</div>\n\n  <div class=\"card\">\n    <h2>Gatekeeper rules (Gemini)</h2>\n    <div class=\"hint\">One rule per line, plain English. Used in Breaking and Custom modes. Default: deliver breaking news AND major updates to ongoing stories; drop routine commentary, opinion, and link-only posts. If Gemini is unreachable, posts deliver anyway (fail open).</div>\n    <div style=\"height:8px\"></div>\n    <textarea id=\"rules\"></textarea>\n    <div style=\"height:8px\"></div>\n    <div class=\"row\">\n      <button class=\"btn\" onclick=\"saveRules()\">Save rules</button>\n      <input type=\"password\" id=\"gemKey\" placeholder=\"Gemini API key - one-time install, stored as a Cloudflare secret\" style=\"flex:1\">\n      <button class=\"btn ghost\" onclick=\"saveGemKey()\">Install key</button>\n    </div>\n  </div>\n\n  <div class=\"card\">\n    <h2>Status</h2>\n    <div class=\"stat\"><span>Last poll</span><span id=\"sLastPoll\">-</span></div>\n    <div class=\"stat\"><span>Last error</span><span id=\"sLastError\">-</span></div>\n    <div class=\"stat\"><span>WhatsApp link</span><span id=\"sWa\">-</span></div>\n    <div class=\"stat\"><span>Gemini gatekeeper</span><span id=\"sGem\">-</span></div>\n    <div class=\"stat\"><span>Pending account adds</span><span id=\"sPend\">-</span></div>\n    <div class=\"stat\"><span>Today: delivered / dupes skipped / filtered out</span><span id=\"sVol\">-</span></div>\n  </div>\n\n  <div class=\"card\">\n    <h2>Watches</h2>\n    <div class=\"row\" style=\"margin-bottom:8px\">\n      <input type=\"text\" id=\"watchPhrase\" placeholder=\"Alert me when a post mentions...\" style=\"flex:1\">\n      <button class=\"btn\" onclick=\"addWatch()\">Watch</button>\n    </div>\n    <div id=\"watchList\"></div>\n  </div>\n\n  <div class=\"card\">\n    <h2>Subscribers</h2>\n    <div class=\"row\" style=\"margin-bottom:8px\">\n      <input type=\"text\" id=\"subPhone\" placeholder=\"Phone, e.g. 1443...\" style=\"flex:1\">\n      <button class=\"btn\" onclick=\"addSub()\">Add</button>\n    </div>\n    <table><tbody id=\"subRows\"></tbody></table>\n  </div>\n\n  <div class=\"card\">\n    <h2>Access</h2>\n    <div class=\"hint\">Change the dashboard key. Anyone with the key can control the feed - keep it private.</div>\n    <div style=\"height:8px\"></div>\n    <input type=\"password\" id=\"curKey\" placeholder=\"Current key\">\n    <div style=\"height:8px\"></div>\n    <input type=\"password\" id=\"newKey\" placeholder=\"New key (8+ characters)\">\n    <div style=\"height:8px\"></div>\n    <button class=\"btn\" onclick=\"changeKey()\">Change key</button>\n    <span class=\"hint\" id=\"keyMsg\"></span>\n  </div>\n</div>\n<script>\nlet KEY = localStorage.getItem('buff_admin_key') || '';\nasync function api(path, body) {\n  const res = await fetch('/admin/api' + path, {\n    method: body ? 'POST' : 'GET',\n    headers: { 'content-type': 'application/json', 'x-admin-key': KEY },\n    body: body ? JSON.stringify(body) : undefined\n  });\n  if (res.status === 401) { showLogin('Wrong key.'); throw new Error('401'); }\n  return res.json();\n}\nfunction showLogin(err) {\n  document.getElementById('login').classList.remove('hidden');\n  document.getElementById('app').classList.add('hidden');\n  document.getElementById('loginErr').textContent = err || '';\n}\nfunction saveKey() {\n  KEY = document.getElementById('key').value.trim();\n  localStorage.setItem('buff_admin_key', KEY);\n  load();\n}\nfunction esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }\nasync function load() {\n  let s;\n  try { s = await api('/state'); } catch (e) { return; }\n  document.getElementById('login').classList.add('hidden');\n  document.getElementById('app').classList.remove('hidden');\n  const pt = document.getElementById('pauseToggle');\n  pt.classList.toggle('on', !s.paused);\n  document.getElementById('pauseLabel').innerHTML = s.paused ? '<b class=\"bad\">PAUSED</b> - tap to resume' : '<b class=\"ok\">RUNNING</b> - tap to pause';\n  document.querySelectorAll('.modes button').forEach(b => b.classList.toggle('active', b.dataset.mode === s.mode));\n  document.getElementById('modeHint').textContent =\n    s.mode === 'everything' ? 'Everything delivers (muted/link-only filters still apply). Gemini is bypassed.' :\n    s.mode === 'breaking' ? 'Gemini passes only breaking news and event footage, plus your always-deliver rules.' :\n    'Gemini judges every post against your rules below.';\n  const pb = document.getElementById('powerBtn');\n  pb.textContent = s.power === 'off' ? 'Turn bot ON' : 'Turn bot OFF';\n  pb.style.background = s.power === 'off' ? 'var(--green)' : 'var(--red)';\n  pb.style.color = s.power === 'off' ? '#04101f' : '#fff';\n  document.getElementById('powerHint').textContent = s.power === 'off' ? 'Bot is fully OFF.' : 'Bot is on.' + (s.powerConfigured ? '' : ' (power control not wired yet)');\n  document.getElementById('sLastPoll').textContent = s.lastPoll || 'never';\n  document.getElementById('sLastError').textContent = s.lastError || 'none';\n  document.getElementById('sWa').innerHTML = s.waDown ? '<b class=\"bad\">down</b>' : '<b class=\"ok\">connected</b>';\n  document.getElementById('sGem').textContent = s.gemini + (s.geminiUsage != null ? ' (' + s.geminiUsage + ' calls today)' : '');\n  document.getElementById('sPend').textContent = s.pendingAdds.length ? s.pendingAdds.map(p => '@' + p.handle).join(', ') : 'none';\n  document.getElementById('rules').value = (s.rules || []).join('\\n');\n  const d = s.drop || {};\n  document.getElementById('tgLinks').classList.toggle('on', !!(d.links || s.linkOnlyAll));\n  document.getElementById('tgVideo').classList.toggle('on', !!d.video);\n  document.getElementById('tgImage').classList.toggle('on', !!d.image);\n  document.getElementById('tgGif').classList.toggle('on', !!d.gif);\n  document.getElementById('tgDedup').classList.toggle('on', !s.dedupOff);\n  const v = s.volume || {};\n  document.getElementById('sVol').textContent = (v.delivered||0) + ' / ' + (v.suppressed||0) + ' / ' + (v.filtered||0);\n  if (s.pendingRemovals && s.pendingRemovals.length) document.getElementById('sPend').textContent += ' | queued X-removals: ' + s.pendingRemovals.map(p => '@' + p.handle).join(', ');\n  document.getElementById('watchList').innerHTML = (s.watches || []).map(w =>\n    '<span class=\"chip\">' + esc(w.phrase) + ' <button onclick=\"delWatch(\\'' + esc(w.phrase) + '\\')\">&times;</button></span>').join('') || '<span class=\"hint\">None.</span>';\n  document.getElementById('subRows').innerHTML = (s.subscribers || []).map(p =>\n    '<tr><td>' + esc(p.phone) + (p.paused ? ' <span class=\"muted-h\">(paused)</span>' : '') + '</td>' +\n    '<td style=\"text-align:right\"><button class=\"btn danger\" onclick=\"delSub(\\'' + esc(p.phone) + '\\')\">Remove</button></td></tr>').join('') || '<tr><td class=\"muted-h\">None.</td></tr>';\n}\nasync function setPaused() { const s = await api('/state'); await api('/pause', { paused: !s.paused }); load(); }\nasync function setMode(m) { await api('/mode', { mode: m }); load(); }\nasync function saveRules() { await api('/rules', { rules: document.getElementById('rules').value.split('\\n').map(x => x.trim()).filter(Boolean) }); load(); }\nasync function saveGemKey() { const k = document.getElementById('gemKey').value.trim(); if (!k) return; await api('/gemini-key', { key: k }); document.getElementById('gemKey').value = ''; load(); }\nasync function addWatch() { const p = document.getElementById('watchPhrase').value.trim(); if (!p) return; await api('/watch-add', { phrase: p }); document.getElementById('watchPhrase').value = ''; load(); }\nasync function delWatch(p) { await api('/watch-del', { phrase: p }); load(); }\nasync function addSub() { const p = document.getElementById('subPhone').value.trim(); if (!p) return; await api('/sub-add', { phone: p }); document.getElementById('subPhone').value = ''; load(); }\nasync function delSub(p) { await api('/sub-del', { phone: p }); load(); }\nasync function setDrop(k) { const s = await api('/state'); const d = s.drop || {}; const body = {}; body[k] = !(k === 'links' ? (d.links || s.linkOnlyAll) : d[k]); await api('/drop', body); load(); }\nasync function setDedup() { const s = await api('/state'); await api('/dedup', { off: !s.dedupOff }); load(); }\nasync function changeKey() {\n  const msg = document.getElementById('keyMsg');\n  const res = await fetch('/admin/api/admin-key', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': KEY }, body: JSON.stringify({ current: document.getElementById('curKey').value, next: document.getElementById('newKey').value }) });\n  const j = await res.json().catch(() => ({}));\n  if (res.ok && j.ok) { KEY = document.getElementById('newKey').value; localStorage.setItem('buff_admin_key', KEY); msg.textContent = 'Key changed - you are now using the new key.'; }\n  else msg.textContent = j.error || 'Failed.';\n}\nasync function setPower() { const s = await api('/state'); const on = s.power === 'off'; if (!confirm(on ? 'Turn the bot ON? It resumes from now, no catch-up.' : 'Turn the bot fully OFF? Polling stops and the WhatsApp link suspends.')) return; const r = await api('/power', { on }); if (!r.ok) alert('Power switch had a problem: ' + JSON.stringify(r.steps)); load(); }\nif (KEY) load(); else showLogin();\n</script>\n</body>\n</html>\n";


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
      lastPoll: await env.BUFF_KV.get("last_poll"),
      lastError: await env.BUFF_KV.get("last_error"),
      waDown: !!(await env.BUFF_KV.get("wa_down")),
      gemini: env.GEMINI_API_KEY ? "installed (worker secret)" : ((await env.BUFF_KV.get("gemini_key")) ? "installed (legacy KV - reinstall via panel)" : "not set"),
      geminiUsage: parseInt((await env.BUFF_KV.get(`gem_usage:${day}`)) || "0", 10),
      rules: await getRules(env),
      drop: (filters.drop || {}),
      linkOnlyAll: lowLO.includes("*"),
      dedupOff: !!(await env.BUFF_KV.get("dedup_off")),
      accounts,
      acctRules: await getAcctRules(env),
      pendingAdds: await getPendingAdds(env),
      pendingRemovals: await getJSON(env, "pending_removals", []),
      volume: (await getJSON(env, `vol:${day}`, null)) || { delivered: 0, suppressed: 0, filtered: 0, deferred: 0 },
      power: (await env.BUFF_KV.get("bot_power")) || "on",
      powerConfigured: !!(env.RENDER_API_KEY && env.CF_ADMIN_TOKEN),
      watches: await getWatches(env),
      subscribers: (await getSubscribers(env)).map((s) => ({ phone: s.phone, paused: !!s.paused })),
    });
  }

  if (path === "/admin/api/pause") {
    if (body.paused) await env.BUFF_KV.put("feed_paused", "1"); else await env.BUFF_KV.delete("feed_paused");
    return Response.json({ ok: true });
  }
  if (path === "/admin/api/mode" && VALID_MODES.includes(body.mode)) {
    await env.BUFF_KV.put("feed_mode", body.mode);
    return Response.json({ ok: true });
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
    await env.BUFF_KV.put("filters_v1", JSON.stringify(filters));
    return Response.json({ ok: true });
  }
  if (path === "/admin/api/drop") {
    const filters = await getFilters(env);
    filters.drop = filters.drop || {};
    for (const k of ["links", "video", "image", "gif"]) if (k in body) filters.drop[k] = !!body[k];
    await env.BUFF_KV.put("filters_v1", JSON.stringify(filters));
    return Response.json({ ok: true });
  }
  if (path === "/admin/api/dedup") {
    if (body.off) await env.BUFF_KV.put("dedup_off", "1"); else await env.BUFF_KV.delete("dedup_off");
    return Response.json({ ok: true });
  }
  if (path === "/admin/api/add-account") {
    const h = cleanHandle(body.handle);
    if (!h) return Response.json({ error: "bad handle" }, { status: 400 });
    const pending = await getPendingAdds(env);
    if (!pending.some((p) => String(p.handle).toLowerCase() === h.toLowerCase())) {
      pending.push({ handle: h, at: Date.now() });
      await env.BUFF_KV.put("pending_adds", JSON.stringify(pending));
    }
    return Response.json({ ok: true, staged: h });
  }
  if (path === "/admin/api/rules" && Array.isArray(body.rules)) {
    const rules = body.rules.map((r) => String(r).slice(0, 500)).filter(Boolean).slice(0, 40);
    await env.BUFF_KV.put("gemini_rules", JSON.stringify(rules));
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
      await env.BUFF_KV.put("x_session", JSON.stringify({ auth_token: r.auth_token, ct0: r.ct0, ts: Date.now() }));
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
      await env.BUFF_KV.put("x_session", JSON.stringify({ auth_token: at, ct0: ct, ts: Date.now() }));
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
    const out = items.map((t) => { const gv = verdicts.get(t.id) || {}; return { id: t.id, account: "@" + t.handle, deliver: gv.d !== false, reason: gv.r, text: (t.text || t.origText || "").slice(0, 80) }; });
    return Response.json({ ok: true, geminiReachable: reachable, probeError: probeErr, mode, tested: out.length, deliver: out.filter((v) => v.deliver).length, drop: out.filter((v) => !v.deliver).length, verdicts: out });
  }
  if (path === "/admin/api/admin-key") {
    const configured = (await env.BUFF_KV.get("admin_key")) || env.ADMIN_SECRET;
    if (body.current !== configured) return Response.json({ error: "current key wrong" }, { status: 403 });
    const next = String(body.next || "").trim();
    if (next.length < 8) return Response.json({ error: "new key must be 8+ chars" }, { status: 400 });
    await env.BUFF_KV.put("admin_key", next);
    return Response.json({ ok: true });
  }
  if (path === "/admin/api/acct-rule") {
    const h = cleanHandle(body.handle);
    if (!h) return Response.json({ error: "bad handle" }, { status: 400 });
    const rules = await getAcctRules(env);
    const rule = String(body.rule || "").trim().slice(0, 500);
    if (rule) rules[h.toLowerCase()] = rule; else delete rules[h.toLowerCase()];
    await env.BUFF_KV.put("acct_rules", JSON.stringify(rules));
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
      await env.BUFF_KV.put("filters_v1", JSON.stringify(filters));
    }
    const rem = await getJSON(env, "pending_removals", []);
    if (!rem.some((r) => String(r.handle).toLowerCase() === h.toLowerCase())) {
      rem.push({ handle: h, at: Date.now() });
      await env.BUFF_KV.put("pending_removals", JSON.stringify(rem));
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
      await env.BUFF_KV.put("bot_power", "off");
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
    await env.BUFF_KV.put("watches", JSON.stringify(watches));
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
    await env.BUFF_KV.put("subscribers", JSON.stringify(subs));
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
        // heartbeat FIRST: proves the cron fired and keeps the Render free-tier socket warm even if the poll below is killed mid-run
        try { await fetch(env.BRIDGE_URL + "/status", { headers: { authorization: env.BRIDGE_SECRET }, signal: AbortSignal.timeout(10000) }); } catch (e) {}
        try { await env.BUFF_KV.put("last_poll", `${new Date().toISOString()} tick`); } catch (e) {}
        try {
          const purged = await purgeOldSent(env); // Plan B auto-clear: delete the bot's own feed messages older than 24h
          const result = await poll(env, 6); // cap per-tick deliveries so the run stays inside the cron time budget; remainder flows next minute
          await env.BUFF_KV.put("last_poll", `${new Date().toISOString()} ${result}${purged ? ` purged=${purged}` : ""} (${Date.now() - t0}ms)`);
        } catch (e) {
          try {
            const msg = `${new Date().toISOString()} ${e.message}`;
            const prev = await env.BUFF_KV.get("last_error");
            if (!prev || prev.slice(24) !== msg.slice(24)) await env.BUFF_KV.put("last_error", msg);
          } catch (e2) {}
        }
        // Shabbos release: window over + digest pending -> send the one rundown, then live delivery resumes
        try {
          if (!(await shabbosHoldActive(env)) && (await env.BUFF_KV.get("shabbos_digest_pending"))) {
            await env.BUFF_KV.delete("shabbos_digest_pending");
            await sendShabbosDigest(env);
          }
        } catch (e) {}
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
      const lastPoll = await env.BUFF_KV.get("last_poll");
      const lastError = await env.BUFF_KV.get("last_error");
      const pausedF = !!(await env.BUFF_KV.get("feed_paused"));
      const waDown = !!(await env.BUFF_KV.get("wa_down"));
      const subs = await getSubscribers(env);
      const filters = await getFilters(env);
  const watches = await getWatches(env);
  const retained = []; // pushed into feed_items at the end (one batched write)
      const pending = await getPendingAdds(env);
      return Response.json({ ok: true, lastPoll, lastError, paused: pausedF, waDown, subscribers: subs.length, filters, pendingAdds: pending, mode: await getMode(env) });
    }
    if (url.pathname === "/poll-now" && [env.VERIFY_TOKEN, env.BRIDGE_SECRET].includes(url.searchParams.get("key"))) {
      const result = await poll(env);
      return Response.json({ result });
    }
    return new Response("buff", { status: 200 });
  }
};
