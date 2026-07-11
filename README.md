# Democritus Junior — a RAG chatbot over *The Anatomy of Melancholy*

A public-facing web app that answers questions **in the voice of Democritus Junior**
(Robert Burton's pen name), grounded in the full text of *The Anatomy of
Melancholy* (1621) via retrieval-augmented generation.

- **Frontend:** static HTML/CSS/JS (no framework, no build step).
- **Backend:** a single **Netlify Function** that holds your Anthropic API key
  server-side, retrieves grounding passages, and streams Claude's reply.
- **Generation:** Anthropic `claude-sonnet-5` (streamed).
- **Embeddings:** local, in-process via **transformers.js** (`all-MiniLM-L6-v2`).
  No second API key. The book is embedded once at build time; only the user's
  question is embedded per request — with an automatic **BM25 keyword fallback**
  if the embedder can't initialize.
- **Citations:** every chunk carries its Burton reference
  (Partition › Section › Member › Subsection), shown in a "Grounding" sidebar
  and cited inline by the model.

## ⚠️ Security notes (read first)

- **The API key never touches the browser.** It lives only in the
  `ANTHROPIC_API_KEY` server environment variable and is used inside the Netlify
  Function. Do not put it in any file under `public/`.
- If you ever paste an API key into a chat, email, or commit, **rotate it** at
  [console.anthropic.com](https://console.anthropic.com). Treat it as burned.
- The site is protected by a shared `SITE_PASSWORD`. This guards your token
  spend; it is **not** real per-user auth. Anyone with the password can chat.

## Repo layout

```
config.mjs                 model, chunking, top_k, marker regexes, persona name
lib/
  textPrep.mjs             parse structural markers, chunk
  embedder.mjs             transformers.js embedding interface (swappable)
  retriever.mjs            semantic search + BM25 fallback over the index
  persona.mjs              system-prompt assembly + context rendering
scripts/ingest.mjs         one-off: build data/index.json from data/source.txt
netlify/functions/chat.mjs the server-side proxy (password gate + stream)
public/                    index.html, styles.css, app.js  (the static site)
data/source.txt            the source text (public domain)
data/footnotes.json        the book's footnotes, keyed by number (for read.html)
data/index.json            precomputed chunks + embeddings (created by ingest)
netlify.toml               Netlify build/function config
```

## Setup

Requires Node 20+.

```bash
npm install
cp .env.example .env          # fill in ANTHROPIC_API_KEY and SITE_PASSWORD
```

### 1. Build the index (one-off)

```bash
npm run ingest
```

This reads `data/source.txt`, chunks it (~625-token passages, 15% overlap,
preserving Burton's structural markers), embeds every chunk locally, and writes
`data/index.json`. The first run downloads the MiniLM model (~25 MB). Re-run any
time to rebuild cleanly. **Commit `data/index.json`** — it ships with the
function.

To use a different text, drop it into `data/source.txt`, tune the marker regexes
in `config.mjs` to your text's format, and re-run ingest.

### 2. Run locally

```bash
npm install -g netlify-cli   # if you don't have it
netlify dev                  # serves public/ and the function at /api/chat
```

Open the printed URL. You'll be asked for the `SITE_PASSWORD`.

### 3. Deploy to Netlify

1. Push this repo to GitHub (with `data/index.json` committed).
2. In Netlify: **Add new site → Import from Git**, pick the repo.
   `netlify.toml` already sets publish dir, functions dir, and bundling.
3. In **Site settings → Environment variables**, add:
   - `ANTHROPIC_API_KEY` — your (freshly rotated) key
   - `SITE_PASSWORD` — the shared password for visitors
4. Deploy. The static site is served from `public/`; `/api/chat` routes to the
   function.

## How it works (request flow)

1. Browser POSTs the conversation to `/api/chat` with the `x-site-password` header.
2. The function checks the password, embeds the latest question, and retrieves
   the top-`k` (default 6) passages by cosine similarity over the precomputed
   embeddings (or BM25 if the embedder is unavailable).
3. It builds the persona system prompt with those passages injected as
   ref-tagged context, calls `claude-sonnet-5` with streaming, and returns
   newline-delimited JSON: a `sources` event, then `delta` events, then `done`.
4. The frontend renders the streamed answer and lists the grounding passages.

## Cost & abuse controls

- Password gate (`SITE_PASSWORD`).
- Per-request history capped (12 turns) and per-message length capped.
- `max_tokens` capped at 1024 per reply (see `config.mjs`).
- Embeddings are precomputed, so there is no per-request embedding API cost.

For a heavily-trafficked public deploy, also consider per-IP rate limiting
(e.g. Netlify's rate-limiting rules or an edge function).

## Tuning

Everything lives in `config.mjs`: `genModel`, `maxTokens`, `topK`,
chunk sizes, and the `markers` regexes for parsing structural references.

## Source text

*The Anatomy of Melancholy* by Robert Burton (1621) — in the **public domain**.
The text and footnotes are sourced from a public-domain digital edition; all
distributed copies here are the underlying public-domain work only.
