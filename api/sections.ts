// POST /api/sections  { chunks: [{start, text}], title, installId }  ->  { sections: [{ start, title, summary }] }
// Map step of the summary pipeline: the video is split into consecutive time-based sections and each
// one is summarized in parallel. The extension uses the result for "Key moments" and as context
// for summary-type questions, so the whole video is covered, not just the top few chunks.
import { cors, rateLimited, parseBody, overDailyLimit, complete } from "./_shared.js";

const MAX_CHUNKS = 600;
const MAX_SECTIONS = 12;
const CONCURRENCY = 6;

const INSTRUCTIONS = `You summarize one section of a YouTube video transcript.
Return exactly two lines and nothing else:
TITLE: a short, specific title for this section (max 8 words)
SUMMARY: one or two sentences on what is said in this section
Write in the same language as the transcript.`;

// Removes the ~200-character overlap between consecutive chunks so each section reads cleanly.
function joinChunks(chunks: { text: string }[]): string {
  let out = "";
  for (const c of chunks) {
    if (!out) { out = c.text; continue; }
    const probe = c.text.slice(0, 120);
    const at = out.lastIndexOf(probe.slice(0, 60));
    out += " " + (at >= 0 && out.length - at < 400 ? c.text.slice(out.length - at) : c.text);
  }
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

export default async function handler(req: any, res: any) {
  if (!cors(req, res)) return;
  if (rateLimited(req, 10)) return res.status(429).json({ error: "Too many requests. Wait a minute and try again." });

  const body = parseBody(req);
  const limitMsg = await overDailyLimit(req, body.installId);
  if (limitMsg) return res.status(429).json({ error: limitMsg });

  const chunks = (Array.isArray(body.chunks) ? body.chunks : [])
    .slice(0, MAX_CHUNKS)
    .map((c: any) => ({ start: Number(c.start) || 0, text: String(c.text || "").slice(0, 1500) }));
  if (!chunks.length) return res.status(400).json({ error: "No transcript" });

  // Aim for sections of roughly 5 minutes, between 3 and 12 of them.
  const duration = chunks[chunks.length - 1].start || 0;
  const count = Math.max(1, Math.min(MAX_SECTIONS, chunks.length, Math.max(3, Math.round(duration / 300))));
  const size = Math.ceil(chunks.length / count);
  const groups = Array.from({ length: Math.ceil(chunks.length / size) }, (_, i) => chunks.slice(i * size, (i + 1) * size));

  try {
    const sections = await mapLimit(groups, CONCURRENCY, async (group) => {
      const text = await complete(INSTRUCTIONS, `Video: ${String(body.title || "").slice(0, 200)}\n\nTranscript section:\n${joinChunks(group)}`, 200);
      const title = (text.match(/TITLE:\s*(.+)/i)?.[1] || "").trim();
      const summary = (text.match(/SUMMARY:\s*([\s\S]+)/i)?.[1] || text).trim();
      return { start: group[0].start, title: title || summary.split(/[.!?]/)[0].slice(0, 60), summary };
    });
    return res.status(200).json({ sections });
  } catch (e) {
    return res.status(502).json({ error: (e as Error).message });
  }
}
