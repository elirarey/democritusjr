// Client for the Democritus Junior chatbot. Keeps conversation state, streams
// NDJSON from the function, renders the answer with a reference list beneath it,
// and handles the shared-password gate.

const FN = '/.netlify/functions/chat';
const state = []; // [{ role: 'user'|'assistant', content: string }]
let password = sessionStorage.getItem('site-password') || '';
let busy = false;

const messagesEl = document.getElementById('messages');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
let currentSources = []; // passages behind the latest answer (for its reference list)

const gate = document.getElementById('gate');
const gateForm = document.getElementById('gate-form');
const gateInput = document.getElementById('gate-input');
const gateError = document.getElementById('gate-error');

const feedbackBtn = document.getElementById('feedback');
const toastEl = document.getElementById('toast');

// ---------- DOM helpers ----------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function addMessage(role, who, text) {
  const wrap = el('div', `msg ${role}`);
  wrap.appendChild(el('div', 'who', who));
  const bubble = el('div', 'bubble', text || '');
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollDown();
  return bubble;
}

function scrollDown() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Wrap bracketed citations like [Part. 1, Sect. 2, ...] for styling.
function highlightCitations(text) {
  const frag = document.createDocumentFragment();
  const re = /\[[^\]\n]{2,70}\]/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    frag.appendChild(el('span', 'cite', m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

// Map a section_ref string to an anchor id on /read.html.
// KEEP IN SYNC with anchorFromState in scripts/build-reading.mjs.
function refToAnchor(ref) {
  if (!ref) return '';
  if (/reader/i.test(ref)) return 'preface';
  if (/front matter/i.test(ref)) return 'frontmatter';
  const grab = (re) => {
    const m = ref.match(re);
    return m ? m[1] : null;
  };
  const p = grab(/Part\.\s*(\d+)/i);
  const s = grab(/Sect\.\s*(\d+)/i);
  const m = grab(/Memb\.\s*(\d+)/i);
  const u = grab(/Subs\.\s*(\d+)/i);
  const a = [];
  if (p) a.push('p' + p);
  if (s) a.push('s' + s);
  if (m) a.push('m' + m);
  if (u) a.push('u' + u);
  return a.join('-');
}

// Build the reference list appended under a finished answer: just the section
// references (and their titles) that grounded it — no quoted text. Each ref
// links into the full-text reading page at the matching section.
function renderReferences(sources) {
  if (!sources || !sources.length) return null;
  const seen = new Set();
  const wrap = el('div', 'references');
  wrap.appendChild(el('div', 'references-label', 'Whence this was drawn'));
  const ul = document.createElement('ul');
  for (const s of sources) {
    const key = s.section_ref + '|' + (s.title || '');
    if (seen.has(key)) continue;
    seen.add(key);
    const li = document.createElement('li');
    const anchor = refToAnchor(s.section_ref);
    if (anchor) {
      const a = el('a', 'ref', s.section_ref);
      a.href = '/read.html#' + anchor;
      a.target = '_blank';
      a.rel = 'noopener';
      li.appendChild(a);
    } else {
      li.appendChild(el('span', 'ref', s.section_ref));
    }
    if (s.title) {
      li.appendChild(document.createTextNode(' — '));
      li.appendChild(el('span', 'title', s.title));
    }
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
  return wrap;
}

// ---------- authentication gate ----------
// Authentication is its OWN step, done before any question exists. The function
// treats a request with an empty message list as a pure access check:
// 200 = allowed (correct password, or the site has no password), 401 = denied.

async function checkAccess(pw) {
  try {
    const res = await fetch(FN, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(pw ? { 'x-site-password': pw } : {}),
      },
      body: JSON.stringify({ messages: [] }),
    });
    return res.status;
  } catch {
    return 0; // network error
  }
}

function showGate() {
  gate.hidden = false;
  gateInput.focus();
}

function unlock() {
  gate.hidden = true;
  gateError.hidden = true;
  input.disabled = false;
  sendBtn.disabled = false;
  input.focus();
}

// On load: go straight in if the site is open or we already hold a valid
// password; otherwise present the login gate.
async function init() {
  const status = await checkAccess(password);
  if (status === 200) unlock();
  else showGate();
}

gateForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const attempt = gateInput.value;
  const submitBtn = gateForm.querySelector('button');
  submitBtn.disabled = true;
  const status = await checkAccess(attempt);
  submitBtn.disabled = false;
  if (status === 200) {
    password = attempt;
    sessionStorage.setItem('site-password', password);
    unlock();
  } else if (status === 401) {
    gateError.textContent = 'That is not the word.';
    gateError.hidden = false;
    gateInput.select();
  } else {
    gateError.textContent = 'Could not reach the study. Try again.';
    gateError.hidden = false;
  }
});

