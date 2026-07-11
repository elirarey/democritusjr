// Central configuration for the Democritus Junior RAG chatbot.
// Every knob the spec asked to be tunable lives here.

export const config = {
  // ---- Generation (Anthropic) ----
  // Sonnet 5 is the spec's target. thinking is disabled for snappy, fully
  // streamed replies; Sonnet 5 rejects non-default sampling params, so we set
  // none. maxTokens bounds cost/abuse but must leave room for the digressive,
  // wandering answers the persona prompt asks for — 1024 truncated them
  // mid-WORD. 4096 (~3000 words) lets a committed digression reach a natural
  // close; raise it if you still see cut-offs, lower it to rein in length/cost.
  genModel: 'claude-sonnet-5',
  maxTokens: 4096,

  // ---- Embeddings (local, no API key) ----
  // Runs in-process via transformers.js (ONNX/WASM). The corpus is embedded
  // once at build time; only the user's query is embedded at request time.
  embedModel: 'Xenova/all-MiniLM-L6-v2',
  embedDim: 384,

  // ---- Per-IP metering ----
  // Counts questions per visitor (hashed IP) in Netlify Blobs. Used here to
  // invite feedback once someone has asked a lot; the same counter could later
  // enforce a hard rate cap.
  meter: {
    // Invite feedback once a visitor hits this many questions. Override via the
    // FEEDBACK_PROMPT_AFTER env var without a code change.
    feedbackPromptAfter: Number(process.env.FEEDBACK_PROMPT_AFTER) || 15,
  },

  // ---- Retrieval ----
  topK: 6,

  // ---- Digression stage (second retrieval) ----
  // A second semantic search whose QUERY is the text of the primary passage P
  // (not the user's question), used to surface a connected-but-tangential
  // passage the answer can wander into. The primary search above is untouched.
  digression: {
    enabled: true,

    // How the tangent is chosen from the candidates ranked by similarity to P:
    //   'band' — pick a passage from a mid rank band (skips the near-duplicates
    //            at ranks 1-3); robust because query == P, so "nearest" is just
    //            "most redundant". Varies per reply (random within the band).
    //   'mmr'  — Maximal Marginal Relevance. NOTE: because the query IS P, the
    //            relevance term and the diversity-from-P term reference the same
    //            signal, so a low lambda (favoring diversity) is what actually
    //            produces a tangent; lambda≈0.5 degenerates toward the nearest
    //            neighbor. See lib/retriever.mjs for the math.
    method: 'band',

    // Rank band (1-indexed) to draw the tangent from, for method 'band'.
    bandMin: 4,
    bandMax: 12,

    // MMR knobs, for method 'mmr'.
    mmrLambda: 0.35, // <0.5 favors tangents given query == P
    mmrPoolSize: 40, // consider this many top-relevant candidates

    // Exclude P and its neighbours so the tangent jumps elsewhere in the text:
    // any chunk within this many chunk_index of P, or sharing P's section_ref.
    adjacentWindow: 1,
    excludeSameSection: true,

    // P -> D -> E ... chaining. Default 1 = a single digression D.
    hops: 1,

    // Optional pivot hook (default off): before the digression search, have a
    // cheap model name one secondary subject/person/authority in P and use that
    // phrase as the digression query instead of P's full text.
    pivotHook: false,
    pivotModel: 'claude-haiku-4-5',
  },

  // ---- Chunking (ingest) ----
  // ~500-800 token passages with ~15% overlap. We approximate tokens as
  // words * 1.3, so target word counts below land in that token band.
  chunkTargetWords: 480, // ~625 tokens
  chunkOverlapWords: 72, // ~15% overlap

  // ---- Paths ----
  sourcePath: 'data/source.txt',
  indexPath: 'data/index.json',

  // ---- Persona ----
  author: 'Democritus Junior',
  authorReal: 'Robert Burton',
  work: 'The Anatomy of Melancholy',
};

// Structural-marker regexes for The Anatomy of Melancholy. Burton's hierarchy
// is Partition > Section > Member > Subsection. These are the config values the
// spec asked to expose so the parser can be retuned for a different text.
export const markers = {
  // Real partition headers ("THE THIRD PARTITION," ends with a comma). The
  // \b after PARTITION lets us accept trailing punctuation while the leading
  // ^THE (FIRST|SECOND|THIRD) still excludes "THE SYNOPSIS OF THE ...".
  partition: /^THE\s+(FIRST|SECOND|THIRD)\s+PARTITION\b/i,
  synopsis: /^THE\s+SYNOPSIS\s+OF\b/i,
  // "SECT. I. MEMB. II." (combined) or "SECT. II." alone
  section: /\bSECT\.\s+([IVXLCDM]+)\./i,
  member: /\bMEMB\.\s+([IVXLCDM]+)\./i,
  // "SUBSECT. IV.—Title" (em dash or hyphen), title optional
  subsection: /^SUBSECT\.\s+([IVXLCDM]+)\.\s*[—–-]?\s*(.*)$/i,
};

// Roman-numeral word -> ordinal, for partitions.
export const partitionOrdinal = { FIRST: 1, SECOND: 2, THIRD: 3 };
