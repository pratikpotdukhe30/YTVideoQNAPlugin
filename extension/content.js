// Ask This Video: chat panel on YouTube watch pages.
// Flow: transcript -> chunks -> embeddings (cached per video) -> retrieve top chunks -> streamed answer.

(() => {
  const ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.8 7L4 20.5l1.5-4.9A8 8 0 1 1 21 12z"/><path d="M10.5 9.2v5.6L15 12z" fill="currentColor" stroke="none"/></svg>`;
  const CLOSE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
  const SEND = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;

  const CACHE_LIMIT = 15;   // videos kept in local storage
  const TOP_K = 5;
  const EMBED_BATCH = 100;

  const SUGGESTIONS = [
    "Summarize this video",
    "What are the key takeaways?",
    "Which tools, books or resources are mentioned?",
  ];

  // ---------- state ----------
  const state = {
    videoId: null,
    title: "",
    index: null,        // { chunks, vectors }
    preparing: null,    // Promise while indexing
    status: "idle",     // idle | loading | ready | error
    error: "",
    busy: false,
    conversations: new Map(), // videoId -> [{ role, content }]
  };

  const currentVideoId = () =>
    location.pathname === "/watch" ? new URLSearchParams(location.search).get("v") : null;

  // ---------- API helpers ----------
  function api(path, body) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "api", path, body }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error("Extension was updated. Reload this page."));
        if (!res?.ok) return reject(new Error(res?.data?.error || "Server error"));
        resolve(res.data);
      });
    });
  }

  async function embed(texts) {
    const out = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const { vectors } = await api("/api/embed", { texts: texts.slice(i, i + EMBED_BATCH) });
      out.push(...vectors);
    }
    return out;
  }

  // ---------- cache (chrome.storage.local, least-recently-used) ----------
  async function cacheGet(id) {
    try {
      const key = `v:${id}`;
      const got = await chrome.storage.local.get(key);
      return got[key] || null;
    } catch { return null; }
  }

  async function cacheSet(id, value) {
    try {
      const { order = [] } = await chrome.storage.local.get("order");
      const next = [id, ...order.filter((x) => x !== id)];
      const evict = next.slice(CACHE_LIMIT).map((x) => `v:${x}`);
      if (evict.length) await chrome.storage.local.remove(evict);
      const round = (v) => v.map((x) => Math.round(x * 1e5) / 1e5);
      await chrome.storage.local.set({ order: next.slice(0, CACHE_LIMIT), [`v:${id}`]: { ...value, vectors: value.vectors.map(round) } });
    } catch { /* storage full or unavailable: the in-memory index still works */ }
  }

  // ---------- indexing ----------
  function prepare() {
    const id = state.videoId;
    if (!id) return Promise.reject(new Error("No video"));
    if (state.index) return Promise.resolve(state.index);
    if (state.preparing) return state.preparing;

    state.preparing = (async () => {
      setStatus("loading", "Reading the transcript…");
      const cached = await cacheGet(id);
      if (cached) {
        if (state.videoId !== id) throw new Error("stale");
        state.title = cached.title || state.title;
        return cached;
      }
      const { title, segments } = await self.YTTranscript.get(id);
      if (!segments) throw new Error("This video has no transcript or captions available, so it can't be searched.");
      state.title = title;
      const chunks = self.YTRag.chunk(segments);
      setStatus("loading", `Indexing ${chunks.length} sections…`);
      const vectors = await embed(chunks.map((c) => c.text));
      const index = { title, chunks, vectors };
      cacheSet(id, index);
      return index;
    })()
      .then((index) => {
        if (state.videoId !== id) return index;
        state.index = index;
        setStatus("ready");
        return index;
      })
      .catch((e) => {
        if (state.videoId === id && e.message !== "stale") setStatus("error", e.message);
        throw e;
      })
      .finally(() => { if (state.videoId === id) state.preparing = null; });

    return state.preparing;
  }

  // ---------- asking ----------
  async function ask(question) {
    question = question.trim();
    if (!question || state.busy) return;
    const id = state.videoId;
    const convo = state.conversations.get(id) || [];
    state.conversations.set(id, convo);
    convo.push({ role: "user", content: question });
    state.busy = true;
    render();

    const reply = { role: "assistant", content: "", pending: true };
    convo.push(reply);
    render();

    try {
      const index = await prepare();
      const [qVec] = await embed([question]);
      const context = self.YTRag.topK(qVec, index.chunks, index.vectors, TOP_K);
      const history = convo.slice(0, -2).filter((m) => !m.error).map(({ role, content }) => ({ role, content }));

      await new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: "ask" });
        port.onMessage.addListener((m) => {
          if (m.delta) { reply.content += m.delta; reply.pending = false; renderLast(reply); }
          if (m.error) { reply.content = m.error; reply.error = true; port.disconnect(); resolve(); }
          if (m.done) { port.disconnect(); resolve(); }
        });
        port.onDisconnect.addListener(resolve);
        port.postMessage({ question, context, history, title: index.title || state.title });
      });
      if (!reply.content) { reply.content = "Sorry, I couldn't answer that."; reply.error = true; }
    } catch (e) {
      reply.content = e.message === "stale" ? "" : e.message;
      reply.error = true;
    } finally {
      reply.pending = false;
      state.busy = false;
      render();
    }
  }

  // ---------- UI ----------
  const host = document.createElement("div");
  host.id = "ask-this-video";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>${STYLES()}</style>
    <button class="launcher" part="launcher" aria-label="Ask this video">
      ${ICON}<span>Ask this video</span>
    </button>
    <section class="panel" role="dialog" aria-label="Ask this video" hidden>
      <header>
        <div class="brand">${ICON}<div><strong>Ask this video</strong><small class="vtitle"></small></div></div>
        <button class="close" aria-label="Close">${CLOSE}</button>
      </header>
      <div class="status" hidden></div>
      <div class="messages" aria-live="polite"></div>
      <div class="suggest"></div>
      <form class="composer">
        <textarea rows="1" placeholder="Ask anything about this video…" aria-label="Your question"></textarea>
        <button type="submit" aria-label="Send">${SEND}</button>
      </form>
      <footer>Answers come from the video's transcript and can contain mistakes.</footer>
    </section>`;

  const $ = (s) => root.querySelector(s);
  const launcher = $(".launcher"), panel = $(".panel"), messages = $(".messages"), suggest = $(".suggest");
  const statusEl = $(".status"), form = $(".composer"), input = $("textarea"), vtitle = $(".vtitle");

  function setStatus(s, text = "") {
    state.status = s;
    state.error = s === "error" ? text : "";
    statusEl.hidden = !(s === "loading" || s === "error");
    statusEl.className = `status ${s}`;
    statusEl.innerHTML = s === "loading" ? `<span class="spinner"></span>${escapeHtml(text)}` : escapeHtml(text);
    vtitle.textContent = state.title;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const TIME = /(?:\d{1,2}:)?\d{1,2}:\d{2}/g;
  function toSeconds(t) { return t.split(":").map(Number).reduce((a, n) => a * 60 + n, 0); }

  // Light formatting: paragraphs, bullet lists, **bold**, and clickable [mm:ss] timestamps.
  function format(text) {
    const lines = escapeHtml(text).split("\n");
    let html = "", inList = false;
    for (const raw of lines) {
      let line = raw.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      line = line.replace(/\[((?:[^\]]*?)\d{1,2}:\d{2}(?:[^\]]*?))\]/g, (_m, inner) =>
        inner.replace(TIME, (t) => `<button class="ts" data-t="${toSeconds(t)}">${t}</button>`));
      const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
      if (bullet) {
        if (!inList) { html += "<ul>"; inList = true; }
        html += `<li>${bullet[1]}</li>`;
      } else {
        if (inList) { html += "</ul>"; inList = false; }
        if (line.trim()) html += `<p>${line}</p>`;
      }
    }
    return html + (inList ? "</ul>" : "");
  }

  function bubble(m) {
    const cls = `msg ${m.role}${m.error ? " error" : ""}`;
    if (m.pending) return `<div class="${cls}"><span class="dots"><i></i><i></i><i></i></span></div>`;
    return `<div class="${cls}">${m.role === "user" ? `<p>${escapeHtml(m.content)}</p>` : format(m.content)}</div>`;
  }

  function render() {
    const convo = state.conversations.get(state.videoId) || [];
    messages.innerHTML = convo.length
      ? convo.map(bubble).join("")
      : `<div class="empty"><p>Ask a question and get an answer from what's actually said in this video, with timestamps you can click to jump there.</p></div>`;
    suggest.hidden = convo.length > 0;
    suggest.innerHTML = SUGGESTIONS.map((s) => `<button type="button">${escapeHtml(s)}</button>`).join("");
    input.disabled = state.busy;
    form.querySelector("button").disabled = state.busy;
    messages.scrollTop = messages.scrollHeight;
    vtitle.textContent = state.title;
  }

  function renderLast(m) {
    const last = messages.lastElementChild;
    if (!last) return render();
    last.outerHTML = bubble(m);
    messages.scrollTop = messages.scrollHeight;
  }

  function open() {
    panel.hidden = false;
    launcher.hidden = true;
    render();
    prepare().catch(() => {});
    setTimeout(() => input.focus(), 50);
  }
  function close() { panel.hidden = true; launcher.hidden = !state.videoId; }

  launcher.addEventListener("click", open);
  $(".close").addEventListener("click", close);
  panel.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); e.stopPropagation(); });
  panel.addEventListener("keyup", (e) => e.stopPropagation());     // keep YouTube shortcuts (k, f, m…) from firing while typing
  panel.addEventListener("keypress", (e) => e.stopPropagation());
  suggest.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) ask(b.textContent); });
  messages.addEventListener("click", (e) => {
    const b = e.target.closest(".ts");
    if (!b) return;
    const video = document.querySelector("video");
    if (video) { video.currentTime = Number(b.dataset.t); video.play().catch(() => {}); }
  });
  form.addEventListener("submit", (e) => { e.preventDefault(); const q = input.value; input.value = ""; autosize(); ask(q); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  const autosize = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 120) + "px"; };
  input.addEventListener("input", autosize);

  // ---------- page lifecycle (YouTube is a single-page app) ----------
  function syncTheme() { host.classList.toggle("dark", document.documentElement.hasAttribute("dark")); }

  function onNavigate() {
    const id = currentVideoId();
    syncTheme();
    if (id === state.videoId) return;
    state.videoId = id;
    state.index = null;
    state.preparing = null;
    state.busy = false;
    state.title = id ? document.title.replace(/^\(\d+\)\s*/, "").replace(/ - YouTube$/, "") : "";
    setStatus("idle");
    launcher.hidden = !id || !panel.hidden;
    if (!id) panel.hidden = true;
    if (!panel.hidden) { render(); prepare().catch(() => {}); }
  }

  document.documentElement.appendChild(host);
  document.addEventListener("yt-navigate-finish", onNavigate);
  new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["dark"] });
  onNavigate();

  // ---------- assets ----------
  function STYLES() {
    return `
    :host { all: initial; --bg:#ffffff; --surface:#f2f2f2; --ink:#0f0f0f; --muted:#606060; --line:#e5e5e5; --accent:#0f7b6c; --accent-ink:#ffffff; --user:#0f0f0f; --user-ink:#ffffff; --err:#b3261e;
      font-family: Roboto, "YouTube Sans", Arial, sans-serif; color: var(--ink); }
    :host(.dark) { --bg:#212121; --surface:#2f2f2f; --ink:#f1f1f1; --muted:#aaaaaa; --line:#3a3a3a; --accent:#3ec7b0; --accent-ink:#0f0f0f; --user:#f1f1f1; --user-ink:#0f0f0f; --err:#f2b8b5; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    button { font: inherit; cursor: pointer; }
    svg { flex: none; }
    .launcher { position: fixed; right: 24px; bottom: 24px; z-index: 2147483000; display: flex; align-items: center; gap: 8px;
      padding: 12px 18px 12px 14px; border: 0; border-radius: 999px; background: var(--accent); color: var(--accent-ink);
      font-size: 14px; font-weight: 500; box-shadow: 0 8px 24px rgba(0,0,0,.25); transition: transform .15s; }
    .launcher:hover { transform: translateY(-2px); }
    .panel { position: fixed; right: 24px; bottom: 24px; z-index: 2147483000; width: min(400px, calc(100vw - 32px));
      height: min(620px, calc(100vh - 100px)); display: flex; flex-direction: column; background: var(--bg); color: var(--ink);
      border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 16px 48px rgba(0,0,0,.3); overflow: hidden; font-size: 14px; line-height: 1.5; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 14px 14px 12px 16px; border-bottom: 1px solid var(--line); }
    .brand { display: flex; align-items: center; gap: 10px; min-width: 0; color: var(--accent); }
    .brand div { display: grid; min-width: 0; color: var(--ink); }
    .brand strong { font-size: 15px; font-weight: 600; }
    .vtitle { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .close { width: 32px; height: 32px; display: grid; place-items: center; border: 0; border-radius: 50%; background: transparent; color: var(--muted); }
    .close:hover { background: var(--surface); color: var(--ink); }
    .status { display: flex; align-items: center; gap: 8px; padding: 8px 16px; font-size: 12.5px; color: var(--muted); background: var(--surface); }
    .status.error { color: var(--err); }
    .spinner { width: 12px; height: 12px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
    .empty { color: var(--muted); font-size: 13.5px; margin: auto 0; text-align: center; padding: 0 12px; }
    .msg { max-width: 90%; padding: 10px 13px; border-radius: 14px; overflow-wrap: anywhere; }
    .msg p { margin: 0 0 6px; } .msg p:last-child { margin: 0; }
    .msg ul { margin: 4px 0; padding-left: 18px; } .msg li { margin: 3px 0; }
    .msg.assistant { align-self: flex-start; background: var(--surface); border-bottom-left-radius: 4px; }
    .msg.user { align-self: flex-end; background: var(--user); color: var(--user-ink); border-bottom-right-radius: 4px; }
    .msg.error { color: var(--err); }
    .ts { display: inline; padding: 0 5px; margin: 0 1px; border: 0; border-radius: 4px; background: color-mix(in srgb, var(--accent) 16%, transparent);
      color: var(--accent); font-weight: 600; font-size: 12.5px; font-variant-numeric: tabular-nums; }
    .ts:hover { background: var(--accent); color: var(--accent-ink); }
    .dots { display: inline-flex; gap: 4px; padding: 4px 0; } .dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); animation: blink 1.2s infinite; }
    .dots i:nth-child(2) { animation-delay: .2s; } .dots i:nth-child(3) { animation-delay: .4s; }
    @keyframes blink { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }
    .suggest { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 16px 12px; }
    .suggest button { padding: 6px 11px; border: 1px solid var(--line); border-radius: 999px; background: transparent; color: var(--ink); font-size: 12.5px; text-align: left; }
    .suggest button:hover { border-color: var(--accent); color: var(--accent); }
    .composer { display: flex; align-items: flex-end; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line); }
    textarea { flex: 1; min-width: 0; resize: none; max-height: 120px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface);
      color: var(--ink); font: inherit; font-size: 14px; outline: none; }
    textarea:focus { border-color: var(--accent); }
    .composer button { width: 40px; height: 40px; display: grid; place-items: center; border: 0; border-radius: 12px; background: var(--accent); color: var(--accent-ink); }
    .composer button:disabled, textarea:disabled { opacity: .5; cursor: default; }
    footer { padding: 0 16px 10px; font-size: 11px; color: var(--muted); }
    button:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { .launcher, .spinner, .dots i { transition: none; animation: none; } }
    `;
  }
})();
