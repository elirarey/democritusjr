// Retrieval over the precomputed index. Primary path: semantic search using a
// locally-embedded query vs. the corpus embeddings. Fallback path: BM25 keyword
// search, which needs no model and keeps the app working if the embedder can't
// initialize in a serverless function.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let indexCache = null;

function resolveIndexPath() {
  const candidates = [
    process.env.INDEX_PATH,
    path.join(process.cwd(), config.indexPath),
    path.join(__dirname, '..', config.indexPath),
    path.join(__dirname, '..', 'data', 'index.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `Could not find ${config.indexPath}. Run "npm run ingest" first. Looked in: ${candidates.join(', ')}`
  );
}

export function loadIndex() {
  if (indexCache) return indexCache;
  const raw = fs.readFileSync(resolveIndexPath(), 'utf8');
  const data = JSON.parse(raw);
  const buf = Buffer.from(data.embeddingsB64, 'base64');
  const flat = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  indexCache = {
    chunks: data.chunks,
    dim: data.dim,
    matrix: flat, // n * dim, row-major, L2-normalized
    count: data.chunks.length,
    bm25: null,
  };
  return indexCache;
}

// ---------- BM25 (fallback) ----------

const STOP = new Set(
  'a an the and or but of to in on at for with as by is are was were be been being it its this that these those i you he she they we from not no do does did so than then such about into over under'.split(
    ' '
  )
);

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z]+/g) || []).filter(
    (w) => w.length > 2 && !STOP.has(w)
  );
}

function buildBM25(idx) {
  const docs = idx.chunks.map((c) => tokenize(c.text));
  const N = docs.length;
  const df = new Map();
  const tf = docs.map((doc) => {
    const m = new Map();
    for (const w of doc) m.set(w, (m.get(w) || 0) + 1);
    for (const w of m.keys()) df.set(w, (df.get(w) || 0) + 1);
    return m;
  });
  const len = docs.map((d) => d.length);
  const avgdl = len.reduce((a, b) => a + b, 0) / (N || 1);
  const idf = new Map();
  for (const [w, d] of df) idf.set(w, Math.log(1 + (N - d + 0.5) / (d + 0.5)));
  idx.bm25 = { tf, len, avgdl, idf, N, k1: 1.5, b: 0.75 };
}

function bm25Search(idx, query, k) {
  if (!idx.bm25) buildBM25(idx);
  const { tf, len, avgdl, idf, k1, b } = idx.bm25;
  const qterms = [...new Set(tokenize(query))];
  const scores = new Float64Array(idx.count);
  for (let i = 0; i < idx.count; i++) {
    let s = 0;
    for (const q of qterms) {
      const f = tf[i].get(q);
      if (!f) continue;
      const w = idf.get(q) || 0;
      s += w * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len[i]) / avgdl)));
    }
    scores[i] = s;
  }
  return topK(scores, k, idx);
}

// ---------- Semantic (primary) ----------

function cosineSearch(idx, qvec, k) {
  const { matrix, dim, count } = idx;
  const scores = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    let dot = 0;
    const base = i * dim;
    for (let d = 0; d < dim; d++) dot += matrix[base + d] * qvec[d];
    scores[i] = dot; // rows and query are normalized → cosine
  }
  return topK(scores, k, idx);
}

function topK(scores, k, idx) {
  const order = Array.from({ length: idx.count }, (_, i) => i)
    .sort((a, b) => scores[b] - scores[a])
    .slice(0, k);
  return order.map((i) => ({
    ...idx.chunks[i],
    score: scores[i],
  }));
}

// Retrieve top-k passages. Tries semantic search; on any embedder failure,
// transparently falls back to BM25 and reports which path was used.
export async function retrieve(query, k = config.topK) {
  const idx = loadIndex();
  // Operators can set FORCE_BM25=1 (e.g. on Netlify) to skip the embedding model
  // entirely and guarantee fast, cold-start-free keyword retrieval.
  if (process.env.FORCE_BM25) {
    return { method: 'keyword', results: bm25Search(idx, query, k) };
  }
  try {
    const { embedOne } = await import('./embedder.mjs');
    const qvec = await embedOne(query);
    return { method: 'semantic', results: cosineSearch(idx, qvec, k) };
  } catch (err) {
    console.warn('[retriever] semantic path failed, using BM25:', err?.message);
    return { method: 'keyword', results: bm25Search(idx, query, k) };
  }
}
