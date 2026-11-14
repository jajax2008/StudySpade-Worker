export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj, null, 2), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    const apiKey = (env.GEMINI_API_KEY || "").trim();
    const BASE = "https://generativelanguage.googleapis.com/v1beta/";

    // Models this key can use (ids only).
    async function listModels() {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 8000);
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

    // GET = health check. GET ?models = shows which models your key can use.
    if (request.method === "GET") {
      const url = new URL(request.url);
      if (url.searchParams.has("models")) {
        if (!apiKey) return json({ error: "Missing GEMINI_API_KEY" }, 500);
        try {
          return json({ models: await listModels() });
        } catch (e) {
          return json({ error: "Could not list models: " + e.message }, 504);
        }
      }
      return json({ ok: true, hasKey: !!apiKey });
    }

    if (request.method !== "POST") return json({ error: { message: "Method not allowed" } }, 405);

    try {
      const body = await request.json();
      if (!apiKey) return json({ error: { message: "Missing GEMINI_API_KEY in Cloudflare Variables." } }, 500);

      const PREFERRED = "gemini-3.8-flash";

      const generationFor = (model, extra) => {
        const cfg = { ...extra };
        if (model.startsWith("gemini-3")) cfg.thinkingConfig = { thinkingLevel: "low" };
        return cfg;
      };

      // Tries the preferred model. If it hangs or fails, discovers other Flash models
      // this key can use and tries those, so one slow model never blocks the app.
      async function askGemini(prompt, extraConfig) {
        const problems = [];
        const tried = new Set();
        let queue = [PREFERRED];
        let discovered = false;

        while (queue.length && tried.size < 3) {
          const model = queue.shift();
          if (tried.has(model)) continue;
          tried.add(model);
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), tried.size === 1 ? 20000 : 12000);
          try {
            const res = await fetch(`${BASE}models/${model}:generateContent`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: generationFor(model, extraConfig),
              }),
              signal: ac.signal,
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) return { status: 200, data: { ...data, model } };
            const msg = (data.error && data.error.message) || "status " + res.status;
            problems.push(`${model}: ${msg}`.slice(0, 160));
            if ([400, 401, 403].includes(res.status)) break; // key or request problem
          } catch (err) {
            problems.push(`${model}: no answer in time`);
          } finally {
            clearTimeout(timer);
          }

          if (!discovered) {
            discovered = true;
            try {
              const ids = await listModels();
              const others = ids
                .filter((id) => /^gemini-[\d.]+-flash(-lite)?$/.test(id) && !tried.has(id))
                .sort(
                  (a, b) =>
                    parseFloat(b.match(/[\d.]+/)[0]) - parseFloat(a.match(/[\d.]+/)[0]) ||
                    b.includes("lite") - a.includes("lite")
                );
              queue = queue.concat(others);
            } catch (e) {
              problems.push("could not list models");
            }
          }
        }
        return { status: 504, data: { error: { message: problems.join(" | ") || "The AI is busy. Try again." } } };
      }

      // Mode 1: StudyBuddy chat
      if (body.mode === "chat") {
        const question = (body.question || "").slice(0, 2000);
        const context = (body.context || "").slice(0, 30000);
        const source = body.source || "web";
        if (!question) return json({ error: { message: "Please enter a question." } }, 400);

        const prompt =
          source === "notes"
            ? `You are StudyBuddy. Answer the student's question based PRIMARILY on their study notes below. If the answer is not in the notes, say so briefly and then provide the general answer.\n\nStudent's Study Notes:\n${context || "No notes provided."}\n\nQuestion:\n${question}`
            : `You are StudyBuddy, a smart, fast academic tutor. Answer the student's question clearly and concisely using accurate general knowledge (and their notes if relevant).\n\nOptional Notes Context:\n${context || "None"}\n\nQuestion:\n${question}`;

        const out = await askGemini(prompt, { maxOutputTokens: 800 });
        return json(out.data, out.status);
      }

      // Mode 2: Flashcards and summary
      const text = (body.text || "").trim();
      if (text.length < 30) return json({ error: { message: "Text is too short to summarize." } }, 400);

      const promptText = text.slice(0, 22000);
      const out = await askGemini(
        `Summarize the following study material into 4 to 6 key bullet points, and create 8 to 12 multiple-choice flashcards. Return ONLY valid JSON matching this exact structure: {"summary":["point 1","point 2"],"cards":[{"q":"question","a":"exact correct answer","choices":["choice 1","choice 2","choice 3","choice 4"]}]}. Make sure "a" is included inside "choices".\n\nStudy Material:\n${promptText}`,
        { responseMimeType: "application/json", maxOutputTokens: 2500 }
      );
      return json(out.data, out.status);
    } catch (err) {
      return json({ error: { message: err.message } }, 500);
    }
  },
};
