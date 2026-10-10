// POST /api/feedback  { rating: "up" | "down", question, answer, videoId, title }
// Writes one line to the Vercel logs (Project → Logs, search "FEEDBACK"). Nothing else is stored.
import { cors, rateLimited, parseBody } from "./_shared.js";

export default async function handler(req: any, res: any) {
  if (!cors(req, res)) return;
  if (rateLimited(req, 30)) return res.status(429).json({ error: "Too many requests" });
  const b = parseBody(req);
  const rating = b.rating === "up" ? "up" : b.rating === "down" ? "down" : null;
  if (!rating) return res.status(400).json({ error: "Invalid rating" });
  console.log("FEEDBACK " + JSON.stringify({
    rating,
    videoId: String(b.videoId || "").slice(0, 20),
    title: String(b.title || "").slice(0, 150),
    question: String(b.question || "").slice(0, 500),
    answer: String(b.answer || "").slice(0, 1500),
    at: new Date().toISOString(),
  }));
  return res.status(200).json({ ok: true });
}
