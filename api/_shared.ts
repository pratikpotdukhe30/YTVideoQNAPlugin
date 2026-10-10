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
  const ip = clientIp(req);
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

export function clientIp(req: any): string {
  return String(req.headers?.["x-forwarded-for"] || "anon").split(",")[0].trim();
}

// ---------- Daily usage limits ----------
// Stored in Upstash Redis (free tier; add it from Vercel → Storage / Marketplace). Without Redis
// configured, a per-instance in-memory counter is used, which only catches obvious spam.
export const DAILY_PER_USER = Number(process.env.DAILY_LIMIT_PER_USER || 40);
export const DAILY_PER_IP = Number(process.env.DAILY_LIMIT_PER_IP || 120);

const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const memoryCounts = new Map<string, number>();

async function incrementToday(keys: string[]): Promise<number[]> {
  const day = new Date().toISOString().slice(0, 10);
  const full = keys.map((k) => `usage:${day}:${k}`);
  if (redisUrl && redisToken) {
    const commands = full.flatMap((k) => [["INCR", k], ["EXPIRE", k, 90000]]);
    const r = await fetch(`${redisUrl}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${redisToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
    });
    if (r.ok) {
      const out = (await r.json()) as { result?: number }[];
      return full.map((_, i) => Number(out[i * 2]?.result || 0));
    }
    // If Redis is unreachable, fall through to memory rather than blocking everyone.
  }
  return full.map((k) => { const n = (memoryCounts.get(k) || 0) + 1; memoryCounts.set(k, n); return n; });
}

// Counts one use for this install and IP. Returns an error message if today's limit is exceeded.
export async function overDailyLimit(req: any, installId: unknown): Promise<string | null> {
  const id = typeof installId === "string" && /^[a-z0-9-]{8,64}$/i.test(installId) ? installId : "unknown";
  const [userCount, ipCount] = await incrementToday([`user:${id}`, `ip:${clientIp(req)}`]);
  if (userCount > DAILY_PER_USER || ipCount > DAILY_PER_IP) {
    return `You've reached today's limit of ${DAILY_PER_USER} questions. It resets at midnight (UTC).`;
  }
  return null;
}

// Minimal non-streaming call to the model, used for section summaries.
export async function complete(instructions: string, input: string, maxTokens = 300): Promise<string> {
  const r = await fetch(`${OPENAI}/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key()}` },
    body: JSON.stringify({ model: CHAT_MODEL, instructions, input, reasoning: { effort: "none" }, max_output_tokens: maxTokens }),
  });
  const data: any = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || "Model error");
  return ((data.output || [])
    .filter((o: any) => o.type === "message")
    .flatMap((o: any) => o.content || [])
    .filter((c: any) => c.type === "output_text")
    .map((c: any) => c.text)
    .join("") || data.output_text || "").trim();
}
