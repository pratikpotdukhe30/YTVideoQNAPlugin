// Transcript extraction. YouTube changes its internals often, so four methods are tried in order:
//   0. The caption request the YouTube player itself made (carries YouTube's security token)
//   1. Caption track file
//   2. YouTube's own transcript endpoint (the one behind "Show transcript")
//   3. Opening the transcript panel on the page and reading it
// Each returns segments: [{ start: seconds, text }].

self.YTTranscript = (() => {
  let reqId = 0;

  // Ask page.js (running in the page's world) for something and wait for its reply.
  function askPage(type, replyType, extra = {}, timeout = 3000) {
    return new Promise((resolve) => {
      const id = ++reqId;
      const onMsg = (e) => {
        if (e.source !== window || e.data?.source !== "ytchat" || e.data?.type !== replyType || e.data.id !== id) return;
        window.removeEventListener("message", onMsg);
        resolve(e.data);
      };
      window.addEventListener("message", onMsg);
      window.postMessage({ source: "ytchat", type, id, ...extra }, "*");
      setTimeout(() => { window.removeEventListener("message", onMsg); resolve(null); }, timeout);
    });
  }
  const getPlayer = () => askPage("getPlayer", "player");

  const log = (...a) => console.debug("[Ask This Video]", ...a);

  // Parses any caption format YouTube serves: json3, srv3 (<p t= d=>) or classic XML (<text start=>).
  function parseCaptions(body) {
    body = body.trim();
    if (!body) return null;
    if (body.startsWith("{")) {
      const json = JSON.parse(body);
      return (json.events || [])
        .filter((ev) => ev.segs)
        .map((ev) => ({ start: (ev.tStartMs || 0) / 1000, text: clean(ev.segs.map((s) => s.utf8 || "").join("")) }))
        .filter((s) => s.text);
    }
    const doc = new DOMParser().parseFromString(body, "text/xml");
    const decode = (t) => { const d = document.createElement("textarea"); d.innerHTML = t; return d.value; };
    const ps = [...doc.querySelectorAll("p")];
    if (ps.length) return ps.map((p) => ({ start: Number(p.getAttribute("t") || 0) / 1000, text: clean(decode(p.textContent || "")) })).filter((s) => s.text);
    return [...doc.querySelectorAll("text")]
      .map((t) => ({ start: Number(t.getAttribute("start") || 0), text: clean(decode(t.textContent || "")) }))
      .filter((s) => s.text);
  }

  // Method 0: reuse the caption request the YouTube player itself made (includes YouTube's security token).
  async function fromPlayerRequest(videoId) {
    const res = await askPage("getCaptionUrl", "captionUrl", { videoId }, 8000);
    if (!res?.url) { log("player caption URL not found"); return null; }
    const url = new URL(res.url);
    url.searchParams.set("fmt", "json3");
    const r = await fetch(url.toString(), { credentials: "include" });
    if (!r.ok) { log("player caption request failed", r.status); return null; }
    const segs = parseCaptions(await r.text());
    return segs?.length ? segs : null;
  }

  const clean = (t) => t.replace(/\s+/g, " ").replace(/\[(music|applause|laughter)\]/gi, "").trim();

  function pickTrack(tracks) {
    const pref = (navigator.language || "en").slice(0, 2);
    const manual = tracks.filter((t) => t.kind !== "asr");
    return (
      manual.find((t) => t.lang?.startsWith(pref)) ||
      manual.find((t) => t.lang?.startsWith("en")) ||
      tracks.find((t) => t.lang?.startsWith(pref)) ||
      tracks.find((t) => t.lang?.startsWith("en")) ||
      manual[0] || tracks[0]
    );
  }

  // Method 1: caption track in JSON format.
  async function fromCaptionTrack(player) {
    const track = player?.tracks?.length ? pickTrack(player.tracks) : null;
    if (!track?.baseUrl) return null;
    const r = await fetch(`${track.baseUrl}&fmt=json3`, { credentials: "include" });
    if (!r.ok) return null;
    const segs = parseCaptions(await r.text());
    return segs?.length ? segs : null;
  }

  // Method 2: the innertube get_transcript endpoint.
  async function fromTranscriptEndpoint(videoId, player) {
    const it = player?.innertube;
    if (!it?.key || !it?.context) return null;
    const html = await (await fetch(`/watch?v=${encodeURIComponent(videoId)}`, { credentials: "include" })).text();
    const m = html.match(/"getTranscriptEndpoint":\{"params":"([^"]+)"/);
    if (!m) return null;
    const r = await fetch(`/youtubei/v1/get_transcript?key=${it.key}&prettyPrint=false`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: it.context, params: m[1] }),
    });
    if (!r.ok) return null;
    const out = [];
    (function walk(node) {
      if (!node || typeof node !== "object") return;
      if (node.transcriptSegmentRenderer) {
        const s = node.transcriptSegmentRenderer;
        const text = clean((s.snippet?.runs || []).map((x) => x.text).join(""));
        if (text) out.push({ start: Number(s.startMs || 0) / 1000, text });
        return;
      }
      for (const v of Object.values(node)) walk(v);
    })(await r.json());
    return out.length ? out : null;
  }

  // Method 3: open the transcript panel and read it from the page.
  async function fromTranscriptPanel() {
    const read = () =>
      [...document.querySelectorAll("ytd-transcript-segment-renderer")]
        .map((el) => {
          const t = el.querySelector(".segment-timestamp")?.textContent?.trim() || "0:00";
          const text = clean(el.querySelector(".segment-text")?.textContent || "");
          const start = t.split(":").map(Number).reduce((acc, n) => acc * 60 + n, 0);
          return { start, text };
        })
        .filter((s) => s.text);

    let segs = read();
    if (segs.length) return segs;
    const btn = document.querySelector("ytd-video-description-transcript-section-renderer button");
    if (!btn) return null;
    btn.click();
    for (let i = 0; i < 20 && !segs.length; i++) {
      await new Promise((r) => setTimeout(r, 300));
      segs = read();
    }
    // Close the panel again so the page looks the way the viewer left it.
    document.querySelector('ytd-engagement-panel-section-list-renderer[target-id*="transcript"] #visibility-button button')?.click();
    return segs.length ? segs : null;
  }

  async function get(videoId) {
    const player = await getPlayer();
    const title = player?.title || document.title.replace(/ - YouTube$/, "");
    const methods = [
      () => fromPlayerRequest(videoId),
      () => fromCaptionTrack(player),
      () => fromTranscriptEndpoint(videoId, player),
      () => fromTranscriptPanel(),
    ];
    for (const m of methods) {
      try {
        const segs = await m();
        if (segs?.length) { log(`transcript via method ${methods.indexOf(m)}: ${segs.length} segments`); return { title, segments: segs }; }
        log(`method ${methods.indexOf(m)} found nothing`);
      } catch (err) { log(`method ${methods.indexOf(m)} failed`, err); }
    }
    return { title, segments: null };
  }

  return { get };
})();