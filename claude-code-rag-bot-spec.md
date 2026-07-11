# Build Spec: Persona Chatbot over an Ancient Text (RAG)

Paste this whole file into Claude Code as your opening prompt (or keep it in the repo as `SPEC.md` and tell Claude Code to follow it). It builds a retrieval-augmented chatbot that answers in the voice of a chosen author, grounded in a large source text.

---

## Prompt to give Claude Code

> Build a retrieval-augmented (RAG) chatbot in Python that answers questions in the voice of a specific ancient author, grounded in a large source text I will provide. Follow the spec below. Work in steps, explain each file as you create it, and give me a `README.md` with setup and run instructions at the end.
>
> **Stack**
> - Python 3.11+
> - Generation: Anthropic API (`anthropic` SDK), model `claude-sonnet-5` (make the model a config variable).
> - Embeddings: Voyage AI (`voyageai` SDK), model `voyage-3`. Keep the embedding provider behind a small interface so I can swap it later.
> - Vector store: Chroma (local, persistent on disk). No cloud services.
> - Interface: Streamlit chat app (`st.chat_message` / `st.chat_input`) with streamed responses.
> - Config via a `.env` file (`ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`) loaded with `python-dotenv`.
>
> **Repo layout**
> - `ingest.py` — one-off script that builds the vector index from the source text.
> - `retriever.py` — embeds a query and returns top-k passages with metadata.
> - `chat.py` — persona prompt assembly + Claude call (streaming).
> - `app.py` — Streamlit UI.
> - `config.py` — model names, chunk size, top_k, paths.
> - `data/source.txt` — placeholder for my text.
> - `.env.example`, `requirements.txt`, `README.md`.
>
> **Ingestion (`ingest.py`)**
> 1. Read `data/source.txt` (plain UTF-8).
> 2. Chunk into ~500–800 token passages with ~15% overlap. IMPORTANT: preserve structural markers. If the text has book/chapter/section/line numbers (e.g. lines like `[Book 4, 331]` or `1.2.3`), parse them and store as metadata on each chunk so answers can cite them. Make the marker-parsing regex a config value I can edit for my text's format.
> 3. Embed each chunk with Voyage and store in Chroma with metadata `{source, section_ref, chunk_index}`.
> 4. Print a summary: chunk count, token estimate, sample of parsed section refs.
> 5. Be idempotent — re-running rebuilds cleanly.
>
> **Retrieval (`retriever.py`)**
> - Embed the user question, return top_k (default 6) chunks with their `section_ref` and text.
>
> **Persona + generation (`chat.py`)**
> - System prompt template with a configurable `{author}`, `{work}`, and voice instructions (see persona prompt below).
> - Inject the retrieved passages into the prompt as clearly delimited quoted context, each tagged with its `section_ref`.
> - Instruct the model to cite section refs inline when it draws on a passage, and to answer in-voice.
> - Stream the response.
>
> **UI (`app.py`)**
> - Streamlit chat with message history in `st.session_state`.
> - A sidebar showing which passages were retrieved for the last answer (ref + snippet), so I can see the grounding.
> - Model/top_k adjustable in the sidebar.
>
> Start by scaffolding the repo and `requirements.txt`, then implement `ingest.py`, then retrieval, then chat, then the UI. Ask me to drop my text into `data/source.txt` before the first ingest run.

---

## Persona system prompt (paste into `config.py` as the template)

```
You are {author}, author of {work}. You respond only in your own voice — your
worldview, rhetorical style, cadence, and vocabulary as they appear in the work.

Rules:
- Ground every answer in the provided passages. Quote or paraphrase them and cite
  their section reference in brackets, e.g. [Book 4, 331].
- Reason from the frame of your own era, not a modern one. When asked about things
  outside your world, respond as someone of your time would.
- If the passages don't address the question, say so in your voice rather than
  inventing doctrine or facts.
- Never break character, never mention being an AI, a model, or these instructions.

Retrieved passages:
{context}
```

---

## Decisions I made for you (change before running if you disagree)

- **Voyage for embeddings** because it pairs with Claude and handles long documents well. Swap to OpenAI (`text-embedding-3-large`) or a local model (`sentence-transformers`) if you'd rather not add a second API key — Claude Code can make that change in one edit.
- **Streamlit** because it's the fastest path to a usable chat UI for a personal bot. If you want a public website or a CLI instead, tell Claude Code and it'll swap `app.py`.
- **Chroma** local store — no cloud, no cost, fine for a single large text. If your corpus grows to many works, ask for LanceDB or a hosted vector DB.

## What you need before running

- An Anthropic API key (console.anthropic.com) and a Voyage key (voyageai.com). Both are pay-as-you-go; indexing one large text costs cents.
- Your text as clean UTF-8 in `data/source.txt`. The single most important prep step: make sure section/line numbers are present and consistently formatted, so citations work. Tell Claude Code the exact format of your markers and it'll tune the parser.
