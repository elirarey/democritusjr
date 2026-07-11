// A small, swappable interface over the embedding provider.
// Today it is transformers.js running MiniLM locally (no API key). To swap
// providers later, replace `embed()` and keep the same signature:
//   embed(texts: string[]) => Promise<Float32Array[]>  (L2-normalized).

import { config } from '../config.mjs';

let extractorPromise = null;

// Lazily load the transformers.js pipeline. On serverless (read-only FS except
// /tmp) we redirect the model cache to /tmp and allow remote model download.
async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      // On Lambda-style hosts only /tmp is writable.
      if (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME) {
        env.cacheDir = '/tmp/transformers-cache';
      }
      env.allowLocalModels = false; // fetch from the HF hub / bundled cache
      return pipeline('feature-extraction', config.embedModel, {
        quantized: true,
      });
    })();
  }
  return extractorPromise;
}

// Embed a batch of strings. Returns L2-normalized Float32Array vectors.
export async function embed(texts) {
  const extractor = await getExtractor();
  const out = [];
  for (const text of texts) {
    const result = await extractor(text, { pooling: 'mean', normalize: true });
    out.push(Float32Array.from(result.data));
  }
  return out;
}

export async function embedOne(text) {
  const [v] = await embed([text]);
  return v;
}
