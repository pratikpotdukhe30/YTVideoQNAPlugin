// Retrieval helpers: chunking with timestamps, cosine similarity, top-k search.
// Chunks of ~1000 characters with ~200 characters of overlap, each keeping its start time.

self.YTRag = {
  // segments: [{ start: seconds, text }]  ->  chunks: [{ start, text }]
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

  topK(queryVec, chunks, vectors, k = 4) {
    return vectors
      .map((v, idx) => ({ idx, score: this.cosine(queryVec, v) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((r) => chunks[r.idx])
      .sort((a, b) => a.start - b.start);
  },
};
