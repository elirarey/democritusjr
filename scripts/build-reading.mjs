// Build public/read.html — the full text of The Anatomy of Melancholy as a
// single readable page, with an anchor id on every heading so the chat's
// reference list can deep-link into it. Mirrors the structural walk in
// lib/textPrep.mjs, but preserves headings/paragraphs instead of flattening.
//
// Anchor scheme (keep in sync with refToAnchor in public/app.js):
//   partition p{P}, section s{S}, member m{M}, subsection u{U}
//   e.g. Part.1, Sect.2, Memb.2, Subs.3 -> "p1-s2-m2-u3"
//   preface -> "preface", front matter -> "frontmatter"

import fs from 'node:fs';
import { config, markers, partitionOrdinal } from '../config.mjs';
import { stripGutenberg } from '../lib/textPrep.mjs';

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

function esc(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Project Gutenberg marks italics with _underscores_. Turn balanced pairs into
// real <em>, then drop any orphan underscore (an italic marker whose partner
// fell on another line) so none show up literally in headings or text.
function inline(s) {
  return esc(s)
    .replace(/_([^_\n]+)_/g, '<em>$1</em>')
    .replace(/_/g, '');
}

function anchorFromState(st) {
  if (!st.partition && !st.section) {
    return st.frontLabel === 'preface' ? 'preface' : 'frontmatter';
  }
  const a = [];
  if (st.partition) a.push('p' + st.partition);
  if (st.section) a.push('s' + st.section);
  if (st.member) a.push('m' + st.member);
  if (st.subsection) a.push('u' + st.subsection);
  return a.join('-');
}

function buildBodyHtml(body) {
  // Begin at Burton's own title page — drop the "Introduction to the Project
  // Gutenberg Edition" and the frontispiece caption that precede it.
  const titleIdx = body.search(/THE[^\S\r\n]*\r?\n\s*ANATOMY OF MELANCHOLY,/);
  if (titleIdx !== -1) body = body.slice(titleIdx);
  const lines = body.split(/\r?\n/);
  const st = { partition: null, section: null, member: null, subsection: null, frontLabel: 'frontmatter' };
  const out = ['<h1 id="frontmatter" class="rd-title">The Anatomy of Melancholy</h1>'];
  let para = [];
  let skip = false;

  const flush = () => {
    if (para.length) {
      out.push('<p>' + inline(para.join(' ')) + '</p>');
      para = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }

    if (markers.synopsis.test(line)) {
      flush();
      skip = true;
      continue;
    }

    if (/^DEMOCRITUS JUNIOR TO THE READER/i.test(line)) {
      flush();
      Object.assign(st, { partition: null, section: null, member: null, subsection: null });
      st.frontLabel = 'preface';
      out.push(`<h2 id="preface" class="rd-h rd-preface">${inline(line)}</h2>`);
      continue;
    }

    const mPart = line.match(markers.partition);
    if (mPart) {
      flush();
      st.partition = partitionOrdinal[mPart[1].toUpperCase()] || null;
      st.section = null;
      st.member = null;
      st.subsection = null;
      skip = false;
      out.push(`<h2 id="${anchorFromState(st)}" class="rd-h rd-part">${inline(line)}</h2>`);
      continue;
    }

    if (skip) continue;

    if (/^SECT\./i.test(line)) {
      flush();
      const s = line.match(markers.section);
      if (s) st.section = roman(s[1]);
      const m = line.match(markers.member);
      st.member = m ? roman(m[1]) : 1;
      st.subsection = null;
      out.push(`<h3 id="${anchorFromState(st)}" class="rd-h rd-sect">${inline(line)}</h3>`);
      continue;
    }
    if (/^MEMB\./i.test(line)) {
      flush();
      const m = line.match(markers.member);
      if (m) st.member = roman(m[1]);
      st.subsection = null;
      out.push(`<h3 id="${anchorFromState(st)}" class="rd-h rd-memb">${inline(line)}</h3>`);
      continue;
    }
    const mSub = line.match(markers.subsection);
    if (mSub) {
      flush();
      st.subsection = roman(mSub[1]);
      out.push(`<h4 id="${anchorFromState(st)}" class="rd-h rd-subs">${inline(line)}</h4>`);
      continue;
    }

    para.push(line);
  }
  flush();
  return out.join('\n');
}

const PAGE = (bodyHtml) => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>The Anatomy of Melancholy — full text</title>
    <link rel="stylesheet" href="/styles.css" />
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%9C%81%3C/text%3E%3C/svg%3E" />
  </head>
  <body class="reading">
    <header class="rd-topbar">
      <a class="rd-back" href="/">← Back to the dialogue</a>
      <nav class="rd-nav">
        <a href="#preface">Preface</a>
        <a href="#p1">Part I</a>
        <a href="#p2">Part II</a>
        <a href="#p3">Part III</a>
      </nav>
    </header>
    <main class="rd-book">
${bodyHtml}
    </main>
  </body>
</html>
`;

const raw = fs.readFileSync(config.sourcePath, 'utf8');
const body = stripGutenberg(raw);
const html = PAGE(buildBodyHtml(body));
fs.writeFileSync('public/read.html', html);

const headings = (html.match(/class="rd-h/g) || []).length;
const sizeMB = (Buffer.byteLength(html) / 1e6).toFixed(1);
console.log(`Wrote public/read.html — ${headings} headings, ${sizeMB} MB.`);
