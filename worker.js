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

      // Official Gemini 3.8 Flash endpoint using x-goog-api-key header & thinkingLevel: "low" for fast speed
      const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent";
      const headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      };

      // Mode 1: StudyBuddy Online AI Chat (Supports both "web" general knowledge and "notes" search)
      if (body.mode === "chat") {
        const question = (body.question || "").slice(0, 2000);
        const context = (body.context || "").slice(0, 18000);
        const source = body.source || "web"; // "web" or "notes"

        if (!question) {
          return new Response(JSON.stringify({ error: { message: "Please enter a question." } }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        const prompt = source === "notes"
          ? `You are StudyBuddy. Answer the student's question based PRIMARILY on their study notes below. If the answer is not in the notes, say so briefly and then provide the general answer.\n\nStudent's Study Notes:\n${context || "No notes provided."}\n\nQuestion:\n${question}`
          : `You are StudyBuddy, a smart, fast academic tutor. Answer the student's question clearly and concisely using accurate general/internet knowledge (and their notes if relevant).\n\nOptional Notes Context:\n${context || "None"}\n\nQuestion:\n${question}`;

        const geminiRes = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              thinkingConfig: { thinkingLevel: "low" },
              maxOutputTokens: 800
            }
          })
        });

        const data = await geminiRes.json();
        return new Response(JSON.stringify(data), {
          status: geminiRes.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // Mode 2: Flashcards & Summary Generator (2/day, 10MB max)
      const text = (body.text || "").trim();
      if (text.length < 30) {
        return new Response(JSON.stringify({ error: { message: "Text is too short to summarize." } }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const promptText = text.slice(0, 22000);
      const geminiRes = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `Summarize the following study material into 4 to 6 key bullet points, and create 8 to 12 multiple-choice flashcards. Return ONLY valid JSON matching this exact structure: {"summary":["point 1","point 2"],"cards":[{"q":"question","a":"exact correct answer","choices":["choice 1","choice 2","choice 3","choice 4"]}]}. Make sure "a" is included inside "choices".\n\nStudy Material:\n${promptText}`
            }]
          }],
          generationConfig: {
            thinkingConfig: { thinkingLevel: "low" },
            responseMimeType: "application/json",
            maxOutputTokens: 2500
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