// ---------- send / stream ----------
async function streamAnswer() {
  busy = true;
  sendBtn.disabled = true;
  currentSources = [];

  const bubble = addMessage('assistant', 'Democritus Junior', '');
  bubble.classList.add('thinking');
  bubble.textContent = 'consulting his authorities…';

  let res;
  try {
    res = await fetch(FN, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(password ? { 'x-site-password': password } : {}),
      },
      body: JSON.stringify({ messages: state }),
    });
  } catch (err) {
    finishError(bubble, 'The study could not be reached. Try again.');
    return;
  }

  // Password stopped working mid-session (e.g. it was changed) — re-authenticate.
  if (res.status === 401) {
    bubble.closest('.msg').remove();
    busy = false;
    sendBtn.disabled = false;
    showGate();
    return;
  }
  if (!res.ok || !res.body) {
    finishError(bubble, 'The study is shut fast (error ' + res.status + ').');
    return;
  }

  bubble.classList.remove('thinking');
  bubble.textContent = '';
  const cursor = el('span', 'cursor', '▍');
  bubble.appendChild(cursor);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let answer = '';

  const pump = async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        handleEvent(evt, bubble, cursor, (t) => (answer += t));
      }
    }
  };

  try {
    await pump();
  } catch (err) {
    // stream interrupted mid-answer; keep whatever we have
  }

  cursor.remove();
  if (answer) {
    bubble.textContent = '';
    bubble.appendChild(highlightCitations(answer));
    state.push({ role: 'assistant', content: answer });
    const refs = renderReferences(currentSources);
    if (refs) bubble.closest('.msg').appendChild(refs);
  } else {
    bubble.textContent = 'He fell silent, and gave no answer.';
  }
  busy = false;
  sendBtn.disabled = false;
  scrollDown();
}

function handleEvent(evt, bubble, cursor, append) {
  if (evt.type === 'sources') {
    currentSources = evt.sources || [];
  } else if (evt.type === 'delta') {
    append(evt.text);
    cursor.insertAdjacentText('beforebegin', evt.text);
    scrollDown();
  } else if (evt.type === 'error') {
    cursor.insertAdjacentText('beforebegin', `\n\n(He was interrupted: ${evt.message})`);
  }
}

function finishError(bubble, text) {
  bubble.classList.remove('thinking');
  bubble.textContent = text;
  busy = false;
  sendBtn.disabled = false;
}

// ---------- composer ----------
form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (busy) return;
  const text = input.value.trim();
  if (!text) return;
  addMessage('user', 'You', text);
  state.push({ role: 'user', content: text });
  input.value = '';
  input.style.height = 'auto';
  streamAnswer();
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

// ---------- feedback ----------
// The address is never a contiguous string in the HTML or JS source — it's
// assembled from parts only when the button is clicked, so page-scraping spam
// bots (which regex the served HTML for x@y.z) don't find it.
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4500);
}

function transcriptText() {
  if (!state.length) return '';
  return state
    .map((m) => (m.role === 'user' ? 'Visitor' : 'Democritus Junior') + ':\n' + m.content)
    .join('\n\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

feedbackBtn.addEventListener('click', async () => {
  const p = ['elirarey', 'gmail', 'com'];
  const addr = p[0] + '@' + p[1] + '.' + p[2];
  const transcript = transcriptText();

  const lines = ['My thoughts on Democritus Junior:', '', '', ''];
  if (transcript) {
    const copied = await copyText(transcript);
    if (copied) {
      lines.push('— My conversation is on my clipboard; paste it below this line —');
      toast('Your conversation was copied — paste it into the email.');
    } else {
      lines.push('— My conversation —', '', transcript);
      toast('Opening your email app…');
    }
  } else {
    toast('Opening your email app…');
  }

  const subject = encodeURIComponent('Democritus Junior — feedback');
  const body = encodeURIComponent(lines.join('\n'));
  window.location.href = `mailto:${addr}?subject=${subject}&body=${body}`;
});

// ---------- startup ----------
// Lock the composer until access is confirmed, then check access.
input.disabled = true;
sendBtn.disabled = true;
init();
