export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    // Quick health check so the app can tell "server unreachable" from "Gemini slow".
    if (request.method === "GET") return json({ ok: true });

    if (request.method !== "POST") return json({ error: { message: "Method not allowed" } }, 405);

    try {
      const body = await request.json();
      const apiKey = (env.GEMINI_API_KEY || "").trim();
      if (!apiKey) return json({ error: { message: "Missing GEMINI_API_KEY in Cloudflare Variables." } }, 500);

      // Tries the newest model first. If it is slow or busy, falls back to the next one.
      const MODELS = ["gemini-3.8-flash", "gemini-2.5-flash"];
      const PER_MODEL_MS = 20000;

      const generationFor = (model, extra) => {
        const cfg = { ...extra };
        if (model.startsWith("gemini-3")) cfg.thinkingConfig = { thinkingLevel: "low" };
        return cfg;
      };

      async function askGemini(prompt, extraConfig) {
        let last = { status: 504, data: { error: { message: "The AI is busy right now. Please try again." } } };
        for (const model of MODELS) {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), PER_MODEL_MS);
          try {
            const res = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: prompt }] }],
                  generationConfig: generationFor(model, extraConfig),
                }),
                signal: ac.signal,
              }
            );
            const data = await res.json().catch(() => ({}));
            if (res.ok) return { status: 200, data: { ...data, model } };
            last = { status: res.status, data };
            if (![404, 429, 500, 503].includes(res.status)) break; // real error, do not retry
          } catch (err) {
            last = { status: 504, data: { error: { message: `${model} did not answer in time.` } } };
          } finally {
            clearTimeout(timer);
          }
        }
        return last;
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
