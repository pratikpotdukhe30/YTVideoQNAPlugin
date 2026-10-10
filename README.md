# Ask This Video

A Chrome extension that lets you chat with any YouTube video. Ask a question and get an answer grounded in what is actually said in the video, with timestamps you can click to jump to that moment.

It is a retrieval-augmented generation (RAG) pipeline running across a browser extension and a small serverless backend.

## How it works

```mermaid
flowchart LR
    subgraph Browser extension
      A[YouTube page] -->|transcript| B[Chunk ~1000 chars<br/>200 overlap, with timestamps]
      B --> C[(Vector cache<br/>chrome.storage)]
      Q[Question] --> R[Top-5 retrieval<br/>cosine similarity]
      C --> R
    end
    B -->|/api/embed| E[OpenAI embeddings<br/>text-embedding-3-small, 512d]
    Q -->|/api/embed| E
    R -->|/api/answer| G[OpenAI gpt-6-luna<br/>streamed]
    G -->|answer with [mm:ss] citations| UI[Chat panel]
```

1. **Transcript.** The extension reads the transcript in the viewer's browser, trying three methods in order: the caption track, YouTube's transcript endpoint, and the transcript panel on the page.
2. **Indexing.** The transcript is split into overlapping chunks that keep their start time, and each chunk is embedded once. The vectors are cached locally (last 15 videos), so reopening a video is instant and costs nothing.
3. **Retrieval.** Each question is embedded and the five most similar chunks are selected in the browser.
4. **Generation.** Only those chunks go to the model, which answers from them alone and cites timestamps. The answer streams into the panel, and timestamps become buttons that seek the video.

## Design decisions

- **The API key stays on the server.** The extension talks only to my backend, so users never need an OpenAI key.
- **Retrieval runs in the browser.** The backend is stateless: it only embeds text and generates answers. No database is needed and nothing is stored server-side.
- **Small embeddings.** 512-dimension vectors make caching cheap with little loss in retrieval quality.
- **Abuse limits.** Requests are only accepted from the extension, inputs are size-capped, and there is a per-IP rate limit.
- **Isolated UI.** The panel lives in a Shadow DOM, so YouTube's styles can't break it and vice versa. Typing in the panel doesn't trigger YouTube's keyboard shortcuts.

## Project structure

```
api/
  _shared.ts        CORS, rate limiting, config
  embed.ts          POST /api/embed   -> embeddings
  answer.ts         POST /api/answer  -> streamed answer
extension/
  manifest.json     Chrome extension (Manifest V3)
  config.js         Backend URL
  background.js     Service worker: all network calls, streaming over a port
  page.js           Reads YouTube's player data (runs in the page context)
  transcript.js     Transcript extraction with three fallbacks
  rag.js            Chunking, cosine similarity, top-k
  content.js        Chat panel, indexing flow, cache
index.html          Landing page with install instructions
```

## Setup

### 1. Deploy the backend

1. Push this repository to GitHub and import it on [Vercel](https://vercel.com). Framework preset: **Other**.
2. Add the environment variable `OPENAI_API_KEY`. Optionally set `OPENAI_MODEL`.
3. Deploy, and note the URL (for example `https://ask-this-video.vercel.app`).

### 2. Point the extension at it

Set the URL in `extension/config.js`:

```js
self.YTCHAT_API = "https://ask-this-video.vercel.app";
```

### 3. Load the extension

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `extension` folder.
3. Open any YouTube video and click **Ask this video** in the bottom-right corner.

## Privacy

The transcript chunks and your questions are sent to the backend and to OpenAI to produce an answer. Nothing is stored on the server. Cached embeddings stay in your browser.

## Limitations

- Videos without captions or a transcript can't be searched.
- Answers are only as good as the transcript. Auto-generated captions can contain mistakes.
- Very long videos (over about 6 hours) are rejected to keep costs predictable.

## Roadmap

- Publish on the Chrome Web Store
- Support YouTube Shorts
- Answer questions about what's on screen, not only what's said
