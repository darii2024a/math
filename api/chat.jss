// api/chat.js — серверная функция Vercel (Node). Ключ Gemini хранится только здесь, в переменной GEMINI_API_KEY.
// Формат запроса совпадает с index.html: { kind: 'tutor' | 'strategy', lang: 'kk' | 'ru', messages: [{role, content}], images: [{media_type, data}] }
// Ответ: { text }

const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const SB_URL = process.env.SUPABASE_URL || "https://imhucrpunnsomfzwhhdn.supabase.co";
const SB_KEY = process.env.SUPABASE_KEY || "sb_publishable_UTZJsizhKofQ2Dm_SiqVqQ_4GWylaIF"; // публичный ключ, он же в index.html

const RULES =
  "Output is shown as plain text: no markdown, no asterisks, no # headings, no tables. " +
  "Write math with plain characters (x², √, /, ≤). Be concrete and short. Never invent numbers that are not in the data.";

function system(kind, lang) {
  const language = lang === "ru" ? "Answer in Russian." : "Answer in Kazakh (қазақ тілінде).";
  if (kind === "strategy") {
    return (
      "You are a study strategist for a school student (grades 7-9, math, Kazakhstan). " +
      "The user message contains structured data: levels A and B, chapter scores, error types and a planned schedule. " +
      "Write a personal strategy in 5 short numbered parts: " +
      "1) diagnosis in 2 sentences; 2) top 3 priorities (chapter and why); " +
      "3) a concrete daily routine for the given minutes per day (warm-up, main work, check); " +
      "4) two habits that fix the most frequent error type; " +
      "5) checkpoints: what score to reach and when. " +
      "Do not repeat the schedule itself, explain how to work with it. Under 250 words. " +
      language + " " + RULES
    );
  }
  return (
    "You are a math tutor for a school student (grades 7-9, Kazakhstan). " +
    "The student sends a problem with their solution, a photo, or a list of mistakes from a test. " +
    "For each mistake (at most 6): find the exact step where the reasoning breaks; name the error type " +
    "(arithmetic, sign, formula use, or transformation); show the correct solution in short numbered steps; " +
    "say which chapter to review. At the end give one similar task for the student to try, without its answer. " +
    "If several mistakes share a pattern, name the pattern in two lines. Under 250 words unless asked for more. " +
    language + " " + RULES
  );
}

// простой лимит на пользователя (в памяти функции; сбрасывается при холодном старте)
const hits = new Map();
function limited(id) {
  const now = Date.now();
  const arr = (hits.get(id) || []).filter((t) => now - t < 3600000);
  arr.push(now);
  hits.set(id, arr);
  return arr.length > 30; // 30 запросов в час на пользователя
}

async function getUser(token) {
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_KEY, Authorization: "Bearer " + token } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch (e) {
    return null;
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY is not set" });

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const user = token ? await getUser(token) : null;
  if (!user) return res.status(401).json({ error: "auth" });
  if (limited(user.id)) return res.status(429).json({ error: "rate" });

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const kind = body.kind === "strategy" ? "strategy" : "tutor";
  const lang = body.lang === "ru" ? "ru" : "kk";

  let msgs = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-9)
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content.slice(0, 6000) }] }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift(); // Gemini ждёт, что диалог начинается с user
  if (!msgs.length) return res.status(400).json({ error: "empty" });

  const imgs = (Array.isArray(body.images) ? body.images : [])
    .filter((i) => i && typeof i.data === "string" && i.data.length < 1500000)
    .slice(0, 3);
  if (imgs.length) {
    const last = msgs[msgs.length - 1];
    if (last.role === "user") imgs.forEach((i) => last.parts.push({ inlineData: { mimeType: i.media_type || "image/jpeg", data: i.data } }));
  }

  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system(kind, lang) }] },
        contents: msgs,
        generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 429) return res.status(429).json({ error: "rate" });
    if (!r.ok) return res.status(502).json({ error: (data.error && data.error.message) || "gemini" });
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const text = parts.map((p) => p.text || "").join("").trim();
    if (!text) return res.status(502).json({ error: "empty answer" });
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(500).json({ error: "server" });
  }
};
