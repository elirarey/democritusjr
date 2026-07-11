// Netlify Function (v2) — the server-side proxy that holds the API key.
// It password-gates the endpoint, retrieves grounding passages, then streams
// Claude's answer back as newline-delimited JSON (NDJSON):
//   {"type":"sources", ...}   once, up front (for the grounding sidebar)
//   {"type":"delta","text":…} repeatedly, as the answer streams
//   {"type":"done"}           at the end   |   {"type":"error","message":…}

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.mjs';
import { retrieve, digress } from '../../lib/retriever.mjs';
import { buildSystem, renderContext, buildDigressionSystem } from '../../lib/persona.mjs';

const snip = (t) => t.slice(0, 240).replace(/\s+/g, ' ').trim() + '…';

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

  const body = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj) => controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'));
      send({ type: 'sources', method, sources });

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
