// POST /api/answer  { question, context: [{start, text}], history: [{role, content}], title }
//   -> streamed plain text (the answer, token by token)
// Retrieval happens in the extension; this route only builds the prompt and calls the model.
import { cors, rateLimited, parseBody, key, OPENAI, CHAT_MODEL } from "./_shared.js";

function ts(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0"), ss = String(r).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const INSTRUCTIONS = `You are a helpful assistant that answers questions about one YouTube video.
Answer ONLY from the transcript excerpts provided. If they don't contain the answer, say you couldn't find that in the video.
Each excerpt starts with its timestamp in square brackets, like [12:34]. When you use an excerpt, cite its timestamp in the same format so the viewer can jump there.
Keep answers concise: a short paragraph or a few bullet points. Reply in the language of the question.`;

export default async function handler(req: any, res: any) {
  if (!cors(req, res)) return;
  if (rateLimited(req, 20)) return res.status(429).json({ error: "Too many questions. Wait a minute and try again." });

  const body = parseBody(req);
  const question = String(body.question || "").slice(0, 600).trim();
  if (!question) return res.status(400).json({ error: "No question" });

  const context = (Array.isArray(body.context) ? body.context : [])
    .slice(0, 8)
    .map((c: any) => `[${ts(Number(c.start) || 0)}] ${String(c.text || "").slice(0, 1500)}`)
    .join("\n\n");
  const history = (Array.isArray(body.history) ? body.history : [])
    .slice(-6)
    .filter((m: any) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m: any) => ({ role: m.role, content: m.content.slice(0, 1200) }));
  const title = String(body.title || "").slice(0, 200);

  const input = [
    ...history,
    { role: "user", content: `Video: ${title}\n\nTranscript excerpts:\n${context}\n\nQuestion: ${question}` },
  ];

  try {
    const r = await fetch(`${OPENAI}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key()}` },
      body: JSON.stringify({
        model: CHAT_MODEL,
        instructions: INSTRUCTIONS,
        input,
        reasoning: { effort: "none" },
        max_output_tokens: 600,
        stream: true,
      }),
    });
    if (!r.ok || !r.body) {
      const data = await r.json().catch(() => ({}));
      return res.status(502).json({ error: data?.error?.message || "Model error" });
    }

    // Stream plain text to the extension as it arrives.
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let event: any;
        try { event = JSON.parse(payload); } catch { continue; }
        if (event.type === "response.output_text.delta" && event.delta) res.write(event.delta);
        else if (event.type === "error" || event.type === "response.failed") {
          res.write(`\n\n[Error: ${event.message || event.response?.error?.message || "the model failed"}]`);
        }
      }
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) return res.status(502).json({ error: (e as Error).message });
    res.end();
  }
}
