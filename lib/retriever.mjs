// Retrieval over the precomputed index. Primary path: semantic search using a
// locally-embedded query vs. the corpus embeddings. Fallback path: BM25 keyword
// search, which needs no model and keeps the app working if the embedder can't
// initialize in a serverless function.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.mjs';

// Note: do NOT name this __dirname — bundlers (esbuild) inject their own
// __dirname when wrapping ESM, and a second declaration is a SyntaxError.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

let indexCache = null;

function resolveIndexPath() {
  const candidates = [
    process.env.INDEX_PATH,
    path.join(process.cwd(), config.indexPath),
    path.join(moduleDir, '..', config.indexPath),
    path.join(moduleDir, '..', 'data', 'index.json'),
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

// ---------- Digression (second retrieval) ----------
// Everything below is additive; the primary retrieve() above is unchanged.

// Score every chunk against a query, using the same semantic/BM25 policy as the
// primary path. Returns { method, scores, qvec }. qvec is null in keyword mode.
async function scoreAll(idx, query) {
  if (!process.env.FORCE_BM25) {
    try {
      const { embedOne } = await import('./embedder.mjs');
      const qvec = await embedOne(query);
      const { matrix, dim, count } = idx;
      const scores = new Float64Array(count);
      for (let i = 0; i < count; i++) {
        let dot = 0;
        const base = i * dim;
        for (let d = 0; d < dim; d++) dot += matrix[base + d] * qvec[d];
        scores[i] = dot;
      }
      return { method: 'semantic', scores, qvec };
    } catch (err) {
      console.warn('[retriever] digression semantic failed, using BM25:', err?.message);
    }
  }
  if (!idx.bm25) buildBM25(idx);
  const { tf, len, avgdl, idf, k1, b } = idx.bm25;
  const qterms = [...new Set(tokenize(query))];
  const scores = new Float64Array(idx.count);
  for (let i = 0; i < idx.count; i++) {
    let s = 0;
    for (const q of qterms) {
      const f = tf[i].get(q);
      if (!f) continue;
      s += (idf.get(q) || 0) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len[i]) / avgdl)));
    }
    scores[i] = s;
  }
  return { method: 'keyword', scores, qvec: null };
}

// Cosine between two corpus rows (both normalized → dot product).
function rowDot(idx, i, j) {
  const { matrix, dim } = idx;
  const bi = i * dim;
  const bj = j * dim;
  let dot = 0;
  for (let d = 0; d < dim; d++) dot += matrix[bi + d] * matrix[bj + d];
  return dot;
}

// Choose one tangential passage relative to `ref`, excluding `ref`'s neighbours
// and anything already used. Returns { idx, rank } or null.
function pickTangent(idx, ref, excludeSet, scoreObj, opts) {
  const { scores, qvec } = scoreObj;
  const excluded = (i) =>
    excludeSet.has(i) ||
    Math.abs(i - ref.chunk_index) <= opts.adjacentWindow ||
    (opts.excludeSameSection && idx.chunks[i].section_ref === ref.section_ref);

  const ranked = Array.from({ length: idx.count }, (_, i) => i)
    .filter((i) => !excluded(i))
    .sort((a, b) => scores[b] - scores[a]);
  if (!ranked.length) return null;

  // MMR: because the query IS ref's text, `scores` is similarity-to-ref, and so
  // is the diversity term. With lambda < 0.5 this favours the most tangential
  // passage inside the top-relevant pool. (Semantic mode only — needs vectors.)
  if (opts.method === 'mmr' && qvec) {
    const pool = ranked.slice(0, opts.mmrPoolSize);
    let best = pool[0];
    let bestScore = -Infinity;
    for (const c of pool) {
      const rel = scores[c];
      const div = rowDot(idx, c, ref.chunk_index);
      const mmr = opts.mmrLambda * rel - (1 - opts.mmrLambda) * div;
      if (mmr > bestScore) {
        bestScore = mmr;
        best = c;
      }
    }
    return { idx: best, rank: ranked.indexOf(best) + 1 };
  }

  // Band: draw from a mid rank band (1-indexed), skipping the near-duplicates at
  // the top. Random within the band so tangents vary from reply to reply.
  const lo = Math.max(1, opts.bandMin);
  const hi = Math.min(opts.bandMax, ranked.length);
  if (hi < lo) {
    const last = ranked.length - 1;
    return { idx: ranked[last], rank: ranked.length };
  }
  const r = lo - 1 + Math.floor(Math.random() * (hi - lo + 1));
  return { idx: ranked[r], rank: r + 1 };
}

// Produce the digression chain P -> D (-> E ...). `queryText` seeds the first
// hop (P's own text by default, or a pivot phrase); later hops query the
// previous passage's text. Returns { method, passages: [...] }.
export async function digress(primary, { queryText, hops = config.digression.hops } = {}) {
  const idx = loadIndex();
  const opts = config.digression;
  const excludeSet = new Set([primary.chunk_index]);
  const passages = [];
  let ref = primary;
  let method = 'semantic';

  for (let h = 0; h < Math.max(1, hops); h++) {
    const q = h === 0 ? queryText || primary.text : ref.text;
    const scoreObj = await scoreAll(idx, q);
    method = scoreObj.method;
    const chosen = pickTangent(idx, ref, excludeSet, scoreObj, opts);
    if (!chosen) break;
    const chunk = idx.chunks[chosen.idx];
    passages.push({
      ...chunk,
      score: scoreObj.scores[chosen.idx],
      rank: chosen.rank,
      kind: 'digression',
      hop: h + 1,
    });
    excludeSet.add(chunk.chunk_index);
    ref = chunk;
  }

  return { method, passages };
}
