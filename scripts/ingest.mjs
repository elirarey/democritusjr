// One-off ingest: read the source text, strip the Gutenberg wrapper, chunk with
// structural markers, embed every chunk locally, and write data/index.json.
// Idempotent — re-running rebuilds the index cleanly.

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.mjs';
import { stripGutenberg, chunk } from '../lib/textPrep.mjs';
import { embed } from '../lib/embedder.mjs';

const t0 = Date.now();

const raw = fs.readFileSync(config.sourcePath, 'utf8');
const body = stripGutenberg(raw);

const chunks = chunk(body, {
  targetWords: config.chunkTargetWords,
  overlapWords: config.chunkOverlapWords,
});

const totalWords = chunks.reduce((n, c) => n + c.text.split(/\s+/).length, 0);
const tokenEstimate = Math.round(totalWords * 1.3);

console.log(`Parsed ${chunks.length} chunks (~${tokenEstimate.toLocaleString()} tokens).`);
console.log('Sample section refs:');
for (const c of pickSamples(chunks, 8)) {
  const t = c.title ? ` — ${c.title}` : '';
  console.log(`  [${c.section_ref}${t}]  "${c.text.slice(0, 60).replace(/\s+/g, ' ')}…"`);
}

console.log(`\nEmbedding with ${config.embedModel} (first run downloads the model)…`);
const dim = config.embedDim;
const flat = new Float32Array(chunks.length * dim);
const BATCH = 64;
for (let i = 0; i < chunks.length; i += BATCH) {
  const slice = chunks.slice(i, i + BATCH);
  const vecs = await embed(slice.map((c) => c.text));
  vecs.forEach((v, j) => flat.set(v, (i + j) * dim));
  process.stdout.write(`\r  embedded ${Math.min(i + BATCH, chunks.length)}/${chunks.length}`);
}
process.stdout.write('\n');

const out = {
  model: config.embedModel,
  dim,
  count: chunks.length,
  chunks: chunks.map(({ text, section_ref, title, chunk_index }) => ({
    text,
    section_ref,
    title,
    chunk_index,
  })),
  embeddingsB64: Buffer.from(flat.buffer).toString('base64'),
};

fs.mkdirSync(path.dirname(config.indexPath), { recursive: true });
fs.writeFileSync(config.indexPath, JSON.stringify(out));

const sizeMB = (fs.statSync(config.indexPath).size / 1e6).toFixed(1);
console.log(
  `\nWrote ${config.indexPath} — ${chunks.length} chunks, ${sizeMB} MB, in ${((Date.now() - t0) / 1000).toFixed(0)}s.`
);

function pickSamples(arr, n) {
  const out = [];
  const step = Math.max(1, Math.floor(arr.length / n));
  for (let i = 0; i < arr.length && out.length < n; i += step) out.push(arr[i]);
  return out;
}
