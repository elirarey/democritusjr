// One-off: extract Burton's footnotes from a public-domain annotated HTML
// edition of the book into data/footnotes.json — a { "3182": "Consil. 21.…" }
// map. The plain-text source (data/source.txt) keeps the inline [NNNN] markers
// but not the note bodies, so the bodies are sourced from the HTML edition.
//
// Usage: point HTML_PATH at a local copy of that HTML edition, then run:
//   HTML_PATH=/path/to/edition.html node scripts/extract-footnotes.mjs

import fs from 'node:fs';

const HTML = process.env.HTML_PATH || '/private/tmp/pg10800.html';
const html = fs.readFileSync(HTML, 'utf8');

const notes = {};
// Each footnote is a self-contained <div class="note">…</div>.
const re = /<div class="note">([\s\S]*?)<\/div>/g;
let m;
while ((m = re.exec(html))) {
  const inner = m[1];
  const idm = inner.match(/id="note(\d+)"/);
  if (!idm) continue;
  const n = idm[1];

  const text = inner
    // keep emphasis, normalize <i> -> <em>
    .replace(/<i\b[^>]*>/gi, '<em>')
    .replace(/<\/i>/gi, '</em>')
    .replace(/<em\b[^>]*>/gi, '<em>')
    // strip every other tag (the id anchor, internal cross-ref links, etc.),
    // keeping their inner text. HTML entities are left intact so they render.
    .replace(/<(?!\/?em\b)[^>]+>/gi, '')
    // drop the leading "NNNN. " that was the anchor's text
    .replace(/^\s*\d+\s*\.\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();

  notes[n] = text;
}

fs.writeFileSync('data/footnotes.json', JSON.stringify(notes));
const keys = Object.keys(notes);
console.log(`Extracted ${keys.length} footnotes -> data/footnotes.json`);
console.log('Samples:');
for (const k of ['1', '3182', '6790']) {
  if (notes[k]) console.log(`  [${k}] ${notes[k].slice(0, 90)}…`);
}
