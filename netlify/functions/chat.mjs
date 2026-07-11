// Netlify Function (v2) — the server-side proxy that holds the API key.
// It password-gates the endpoint, retrieves grounding passages, then streams
// Claude's answer back as newline-delimited JSON (NDJSON):
//   {"type":"sources", ...}   once, up front (for the grounding sidebar)
//   {"type":"delta","text":…} repeatedly, as the answer streams
//   {"type":"done"}           at the end   |   {"type":"error","message":…}

import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.mjs';
import { retrieve, digress } from '../../lib/retriever.mjs';
import { buildSystem, renderContext, buildDigressionSystem } from '../../lib/persona.mjs';

const snip = (t) => t.slice(0, 240).replace(/\s+/g, ' ').trim() + '…';

// The visitor's IP, from Netlify's header (falls back to x-forwarded-for).
function clientIp(req) {
  return (
    req.headers.get('x-nf-client-connection-ip') ||
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    ''
  );
}

// Store an opaque hash of the IP, never the IP itself.
function ipKey(ip) {
  return createHash('sha256')
    .update((process.env.METER_SALT || 'anatomy-of-melancholy') + ip)
    .digest('hex')
    .slice(0, 32);
}

// Count questions per visitor in Netlify Blobs; return true exactly once, when
// the visitor first crosses the feedback threshold. Fails open (never blocks a
// reply) if Blobs is unavailable, e.g. running outside Netlify.
async function meterAndMaybePrompt(req) {
  const threshold = Number(process.env.FEEDBACK_PROMPT_AFTER) || config.meter.feedbackPromptAfter;
  try {
    const ip = clientIp(req);
    if (!ip) return { prompt: false, count: 0, note: 'no-ip' };
    const { getStore } = await import('@netlify/blobs');
    // Strong consistency: default (eventual) reads can miss a just-written value,
    // so the counter never accumulates across requests.
    const store = getStore({ name: 'usage-meter', consistency: 'strong' });
    const key = ipKey(ip);
    const rec = (await store.get(key, { type: 'json' })) || { count: 0, prompted: false };
    rec.count += 1;
    let prompt = false;
    if (!rec.prompted && rec.count >= threshold) {
      rec.prompted = true;
      prompt = true;
    }
    await store.setJSON(key, rec);
    return { prompt, count: rec.count };
  } catch (err) {
    console.warn('[meter] skipped:', err?.message);
    return { prompt: false, count: 0, note: 'blobs-error: ' + (err?.message || '') };
  }
}

// Optional pivot hook: a cheap model names one secondary subject/person/
// authority in the primary passage, used as the digression query. Falls back to
// the passage text on any failure. (No `thinking` param — kept model-agnostic.)
async function pivotPhrase(client, text) {
  const msg = await client.messages.create({
    model: config.digression.pivotModel,
    max_tokens: 24,
    system:
      'You name ONE secondary subject, person, or authority mentioned in the passage — something adjacent to its main point that would make a good digression. Reply with only that short phrase, nothing else.',
    messages: [{ role: 'user', content: text.slice(0, 2000) }],
  });
  const out = (msg.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .trim();
  return out || text;
}

const MAX_HISTORY = 12; // cap turns sent to the model (cost/abuse)
const MAX_CHARS = 4000; // cap per-message length

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // ---- password gate ----
  const required = process.env.SITE_PASSWORD;
  if (required) {
    const given = req.headers.get('x-site-password') || '';
    if (given !== required) return json({ error: 'unauthorized' }, 401);
  }

  // Read the raw body (robust across runtimes).
  let payload;
  try {
    payload = JSON.parse((await req.text()) || '{}');
  } catch {
    return json({ error: 'Invalid request body' }, 400);
  }

  // Normalize + bound the conversation history the client sent.
  const history = Array.isArray(payload.messages) ? payload.messages : [];
  const messages = history
    .filter(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim()
    )
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');

  // No question present -> this is the login / status check the gate makes on
  // page load and on password entry. The password already passed above, so
  // report access is granted without invoking the model.
  if (!lastUser) return json({ ok: true }, 200);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: 'Server missing ANTHROPIC_API_KEY' }, 500);

  const client = new Anthropic({ apiKey });

  // ---- primary retrieval (unchanged): semantic search on the question ----
  let method = 'keyword';
  let results = [];
  try {
    ({ method, results } = await retrieve(lastUser.content));
  } catch (err) {
    return json({ error: `Index unavailable: ${err.message}` }, 500);
  }

  // ---- digression stage: build the system prompt + grounding sources ----
  const primary = results[0] || null;
  let system;
  let sources;

  if (config.digression.enabled && primary) {
    // Second search seeded by P's own text (or a pivot phrase from it).
    let queryText = primary.text;
    if (config.digression.pivotHook) {
      queryText = await pivotPhrase(client, primary.text).catch(() => primary.text);
    }

    let passages = [];
    try {
      ({ passages } = await digress(primary, { queryText, hops: config.digression.hops }));
    } catch (err) {
      console.warn('[chat] digression failed:', err?.message);
    }

    system = buildDigressionSystem(primary.text, passages.map((p) => p.text).join('\n\n'));
    sources = [
      { kind: 'primary', section_ref: primary.section_ref, title: primary.title, snippet: snip(primary.text) },
      ...passages.map((p) => ({
        kind: 'digression',
        section_ref: p.section_ref,
        title: p.title,
        snippet: snip(p.text),
      })),
    ];
  } else {
    // Digression off (or nothing retrieved): original grounded-answer path.
    system = buildSystem(renderContext(results));
    sources = results.map((r) => ({
      kind: 'primary',
      section_ref: r.section_ref,
      title: r.title,
      snippet: snip(r.text),
    }));
  }

  // Count this question per visitor; invite feedback once at the threshold.
  const meter = await meterAndMaybePrompt(req);

  const body = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj) => controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'));
      send({ type: 'sources', method, sources, feedbackPrompt: meter.prompt, _meter: meter });

      try {
        const msgStream = client.messages.stream({
          model: config.genModel,
          max_tokens: config.maxTokens,
          thinking: { type: 'disabled' },
          system,
          messages,
        });
        for await (const ev of msgStream) {
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            send({ type: 'delta', text: ev.delta.text });
          }
        }
        send({ type: 'done' });
      } catch (err) {
        send({ type: 'error', message: err?.message || 'generation failed' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
};
