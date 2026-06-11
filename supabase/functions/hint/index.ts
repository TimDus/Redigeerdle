// @ts-nocheck — runs on Deno (Supabase Edge runtime), not the workspace TS server.
// The `Deno` global is provided at runtime; VS Code's default (Node) TS checker
// doesn't know it, so we skip type-checking here. See the Deno-extension note below
// for full IntelliSense instead.
// Supabase Edge Function: "hint"
// Generates a vague, spoiler-free hint for a Redigeerdle puzzle via Groq,
// keeping the Groq API key server-side (never in the browser).
//
// Deploy:  supabase functions deploy hint --no-verify-jwt
//          supabase secrets set GROQ_API_KEY=gsk_...   (and optionally GROQ_MODEL)
// Or via the Supabase dashboard → Edge Functions (paste this file, add the secret,
// turn "Verify JWT" off). See SUPABASE_SETUP.md.
//
// Request  (POST):  { "title": "<answer title>", "text": "<article excerpt>" }
// Response (JSON):  { "summary": "<hint or empty string>" }

const GROQ_MODEL = Deno.env.get("GROQ_MODEL") || "llama-3.3-70b-versatile";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (obj: unknown) =>
  new Response(JSON.stringify(obj), { headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const key = Deno.env.get("GROQ_API_KEY");
    if (!key) return json({ summary: "" });

    const { title, text } = await req.json().catch(() => ({}));
    if (!title || !text) return json({ summary: "" });

    const sys = "You write a single vague, spoiler-free hint for a word-guessing game where the player "
      + "must guess the article title. The player must NOT be able to read the answer from your hint. "
      + "Rules: exactly one sentence, max 18 words; describe the subject only in general terms; "
      + "NEVER write the title or any of its words, names, or close variants; avoid proper nouns; "
      + "evocative but not identifying. Output ONLY the hint sentence, nothing else.";
    const user = `Title (the answer — never mention it or its words): "${title}"\n\n`
      + `Article excerpt:\n${String(text).slice(0, 1500)}\n\nWrite the vague hint.`;

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: "system", content: sys }, { role: "user", content: user }],
        max_tokens: 60, temperature: 0.7,
      }),
    });
    if (!r.ok) return json({ summary: "" });

    const j = await r.json();
    let hint = (j.choices?.[0]?.message?.content || "").trim().replace(/^["']+|["']+$/g, "").trim();
    // leak filter: drop the hint if it contains any significant word from the title
    const titleWords = String(title).toLowerCase().match(/[a-z]{3,}/g) || [];
    const low = hint.toLowerCase();
    if (titleWords.some((w: string) => low.includes(w))) hint = "";
    if (hint.length < 8 || hint.length > 200) hint = "";
    return json({ summary: hint });
  } catch {
    return json({ summary: "" });
  }
});
