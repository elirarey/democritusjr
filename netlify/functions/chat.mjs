// Netlify Function (v2) — the server-side proxy that holds the API key.
// It password-gates the endpoint, retrieves grounding passages, then streams
// Claude's answer back as newline-delimited JSON (NDJSON):
//   {"type":"sources", ...}   once, up front (for the grounding sidebar)
//   {"type":"delta","text":…} repeatedly, as the answer streams
//   {"type":"done"}           at the end   |   {"type":"error","message":…}

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.mjs';
import { retrieve } from '../../lib/retriever.mjs';
import { buildSystem, renderContext } from '../../lib/persona.mjs';

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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: 'Server missing ANTHROPIC_API_KEY' }, 500);

  // Read the raw body ourselves (more robust than req.json() across runtimes)
  // and keep it around so we can report exactly what arrived if parsing/shape
  // is wrong.
  let rawBody = '';
  try {
    rawBody = await req.text();
  } catch (e) {
    rawBody = '';
  }
  let payload;
  try {
    payload = JSON.parse(rawBody || '{}');
  } catch {
    return json({ error: 'Invalid JSON', debug: { rawLen: rawBody.length, rawPreview: rawBody.slice(0, 200) } }, 400);
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
  if (!lastUser) {
    return json(
      {
        error: 'No user message',
        debug: {
          rawLen: rawBody.length,
          rawPreview: rawBody.slice(0, 200),
          method: req.method,
          contentType: req.headers.get('content-type'),
          payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload) : typeof payload,
          messagesType: Array.isArray(payload?.messages) ? `array(${payload.messages.length})` : typeof payload?.messages,
        },
      },
      400
    );
  }

  // ---- retrieve grounding for the latest question ----
  let method = 'keyword';
  let results = [];
  try {
    ({ method, results } = await retrieve(lastUser.content));
  } catch (err) {
    return json({ error: `Index unavailable: ${err.message}` }, 500);
  }

  const system = buildSystem(renderContext(results));
  const sources = results.map((r) => ({
    section_ref: r.section_ref,
    title: r.title,
    snippet: r.text.slice(0, 240).replace(/\s+/g, ' ') + '…',
  }));

  const client = new Anthropic({ apiKey });

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
