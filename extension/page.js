// Runs in the page's own JavaScript world, where YouTube's player object is reachable.
// Answers two requests from the content script:
//   getPlayer      -> current video's id, title, caption tracks, innertube config
//   getCaptionUrl  -> the exact caption URL the YouTube player itself used (it carries
//                     the security token YouTube now requires), turning captions on briefly if needed
(() => {
  // YouTube makes many requests; keep enough timing entries that the caption request isn't dropped.
  try { performance.setResourceTimingBufferSize(3000); } catch { /* ignore */ }
  // Record any caption request the player makes, whether via fetch or XHR.
  const seen = [];
  const note = (u) => { try { const s = String(u); if (s.includes("timedtext")) seen.push(new URL(s, location.href).href); } catch { /* ignore */ } };
  try {
    const origFetch = window.fetch;
    window.fetch = function (input, init) { note(typeof Request !== "undefined" && input instanceof Request ? input.url : input); return origFetch.call(this, input, init); };
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) { note(url); return origOpen.call(this, method, url, ...rest); };
  } catch { /* ignore */ }

  const reply = (data) => window.postMessage({ source: "ytchat", ...data }, "*");
  const player = () => document.getElementById("movie_player");

  function playerResponse() {
    let res = null;
    try { res = player()?.getPlayerResponse?.() || null; } catch { /* ignore */ }
    return res || window.ytInitialPlayerResponse || null;
  }

  function findCaptionUrl(videoId) {
    const entries = [...performance.getEntriesByType("resource").map((e) => e.name), ...seen];
    const urls = entries.filter((u) => u.includes("timedtext") && u.includes(`v=${videoId}`));
    return urls.length ? urls[urls.length - 1] : null;
  }

  async function getCaptionUrl(videoId) {
    let url = findCaptionUrl(videoId);
    if (url) return url;

    // Make the player (re)load captions so its request shows up, then restore the viewer's setting.
    const p = player();
    if (!p) return null;
    let current = null;
    try { current = p.getOption?.("captions", "track") || null; } catch { /* ignore */ }
    const wasOn = !!(current && Object.keys(current).length);
    let changed = false;
    try {
      if (wasOn) {
        p.setOption("captions", "track", current); // re-select the same track: no visible change
      } else if (typeof p.toggleSubtitlesOn === "function") {
        p.toggleSubtitlesOn(); changed = true;
      } else if (typeof p.toggleSubtitles === "function") {
        p.toggleSubtitles(); changed = true;
      }
    } catch { /* ignore */ }

    for (let i = 0; i < 25 && !url; i++) {
      await new Promise((r) => setTimeout(r, 200));
      url = findCaptionUrl(videoId);
    }

    if (changed) {
      try { p.toggleSubtitles?.(); } catch { /* ignore */ }
    }
    return url;
  }

  window.addEventListener("message", async (e) => {
    if (e.source !== window || e.data?.source !== "ytchat") return;
    const { type, id } = e.data;

    if (type === "getPlayer") {
      const res = playerResponse();
      const tracks = res?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      let innertube = null;
      try { innertube = { key: window.ytcfg?.get?.("INNERTUBE_API_KEY"), context: window.ytcfg?.get?.("INNERTUBE_CONTEXT") }; } catch { /* ignore */ }
      reply({
        type: "player",
        id,
        videoId: res?.videoDetails?.videoId || null,
        title: res?.videoDetails?.title || document.title.replace(/ - YouTube$/, ""),
        tracks: tracks.map((t) => ({ baseUrl: t.baseUrl, lang: t.languageCode, kind: t.kind || "", name: t.name?.simpleText || "" })),
        innertube,
      });
    }

    if (type === "getCaptionUrl") {
      const url = await getCaptionUrl(e.data.videoId).catch(() => null);
      reply({ type: "captionUrl", id, url });
    }
  });
})();