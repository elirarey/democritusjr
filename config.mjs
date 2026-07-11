// Central configuration for the Democritus Junior RAG chatbot.
// Every knob the spec asked to be tunable lives here.

export const config = {
  // ---- Generation (Anthropic) ----
  // Sonnet 5 is the spec's target. thinking is disabled for snappy, fully
  // streamed replies; Sonnet 5 rejects non-default sampling params, so we set
  // none. maxTokens is capped to bound cost/abuse on a public endpoint.
  genModel: 'claude-sonnet-5',
  maxTokens: 1024,

  // ---- Embeddings (local, no API key) ----
  // Runs in-process via transformers.js (ONNX/WASM). The corpus is embedded
  // once at build time; only the user's query is embedded at request time.
  embedModel: 'Xenova/all-MiniLM-L6-v2',
  embedDim: 384,

  // ---- Retrieval ----
  topK: 6,

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
