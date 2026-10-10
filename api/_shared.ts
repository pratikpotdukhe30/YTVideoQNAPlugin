// Shared helpers for the API routes. Files starting with "_" are not exposed as routes by Vercel.

export const OPENAI = "https://api.openai.com/v1";
export const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small";
export const EMBED_DIMS = 512; // smaller vectors are cheaper to send and store, with little quality loss
export const CHAT_MODEL = process.env.OPENAI_MODEL || "gpt-6-luna";

// Only the extension (and local testing) may call the API.
export function cors(req: any, res: any): boolean {
  const origin = String(req.headers?.origin || "");
  const allowed = origin.startsWith("chrome-extension://") || origin.startsWith("http://localhost");
  if (allowed) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return false; }
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return false; }
  if (!allowed) { res.status(403).json({ error: "Not allowed" }); return false; }
  return true;
}

// Very small per-instance rate limit. Serverless instances are short-lived, so this only slows down
// obvious spam. The real spending cap is your prepaid OpenAI balance.
const hits = new Map<string, number[]>();
export function rateLimited(req: any, limit = 40, windowMs = 60_000): boolean {
  const ip = String(req.headers?.["x-forwarded-for"] || "anon").split(",")[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > limit;
}

export function parseBody(req: any): any {
  return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
}

export function key(): string {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error("Server is missing OPENAI_API_KEY");
  return k;
}
