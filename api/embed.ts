// POST /api/embed  { texts: string[] }  ->  { vectors: number[][] }
// Used once per video for the transcript chunks, and once per question.
import { cors, rateLimited, parseBody, key, OPENAI, EMBED_MODEL, EMBED_DIMS } from "./_shared.js";

const MAX_TEXTS = 600;      // roughly a 6-hour video at 1000-character chunks
const MAX_CHARS = 1500;     // per chunk

export default async function handler(req: any, res: any) {
  if (!cors(req, res)) return;
  if (rateLimited(req)) return res.status(429).json({ error: "Too many requests. Wait a minute and try again." });

  const { texts } = parseBody(req);
  if (!Array.isArray(texts) || texts.length === 0) return res.status(400).json({ error: "No texts" });
  if (texts.length > MAX_TEXTS) return res.status(413).json({ error: "This video is too long for the assistant." });
  const input = texts.map((t: unknown) => String(t).slice(0, MAX_CHARS));

  try {
    const r = await fetch(`${OPENAI}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key()}` },
      body: JSON.stringify({ model: EMBED_MODEL, input, dimensions: EMBED_DIMS }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data?.error?.message || "Embedding failed" });
    const vectors = data.data.sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding);
    return res.status(200).json({ vectors });
  } catch (e) {
    return res.status(502).json({ error: (e as Error).message });
  }
}
