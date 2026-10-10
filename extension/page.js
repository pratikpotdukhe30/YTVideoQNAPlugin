// Runs in the page's own JavaScript world, where YouTube's player object is reachable.
// It answers requests from the content script with the current video's details and caption tracks.
(() => {
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.source !== "ytchat" || e.data?.type !== "getPlayer") return;
    let player = null;
    try { player = document.getElementById("movie_player")?.getPlayerResponse?.() || null; } catch { /* ignore */ }
    if (!player) player = window.ytInitialPlayerResponse || null;
    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    let innertube = null;
    try {
      innertube = { key: window.ytcfg?.get?.("INNERTUBE_API_KEY"), context: window.ytcfg?.get?.("INNERTUBE_CONTEXT") };
    } catch { /* ignore */ }
    window.postMessage({
      source: "ytchat",
      type: "player",
      id: e.data.id,
      videoId: player?.videoDetails?.videoId || null,
      title: player?.videoDetails?.title || document.title.replace(/ - YouTube$/, ""),
      tracks: tracks.map((t) => ({ baseUrl: t.baseUrl, lang: t.languageCode, kind: t.kind || "", name: t.name?.simpleText || "" })),
      innertube,
    }, "*");
  });
})();
