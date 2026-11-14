export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    try {
      const body = await request.json();
      const apiKey = (env.GEMINI_API_KEY || "").trim();
      if (!apiKey) {
        return new Response(JSON.stringify({ error: { message: "Missing GEMINI_API_KEY in Cloudflare Variables." } }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const model = "gemini-2.5-flash";
      const url = `[https://generativelanguage.googleapis.com/v1beta/models/$](https://generativelanguage.googleapis.com/v1beta/models/$){model}:generateContent?key=${encodeURIComponent(apiKey)}`;

      // Mode 1: Fast StudyBuddy Online AI Chat (20/day)
      if (body.mode === "chat") {
        const question = (body.question || "").slice(0, 2000);
        const context = (body.context || "").slice(0, 15000);
        if (!question) {
          return new Response(JSON.stringify({ error: { message: "Please enter a question." } }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        const geminiRes = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: `You are StudyBuddy, a fast, concise study tutor. Answer clearly in 2 to 5 sentences or short bullet points.\n\nStudy Material Context:\n${context || "None provided."}\n\nQuestion:\n${question}`
              }]
            }],
            generationConfig: {
              maxOutputTokens: 500,
              temperature: 0.3
            }
          })
        });

        const data = await geminiRes.json();
        return new Response(JSON.stringify(data), {
          status: geminiRes.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // Mode 2: Fast Flashcards & Summary Generator (2/day)
      const text = (body.text || "").trim();
      if (text.length < 30) {
        return new Response(JSON.stringify({ error: { message: "Text is too short to summarize." } }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const promptText = text.slice(0, 20000);
      const geminiRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `Summarize the study material into 4 to 6 key bullet points, and create 8 to 12 multiple-choice flashcards. Return ONLY valid JSON matching this exact structure: {"summary":["point 1","point 2"],"cards":[{"q":"question","a":"exact correct answer","choices":["choice 1","choice 2","choice 3","choice 4"]}]}. Make sure "a" is included inside "choices".\n\nStudy Material:\n${promptText}`
            }]
          }],
          generationConfig: {
            responseMimeType: "application/json",
            maxOutputTokens: 2048,
            temperature: 0.3
          }
        })
      });

      const data = await geminiRes.json();
      return new Response(JSON.stringify(data), {
        status: geminiRes.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: { message: err.message } }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};