// Parse The Anatomy of Melancholy into chunks that carry their structural
// citation (Partition > Section > Member > Subsection). The marker regexes live
// in config.mjs so this can be retuned for a different source text.

import { markers, partitionOrdinal } from '../config.mjs';

const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
function roman(s) {
  const t = String(s).toUpperCase();
  let total = 0;
  for (let i = 0; i < t.length; i++) {
    const cur = ROMAN[t[i]] || 0;
    const next = ROMAN[t[i + 1]] || 0;
    total += cur < next ? -cur : cur;
  }
  return total || null;
}

// Strip the Project Gutenberg license header/footer, keeping only the work.
export function stripGutenberg(raw) {
  const start = raw.search(/\*\*\*\s*START OF THE PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i);
  const end = raw.search(/\*\*\*\s*END OF THE PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i);
  let body = raw;
  if (start !== -1) body = body.slice(body.indexOf('\n', start) + 1);
  if (end !== -1) {
    const endInBody = body.search(/\*\*\*\s*END OF THE PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i);
    if (endInBody !== -1) body = body.slice(0, endInBody);
  }
  // Drop the trailing alphabetical INDEX — a ~19k-line keyword list that
  // otherwise dominates retrieval with content-free fragments.
  const idx = body.search(/\n\s*INDEX\.\s*\r?\n/);
  if (idx !== -1) body = body.slice(0, idx);
  return body;
}

function refString(st) {
  const parts = [];
  if (st.partition) parts.push(`Part. ${st.partition}`);
  if (st.section) parts.push(`Sect. ${st.section}`);
  if (st.member) parts.push(`Memb. ${st.member}`);
  if (st.subsection) parts.push(`Subs. ${st.subsection}`);
  if (parts.length === 0) return st.frontLabel || 'Front matter';
  return parts.join(', ');
}

// Walk the text line by line, maintaining the current structural state, and
// emit a flat list of content words each tagged with the active ref + title.
function tokenize(body) {
  const lines = body.split(/\r?\n/);
  const st = {
    partition: null,
    section: null,
    member: null,
    subsection: null,
    title: '',
    frontLabel: 'Front matter',
  };
  const tokens = []; // { word, ref, title }
  let skip = false; // inside a synopsis (table of contents) block

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // A synopsis block precedes each partition; skip its TOC lines entirely.
    if (markers.synopsis.test(line)) {
      skip = true;
      continue;
    }

    // Preface heading.
    if (/^DEMOCRITUS JUNIOR TO THE READER/i.test(line)) {
      Object.assign(st, { partition: null, section: null, member: null, subsection: null, title: '' });
      st.frontLabel = 'Democritus Junior to the Reader';
      continue;
    }
    // Partition heading resets everything below it.
    const mPart = line.match(markers.partition);
    if (mPart) {
      st.partition = partitionOrdinal[mPart[1].toUpperCase()] || null;
      st.section = null;
      st.member = null;
      st.subsection = null;
      st.title = '';
      skip = false; // the real partition ends the preceding synopsis block
      continue;
    }

    // Ignore everything (headings and content) inside a synopsis block.
    if (skip) continue;

    // Section (may carry member on the same line, e.g. "SECT. I. MEMB. II.").
    if (/^SECT\./i.test(line)) {
      const s = line.match(markers.section);
      if (s) st.section = roman(s[1]);
      const m = line.match(markers.member);
      st.member = m ? roman(m[1]) : 1;
      st.subsection = null;
      st.title = '';
      continue;
    }
    // Member heading alone.
    if (/^MEMB\./i.test(line)) {
      const m = line.match(markers.member);
      if (m) st.member = roman(m[1]);
      st.subsection = null;
      st.title = '';
      continue;
    }
    // Subsection heading carries a human title we keep for context.
    const mSub = line.match(markers.subsection);
    if (mSub) {
      st.subsection = roman(mSub[1]);
      st.title = (mSub[2] || '').replace(/[_.]+$/g, '').replace(/_/g, '').trim();
      continue;
    }

    // Ordinary content line.
    const ref = refString(st);
    const title = st.title;
    for (const word of line.split(/\s+/)) {
      if (word) tokens.push({ word, ref, title });
    }
  }
  return tokens;
}

// Slide a fixed word window (target size, overlap step) over the token stream.
// Each chunk inherits the ref/title of its first token.
export function chunk(body, { targetWords, overlapWords }) {
  const tokens = tokenize(body);
  const step = Math.max(1, targetWords - overlapWords);
  const chunks = [];
  for (let start = 0; start < tokens.length; start += step) {
    const window = tokens.slice(start, start + targetWords);
    if (window.length < 20 && start > 0) break; // drop a tiny trailing tail
    const text = window.map((t) => t.word).join(' ');
    chunks.push({
      text,
      section_ref: window[0].ref,
      title: window[0].title || '',
      chunk_index: chunks.length,
    });
    if (start + targetWords >= tokens.length) break;
  }
  return chunks;
}
