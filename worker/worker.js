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
    }
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
      if (variants.length) media.push({ kind: "video", url: variants[0].url });
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

// ---------- message formatting: every message leads with bold Display Name (@handle) ----------

function formatBody(t) {
  if (t.kind === "retweet") {
    return `*${t.name} (@${t.handle})* retweeted *${t.origName} (@${t.origHandle})*:\n\n${t.origText}`;
  }
  if (t.kind === "quote") {
    return `*${t.name} (@${t.handle})* commented:\n${t.text}\n\n----------\n*${t.quotedName} (@${t.quotedHandle})* posted:\n${t.quotedText}`;
  }
  return `*${t.name} (@${t.handle})*\n\n${t.text}`;
}

// ---------- bridge delivery ----------

async function bridgeSend(env, payload, to) {
  const res = await fetch(`${env.BRIDGE_URL}/send`, {
    method: "POST",
    headers: { authorization: env.BRIDGE_SECRET, "content-type": "application/json" },
    body: JSON.stringify({ ...payload, to })
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
    if (!firstId) firstId = id;
    await sleep(250);
  }
  return firstId;
}

async function deliverTweet(env, t) {
  // media first (no captions), then the labeled text message
  for (const m of t.media) {
    await deliverToAll(env, m.kind === "image" ? { imageUrl: m.url } : { videoUrl: m.url });
    await sleep(250);
  }
  return deliverToAll(env, { text: formatBody(t) });
}

// ---------- state helpers (batched KV keys to stay under free-tier write quota) ----------

async function getJSON(env, key, fallback) {
  try { const v = await env.BUFF_KV.get(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
}
const getFilters = (env) => getJSON(env, "filters_v1", { muted: [], linkOnly: [] }); // linkOnly: ["*"] or handles
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
  if (filters.muted.map((x) => x.toLowerCase()).includes(h)) return false;
  const lo = filters.linkOnly.map((x) => x.toLowerCase());
  if ((lo.includes("*") || lo.includes(h)) && t.kind === "post" && isLinkOnly(t)) return false;
  return true;
}

// ---------- poll ----------

async function poll(env) {
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

  if (paused || waDown) {
    // hold as unseen: delivers on resume/recovery (they're not marked seen)
    return `delivered=0 dropped=0 skipped=${skipped} filtered=0 deferred=${unseen.length}${paused ? " paused" : ""}${waDown ? " wa_down" : ""}`;
  }

  let delivered = 0, dropped = 0, deferred = 0, filtered = 0;
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
    try {
      await deliverTweet(env, t);
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
  if (retained.length) {
    const items = await getFeedItems(env);
    items.push(...retained);
    await env.BUFF_KV.put(FEED_ITEMS_KEY, JSON.stringify(items.slice(-FEED_ITEMS_MAX)));
  }
  return `delivered=${delivered} dropped=${dropped} skipped=${skipped} filtered=${filtered} deferred=${deferred}${paused ? " paused" : ""}${waDown ? " wa_down" : ""}`;
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
      await bridgeSend(env, { text: formatBody(it) }, from).catch(() => {});
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

// ---------- entrypoints ----------

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          const result = await poll(env);
          if (!result.includes("scan-quiet")) {
            await env.BUFF_KV.put("last_poll", `${new Date().toISOString()} ${result}`);
          }
        } catch (e) {
          try {
            const msg = `${new Date().toISOString()} ${e.message}`;
            const prev = await env.BUFF_KV.get("last_error");
            if (!prev || prev.slice(24) !== msg.slice(24)) await env.BUFF_KV.put("last_error", msg);
          } catch (e2) {}
        }
      })()
    );
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
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
      return Response.json({ ok: true, lastPoll, lastError, paused: pausedF, waDown, subscribers: subs.length, filters, pendingAdds: pending });
    }
    if (url.pathname === "/poll-now" && url.searchParams.get("key") === env.VERIFY_TOKEN) {
      const result = await poll(env);
      return Response.json({ result });
    }
    return new Response("buff", { status: 200 });
  }
};
