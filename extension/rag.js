// Retrieval helpers: chunking with timestamps, hybrid search (BM25 keywords + embeddings), top-k.

self.YTRag = {
  // segments: [{ start: seconds, text }]  ->  chunks: [{ start, text }]
  // Chunks of ~1000 characters with ~200 characters of overlap, each keeping its start time.
  chunk(segments, size = 1000, overlap = 200) {
    const chunks = [];
    let i = 0;
    while (i < segments.length) {
      let text = "";
      let j = i;
      while (j < segments.length && text.length < size) {
        text += (text ? " " : "") + segments[j].text;
        j++;
      }
      chunks.push({ start: segments[i].start, text });
      if (j >= segments.length) break;
      // Step back until roughly `overlap` characters are repeated in the next chunk.
      let back = 0, k = j;
      while (k > i + 1 && back < overlap) { k--; back += segments[k].text.length + 1; }
      i = Math.max(k, i + 1);
    }
    return chunks;
  },

  cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
  },

  // Unicode-aware tokenizer (works for Latin, Devanagari, etc.). Very common English words are dropped.
  STOP: new Set("a an and are as at be but by can do does for from has have he her his how i if in into is it its me my of on or our she so that the their them they this to was we were what when where which who why will with you your about there then than also just".split(" ")),
  tokenize(text) {
    return (text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) || []).filter((t) => t.length > 1 && !this.STOP.has(t));
  },

  // BM25 keyword index, built once per video (cheap: no network, no storage).
  buildKeywordIndex(chunks) {
    const docs = chunks.map((c) => {
      const tf = new Map();
      const toks = this.tokenize(c.text);
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      return { tf, len: toks.length };
    });
    const df = new Map();
    for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    const avgLen = docs.reduce((s, d) => s + d.len, 0) / (docs.length || 1);
    return { docs, df, avgLen, n: docs.length };
  },

  bm25(index, query, k1 = 1.4, b = 0.75) {
    const terms = [...new Set(this.tokenize(query))];
    return index.docs.map((d) => {
      let score = 0;
      for (const t of terms) {
        const f = d.tf.get(t);
        if (!f) continue;
        const n = index.df.get(t) || 0;
        const idf = Math.log(1 + (index.n - n + 0.5) / (n + 0.5));
        score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / (index.avgLen || 1)));
      }
      return score;
    });
  },

  // Hybrid retrieval: rank by meaning (embeddings) and by exact words (BM25), then merge the two
  // rankings with reciprocal rank fusion. Names and terms ("LangChain", "EPFL") get found reliably,
  // and paraphrased questions still work.
  hybridTopK(queryVec, query, chunks, vectors, keywordIndex, k = 5) {
    const RRF = 60;
    const fused = new Map();
    const add = (ranked) => ranked.forEach((idx, rank) => fused.set(idx, (fused.get(idx) || 0) + 1 / (RRF + rank + 1)));

    const semantic = vectors.map((v, idx) => ({ idx, s: this.cosine(queryVec, v) })).sort((a, b) => b.s - a.s).map((r) => r.idx);
    add(semantic.slice(0, 30));

    const kw = this.bm25(keywordIndex, query);
    const keyword = kw.map((s, idx) => ({ idx, s })).filter((r) => r.s > 0).sort((a, b) => b.s - a.s).map((r) => r.idx);
    add(keyword.slice(0, 30));

    return [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([idx]) => chunks[idx])
      .sort((a, b) => a.start - b.start);
  },

  // Kept for compatibility: semantic-only top-k.
  topK(queryVec, chunks, vectors, k = 4) {
    return vectors
      .map((v, idx) => ({ idx, score: this.cosine(queryVec, v) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((r) => chunks[r.idx])
      .sort((a, b) => a.start - b.start);
  },

  // Questions that need the whole video rather than a few passages.
  isOverviewQuestion(q) {
    return /summar|overview|recap|tl;?dr|key (points|takeaways|ideas|moments)|main (points|ideas|topics)|what is (this|the) video about|what('?s| is) it about|outline|chapters|riassun|sommario|résumé|resumen|zusammenfass|सारांश/i.test(q);
  },
};
