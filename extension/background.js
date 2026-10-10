// Service worker: makes all API calls for the content script.
// Requests from here carry the extension's origin, which the backend allows,
// and the content script never needs network permissions of its own.
importScripts("config.js");

// One-shot JSON requests (embeddings).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "api") return;
  fetch(`${self.YTCHAT_API}${msg.path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg.body),
  })
    .then(async (r) => {
      const data = await r.json().catch(() => ({}));
      sendResponse({ ok: r.ok, status: r.status, data });
    })
    .catch((e) => sendResponse({ ok: false, status: 0, data: { error: String(e?.message || e) } }));
  return true; // keep the channel open for the async response
});

// Streaming answers over a long-lived port: { delta } … then { done } or { error }.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ask") return;
  const controller = new AbortController();
  let open = true;
  port.onDisconnect.addListener(() => { open = false; controller.abort(); });
  const send = (m) => { if (open) { try { port.postMessage(m); } catch { open = false; } } };

  port.onMessage.addListener(async (body) => {
    try {
      const r = await fetch(`${self.YTCHAT_API}/api/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!r.ok || !r.body) {
        const data = await r.json().catch(() => ({}));
        send({ error: data.error || `Request failed (${r.status})` });
        return;
      }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done || !open) break;
        send({ delta: decoder.decode(value, { stream: true }) });
      }
      send({ done: true });
    } catch (e) {
      if (e?.name !== "AbortError") send({ error: "Couldn't reach the server. Check your connection." });
    }
  });
});

// Alt+Q: open or close the panel in the current tab.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "toggle-panel" || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "toggle-panel" }).catch(() => { /* not a YouTube tab */ });
});
