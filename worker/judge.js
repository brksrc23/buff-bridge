const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export default {
  async fetch(req, env) {
    try {
      if (req.method !== "POST") return new Response("buff-wai-judge", { status: 200 });
      if ((req.headers.get("x-judge-key") || "") !== (env.JUDGE_SECRET || "unset")) return new Response("forbidden", { status: 403 });
      const body = await req.json();
      const rules = body.rules || [], mode = body.mode || "breaking", tweets = body.tweets || [], acctRules = body.acctRules || {}, recent = body.recent || [];
      if (!Array.isArray(tweets) || !tweets.length) return Response.json({ verdicts: null });
      const ar = acctRules;
      const brief = tweets.map((t) => ({ id: t.id, account: "@" + t.handle, accountRule: ar[(t.handle || "").toLowerCase()] || undefined, kind: t.kind, hasMedia: (t.media || []).length > 0, text: (t.text || "").slice(0, 400), quoted: t.quotedText ? String(t.quotedText).slice(0, 200) : undefined, original: t.origText ? String(t.origText).slice(0, 200) : undefined }));
      const prompt = "You are the gatekeeper for one user's X-to-WhatsApp news feed. Decide for each post whether it is DELIVERED to their phone.\nStanding rules:\n- " + rules.join("\n- ") + "\nWhen a post has accountRule, apply it to that post in addition to the standing rules.\n" + (mode === "breaking" ? "MODE: BREAKING NEWS ONLY. Deliver only urgent breaking news and on-the-ground event footage; drop everything else, even posts a looser filter would keep.\n" : "MODE: CUSTOM. Judge every post against the standing rules.\n") + (recent && recent.length ? "ALREADY DELIVERED recently (each line is one delivered post):\n- " + recent.slice(-20).join("\n- ") + "\nDrop restatements of these unless they add MATERIALLY new information.\n" : "") + "Posts:\n" + JSON.stringify(brief) + "\nReply with ONLY a JSON array like [{\"id\":\"...\",\"deliver\":true}] covering EVERY post id. No prose, no markdown fences.";
      const out = await env.AI.run(MODEL, { messages: [{ role: "user", content: prompt }], max_tokens: 1500, temperature: 0 });
      let arr = null;
      if (out && Array.isArray(out.response)) arr = out.response; // 70b-fp8-fast returns parsed JSON for array-shaped answers
      else {
        const txt = (out && typeof out.response === "string") ? out.response : "";
        const start = txt.indexOf("["), end = txt.lastIndexOf("]");
        if (start < 0 || end <= start) return Response.json({ verdicts: null });
        arr = JSON.parse(txt.slice(start, end + 1));
      }
      const wanted = new Set(tweets.map((t) => String(t.id)));
      const verdicts = [];
      for (const v of arr) if (v && v.id != null && typeof v.deliver === "boolean" && wanted.has(String(v.id))) verdicts.push([String(v.id), { d: v.deliver, r: "wai" }]);
      return Response.json({ verdicts: verdicts.length ? verdicts : null, usage: (out && out.usage) || null });
    } catch (e) { return Response.json({ verdicts: null, err: String(e && e.message || e).slice(0, 200) }); }
  }
};
