// StudySpace AI worker
//
// Cloudflare setup (Workers > your worker > Settings):
//   Secrets / Variables:
//     GEMINI_API_KEY    = key 1  (StudyBuddy chat + Life Buddy chat)
//     GEMINI_API_KEY_2  = key 2  (summaries + flashcards only)
//     GEMINI_API_KEY_3  = key 3  (Socratic Ledger Companion / Accounting tutor)
//     ALLOWED_ORIGIN    = https://your-app-address   (comma-separate several if needed)
//     GEMINI_MODEL      = optional override. Default is gemini-3.8-flash. Ids: YOUR_WORKER_URL?models
//   KV namespace binding:
//     QUOTA             = a KV namespace (enables the server-side daily limits)

const TZ_OFFSET_H = 8; // Philippines (UTC+8): daily limits reset at local midnight
const LIMITS = { chat: 30, life: 40, cards: 2, acct: 40 }; // per device per day
const IP_FACTOR = 6; // per-IP cap = limit x 6 (phone networks often share one IP)

// Backstop only: the app checks for crisis wording first, this catches anything that slips through.
const CRISIS_RE = [
  /kill(ing)?\s+my\s?self\b/, /\bsuicid/, /\bend(ing)?\s+(my\s+life|it\s+all)/,
  /take\s+my\s+(own\s+)?life/, /(want|wanna|wish)\s+(to\s+)?(die|be\s+dead|disappear\s+forever)/,
  /wish\s+(i|that\s+i)\s+(was|were|could|would)\s+(dead|die|not\s+alive|never\s+born)/,
  /(don'?t|do\s+not|dont)\s+(want\s+to|wanna)\s+(live|be\s+alive|exist)/,
  /no\s+(reason|point)\s+(to|in)\s+(live|living|going\s+on)/, /better\s+off\s+(dead|without\s+me)/,
  /(hurt|harm|cut|cutting|injure)(ing)?\s+(my\s?self)/, /self[\s-]?harm/, /\boverdos/,
  /magpakamatay|magpapakamatay|nagpakamatay/,
  /gusto\s+(ko\s+|kong\s+)?(na\s+)?(nang\s+|ng\s+)?mamatay/,
  /(ayoko|ayaw)\s+(ko\s+)?(na\s+)?(nang\s+|ng\s+)?mabuhay/,
  /(tapusin|wakasan)\s+(ko\s+)?(na\s+)?(ang\s+)?(buhay|lahat)/,
  /(saktan|sasaktan|sugatan)\s+(ko\s+)?(na\s+)?(ang\s+)?(sarili|aking\s+sarili)/,
  /patayin\s+ko\s+(na\s+)?(ang\s+)?sarili/,
];
const isCrisis = (t) => {
  const s = String(t || "").toLowerCase().replace(/[\u2018\u2019]/g, "'");
  return CRISIS_RE.some((r) => r.test(s));
};

const LIFE_SYSTEM = `You are Life Buddy, a warm, gentle companion inside a student's study app. You are not a therapist, doctor or emergency service, and you never diagnose or label the person's feelings or conditions.
How to reply:
- Listen first. Reflect what the person said in simple words, without exaggerating it.
- Keep replies short: 2 to 4 sentences. Ask at most ONE gentle question at a time.
- No long lists and no lectures. Offer one small practical idea only when it fits (water, a short walk, a minute of slow breathing, writing it down).
- When it fits naturally, encourage talking to real people they trust (family, a friend, a teacher, a counselor).
- Do not claim you understand exactly how they feel, do not promise outcomes, do not be preachy, do not agree that things are hopeless.
- If the person mentions hurting themselves, wanting to die, suicide, or being in danger: stop normal chatting. Reply with care in one or two sentences, urge them to contact someone they trust or a crisis line (Philippines: NCMH 1553 or 0917-899-8727, Hopeline 2919 or 0917-558-4673), or 911 if in danger. Never give methods or details.
- Reply in the language the person writes in (English, Tagalog or Taglish).
- Stay on feelings, stress, school pressure, relationships and motivation. For homework or study questions, say StudyBuddy in the Academics tab is the better place.`;

const ACCT_SYSTEM = `You are the Socratic Ledger Companion, a strict but supportive CPA accounting professor tutoring a student through a full-cycle accounting assessment.
Core Rules:
1. EXTRACT RULES SILENTLY: Check the uploaded assessment text for system rules (e.g., Periodic vs. Perpetual inventory, Gross vs. Net method, special journals, beginning balances) and strictly enforce them.
2. TRACE-BACK & DOMINO WARNINGS: When a student asks about a transaction (like a payment, collection, or adjusting entry), check earlier dates in the assessment for prior returns, allowances, trade discounts, or beginning balances. Ask the student if they accounted for those specific earlier dates before they compute the final amount.
3. NEVER GIVE DIRECT ANSWERS: Never output a complete formatted journal entry (do not hand them "Debit X ₱xxx, Credit Y ₱xxx") and never give the final calculated peso amount unless the student states that exact number first to verify their own calculation.
4. VALIDATE ATTEMPTS: If the student shares their proposed Debit/Credit or calculation, tell them which part of their logic is right and guide them to fix any error (e.g., trade discount vs. cash discount, wrong special journal, or missing return).
5. Keep responses concise (2 to 4 sentences) and end with a guiding question or ask what their T-account/calculator currently shows.`;

export default {
  async fetch(request, env) {
    const reqOrigin = request.headers.get("Origin");
    const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
    const originOk = !allowed.length || !reqOrigin || allowed.includes(reqOrigin);
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowed.length ? (allowed.includes(reqOrigin) ? reqOrigin : allowed[0]) : "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj, null, 2), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (!originOk) return json({ error: { message: "Not allowed from this site." } }, 403);

    const key1 = (env.GEMINI_API_KEY || "").trim();
    const key2 = (env.GEMINI_API_KEY_2 || "").trim() || key1; // falls back to key 1 if key 2 is missing
    const key3 = (env.GEMINI_API_KEY_3 || "").trim() || key1; // falls back to key 1 if key 3 is missing
    const BASE = "https://generativelanguage.googleapis.com/v1beta/";
    const PREFERRED = (env.GEMINI_MODEL || "").trim() || "gemini-3.8-flash";

    // Compares versions like 3.8 vs 3.10 correctly (parseFloat would get this wrong).
    const verCmp = (a, b) => {
      const x = a.match(/\d+(\.\d+)*/)[0].split(".").map(Number);
      const y = b.match(/\d+(\.\d+)*/)[0].split(".").map(Number);
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] || 0) - (y[i] || 0);
        if (d) return d;
      }
      return 0;
    };

    // Models a key can use (ids only).
    async function listModels(apiKey) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      try {
        const res = await fetch(BASE + "models?pageSize=200", {
          headers: { "x-goog-api-key": apiKey },
          signal: ac.signal,
        });
        const data = await res.json();
        return (data.models || [])
          .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
          .map((m) => m.name.replace("models/", ""));
      } finally {
        clearTimeout(timer);
      }
    }

    // GET = health check. GET ?models = models key 1 can use. GET ?models&key=2 = same for key 2.
    if (request.method === "GET") {
      const url = new URL(request.url);
      if (url.searchParams.has("models")) {
        const k = url.searchParams.get("key") === "2" ? (env.GEMINI_API_KEY_2 || "").trim() : url.searchParams.get("key") === "3" ? (env.GEMINI_API_KEY_3 || "").trim() : key1;
        if (!k) return json({ error: "Missing key" }, 500);
        try {
          return json({ models: await listModels(k) });
        } catch (e) {
          return json({ error: "Could not list models: " + e.message }, 504);
        }
      }
      return json({
        ok: true,
        hasKey: !!key1,
        hasKey2: !!(env.GEMINI_API_KEY_2 || "").trim(),
        hasKey3: !!(env.GEMINI_API_KEY_3 || "").trim(),
        hasQuota: !!env.QUOTA,
        restricted: allowed.length > 0,
      });
    }

    if (request.method !== "POST") return json({ error: { message: "Method not allowed" } }, 405);

    // ---- daily limits (per device, plus a looser per-IP cap) ----
    const ip = request.headers.get("CF-Connecting-IP") || "anon";
    async function checkQuota(kind, device) {
      if (!env.QUOTA) return { ok: true };
      const day = new Date(Date.now() + TZ_OFFSET_H * 3600e3).toISOString().slice(0, 10);
      const devKey = `q:${kind}:${day}:d:${device || "none"}`;
      const ipKey = `q:${kind}:${day}:i:${ip}`;
      const [d, i] = await Promise.all([env.QUOTA.get(devKey), env.QUOTA.get(ipKey)]);
      const du = parseInt(d || "0", 10), iu = parseInt(i || "0", 10);
      if (du >= LIMITS[kind] || iu >= LIMITS[kind] * IP_FACTOR) return { ok: false };
      return {
        ok: true,
        commit: () =>
          Promise.all([
            env.QUOTA.put(devKey, String(du + 1), { expirationTtl: 172800 }),
            env.QUOTA.put(ipKey, String(iu + 1), { expirationTtl: 172800 }),
          ]).catch(() => {}),
      };
    }

    try {
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object") return json({ error: { message: "Bad request." } }, 400);

      const device = /^[a-z0-9]{8,40}$/i.test(body.device || "") ? body.device : "";
      const mode = ["chat", "life", "acct"].includes(body.mode) ? body.mode : "cards";
      const kind = mode;
      const apiKey = mode === "cards" ? key2 : mode === "acct" ? key3 : key1;
      if (!apiKey) return json({ error: { message: "The AI key is not set up on the server." } }, 500);

      const generationFor = (model, extra) => {
        const cfg = { ...extra };
        const major = parseInt((model.match(/^gemini-(\d+)/) || [])[1] || "0", 10);
        if (major >= 3) {
          delete cfg.temperature;
          delete cfg.topP;
          delete cfg.topK;
          cfg.thinkingConfig = { thinkingLevel: "low" };
        } else if (/^gemini-2\.5-flash/.test(model)) {
          cfg.thinkingConfig = { thinkingBudget: 0 };
        }
        return cfg;
      };

      async function askGemini(contents, extraConfig, systemText) {
        const problems = [];
        const tried = new Set();
        let queue = [PREFERRED];
        let discovered = false;

        while (queue.length && tried.size < 3) {
          const model = queue.shift();
          if (tried.has(model)) continue;
          tried.add(model);
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), tried.size === 1 ? 14000 : 9000);
          try {
            const payload = { contents, generationConfig: generationFor(model, extraConfig) };
            if (systemText) payload.systemInstruction = { parts: [{ text: systemText }] };
            const res = await fetch(`${BASE}models/${model}:generateContent`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
              body: JSON.stringify(payload),
              signal: ac.signal,
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) return { status: 200, data: { ...data, model } };
            const msg = (data.error && data.error.message) || "status " + res.status;
            problems.push(`${model}: ${msg}`.slice(0, 160));
            if ([400, 401, 403].includes(res.status)) break;
          } catch (err) {
            problems.push(`${model}: no answer in time`);
          } finally {
            clearTimeout(timer);
          }

          if (!discovered) {
            discovered = true;
            try {
              const ids = await listModels(apiKey);
              const others = ids
                .filter((id) => /^gemini-[\d.]+-flash(-lite)?$/.test(id) && !tried.has(id))
                .sort((a, b) => verCmp(b, a) || b.includes("lite") - a.includes("lite"));
              queue = queue.concat(others);
            } catch (e) {
              problems.push("could not list models");
            }
          }
        }
        return { status: 504, data: { error: { message: problems.join(" | ") || "The AI is busy. Try again." } } };
      }

      const finish = async (out, q) => {
        if (out.status === 200 && q && q.commit) await q.commit();
        return json(out.data, out.status);
      };
      const limitReply = () =>
        json({ error: { message: "Daily limit reached. It resets at midnight.", code: "limit" } }, 429);

      // Mode: Life Buddy (key 1)
      if (mode === "life") {
        const question = (body.question || "").toString().slice(0, 1000).trim();
        if (!question) return json({ error: { message: "Please write a message." } }, 400);

        if (isCrisis(question)) return json({ crisis: true });

        const q = await checkQuota("life", device);
        if (!q.ok) return limitReply();

        const turns = [];
        const hist = Array.isArray(body.history) ? body.history.slice(-8) : [];
        for (const h of hist) {
          const role = h && h.role === "model" ? "model" : h && h.role === "user" ? "user" : null;
          const text = h && typeof h.text === "string" ? h.text.slice(0, 600) : "";
          if (!role || !text) continue;
          const last = turns[turns.length - 1];
          if (last && last.role === role) last.parts[0].text += "\n" + text;
          else turns.push({ role, parts: [{ text }] });
        }
        while (turns.length && turns[0].role !== "user") turns.shift();
        const lastT = turns[turns.length - 1];
        if (lastT && lastT.role === "user") lastT.parts[0].text += "\n" + question;
        else turns.push({ role: "user", parts: [{ text: question }] });

        const out = await askGemini(turns, { maxOutputTokens: 1000, temperature: 0.7 }, LIFE_SYSTEM);
        return finish(out, q);
      }

      // Mode: Socratic Ledger Companion (key 3)
      if (mode === "acct") {
        const question = (body.question || "").toString().slice(0, 2000).trim();
        const context = (body.context || "").toString().slice(0, 35000);
        const attempt = (body.attempt || "").toString().slice(0, 1000).trim();
        if (!question && !attempt) return json({ error: { message: "Please enter your question or trial entry." } }, 400);

        const q = await checkQuota("acct", device);
        if (!q.ok) return limitReply();

        const turns = [];
        const hist = Array.isArray(body.history) ? body.history.slice(-6) : [];
        for (const h of hist) {
          const role = h && h.role === "model" ? "model" : h && h.role === "user" ? "user" : null;
          const text = h && typeof h.text === "string" ? h.text.slice(0, 600) : "";
          if (!role || !text) continue;
          const last = turns[turns.length - 1];
          if (last && last.role === role) last.parts[0].text += "\n" + text;
          else turns.push({ role, parts: [{ text }] });
        }
        while (turns.length && turns[0].role !== "user") turns.shift();

        const userMsg = `${context ? `[Uploaded Assessment / Ledger Context]:\n${context}\n\n` : ""}${attempt ? `[Student's Trial Entry / Calculation]:\n${attempt}\n\n` : ""}[Student's Question]:\n${question || "Please check my trial entry above."}`;
        const lastT = turns[turns.length - 1];
        if (lastT && lastT.role === "user") lastT.parts[0].text += "\n\n" + userMsg;
        else turns.push({ role: "user", parts: [{ text: userMsg }] });

        const out = await askGemini(turns, { maxOutputTokens: 1200, temperature: 0.4 }, ACCT_SYSTEM);
        return finish(out, q);
      }

      // Mode: StudyBuddy chat (key 1)
      if (mode === "chat") {
        const question = (body.question || "").toString().slice(0, 2000);
        const context = (body.context || "").toString().slice(0, 30000);
        const source = body.source || "web";
        if (!question) return json({ error: { message: "Please enter a question." } }, 400);

        const q = await checkQuota("chat", device);
        if (!q.ok) return limitReply();

        const prompt =
          source === "notes"
            ? `You are StudyBuddy. Answer the student's question based PRIMARILY on their study notes below. If the answer is not in the notes, say so briefly and then provide the general answer.\n\nStudent's Study Notes:\n${context || "No notes provided."}\n\nQuestion:\n${question}`
            : `You are StudyBuddy, a smart, fast academic tutor. Answer the student's question clearly and concisely using accurate general knowledge (and their notes if relevant).\n\nOptional Notes Context:\n${context || "None"}\n\nQuestion:\n${question}`;

        const out = await askGemini([{ role: "user", parts: [{ text: prompt }] }], { maxOutputTokens: 2000 });
        return finish(out, q);
      }

      // Mode: flashcards and summary (key 2)
      const text = (body.text || "").toString().trim();
      if (text.length < 30) return json({ error: { message: "Text is too short to summarize." } }, 400);

      const q = await checkQuota("cards", device);
      if (!q.ok) return limitReply();

      const promptText = text.slice(0, 22000);
      const out = await askGemini(
        [
          {
            role: "user",
            parts: [
              {
                text: `Summarize the following study material into 4 to 6 key bullet points, and create 8 to 12 multiple-choice flashcards. Return ONLY valid JSON matching this exact structure: {"summary":["point 1","point 2"],"cards":[{"q":"question","a":"exact correct answer","choices":["choice 1","choice 2","choice 3","choice 4"]}]}. Make sure "a" is included inside "choices".\n\nStudy Material:\n${promptText}`,
              },
            ],
          },
        ],
        { responseMimeType: "application/json", maxOutputTokens: 6000 }
      );
      return finish(out, q);
    } catch (err) {
      return json({ error: { message: err.message } }, 500);
    }
  },
};
