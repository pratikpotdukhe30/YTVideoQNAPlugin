// Transcript extraction. YouTube changes its internals often, so three methods are tried in order:
//   1. Caption track file (fast, works for most videos)
//   2. YouTube's own transcript endpoint (the one behind "Show transcript")
//   3. Opening the transcript panel on the page and reading it
// Each returns segments: [{ start: seconds, text }].

self.YTTranscript = (() => {
  let reqId = 0;

  // Ask page.js (running in the page's world) for player data.
  function getPlayer() {
    return new Promise((resolve) => {
      const id = ++reqId;
      const onMsg = (e) => {
        if (e.source !== window || e.data?.source !== "ytchat" || e.data?.type !== "player" || e.data.id !== id) return;
        window.removeEventListener("message", onMsg);
        resolve(e.data);
      };
      window.addEventListener("message", onMsg);
      window.postMessage({ source: "ytchat", type: "getPlayer", id }, "*");
      setTimeout(() => { window.removeEventListener("message", onMsg); resolve(null); }, 3000);
    });
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
    const text = await r.text();
    if (!text) return null;
    const json = JSON.parse(text);
    const segs = (json.events || [])
      .filter((ev) => ev.segs)
      .map((ev) => ({ start: (ev.tStartMs || 0) / 1000, text: clean(ev.segs.map((s) => s.utf8 || "").join("")) }))
      .filter((s) => s.text);
    return segs.length ? segs : null;
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
      () => fromCaptionTrack(player),
      () => fromTranscriptEndpoint(videoId, player),
      () => fromTranscriptPanel(),
    ];
    for (const m of methods) {
      try {
        const segs = await m();
        if (segs?.length) return { title, segments: segs };
      } catch { /* try the next method */ }
    }
    return { title, segments: null };
  }

  return { get };
})();
