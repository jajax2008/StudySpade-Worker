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

      // Mode 1: StudyBuddy Chat / Ask AI (20/day)
      if (body.mode === "chat") {
        const question = (body.question || "").slice(0, 2000);
        const context = (body.context || "").slice(0, 25000);
        if (!question) {
          return new Response(JSON.stringify({ error: { message: "Please enter a question." } }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{
                parts: [{
                  text: `You are StudyBuddy, a concise, helpful study tutor. Answer the student's request clearly. Use the provided study notes if relevant, or your own knowledge if not covered in the notes.\n\nStudent's Notes Context:\n${context || "No notes provided."}\n\nStudent's Question:\n${question}`
                }]
              }]
            })
          }
        );

        const data = await geminiRes.json();
        return new Response(JSON.stringify(data), {
          status: geminiRes.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // Mode 2: Flashcards & Multiple Choice Generator (2/day)
      const text = body.text || "";
      if (text.length < 50) {
        return new Response(JSON.stringify({ error: { message: "Text is too short." } }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const promptText = text.slice(0, 30000);
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: `Summarize the following study material into 4 to 6 key bullet points, and create 8 to 15 multiple-choice flashcards. Each flashcard must have a clear question ("q"), the exact correct answer ("a"), and an array of 4 distinct choices ("choices") that includes the exact string in "a".\n\nStudy Material:\n${promptText}`
              }]
            }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: {
                type: "OBJECT",
                properties: {
                  summary: { type: "ARRAY", items: { type: "STRING" } },
                  cards: {
                    type: "ARRAY",
                    items: {
                      type: "OBJECT",
                      properties: {
                        q: { type: "STRING" },
                        a: { type: "STRING" },
                        choices: { type: "ARRAY", items: { type: "STRING" } }
                      },
                      required: ["q", "a", "choices"]
                    }
                  }
                },
                required: ["summary", "cards"]
              }
            }
          })
        }
      );

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
