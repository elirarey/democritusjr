// Client for the Democritus Junior chatbot. Keeps conversation state, streams
// NDJSON from /api/chat, renders the answer + grounding sidebar, and handles the
// shared-password gate.

const state = []; // [{ role: 'user'|'assistant', content: string }]
let password = sessionStorage.getItem('site-password') || '';
let busy = false;

const messagesEl = document.getElementById('messages');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const sourcesEl = document.getElementById('sources');
const groundingNote = document.getElementById('grounding-note');

const gate = document.getElementById('gate');
const gateForm = document.getElementById('gate-form');
const gateInput = document.getElementById('gate-input');
const gateError = document.getElementById('gate-error');

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

function renderSources(method, sources) {
  sourcesEl.innerHTML = '';
  groundingNote.hidden = true;
  const tag = el('span', 'method-tag', method === 'semantic' ? 'semantic search' : 'keyword search');
  sourcesEl.appendChild(tag);
  if (!sources.length) {
    sourcesEl.appendChild(el('p', 'grounding-note', 'No passages were retrieved for this question.'));
    return;
  }
  for (const s of sources) {
    const li = el('li');
    li.appendChild(el('div', 'ref', `[${s.section_ref}]`));
    if (s.title) li.appendChild(el('div', 'title', s.title));
    li.appendChild(el('div', 'snippet', s.snippet));
    sourcesEl.appendChild(li);
  }
}

// ---------- gate ----------
function showGate() {
  gate.hidden = false;
  gateInput.focus();
}
gateForm.addEventListener('submit', (e) => {
  e.preventDefault();
  password = gateInput.value;
  sessionStorage.setItem('site-password', password);
  gate.hidden = true;
  gateError.hidden = true;
  streamAnswer(); // retry the pending turn
});

// ---------- send / stream ----------
async function streamAnswer() {
  busy = true;
  sendBtn.disabled = true;

  const bubble = addMessage('assistant', 'Democritus Junior', '');
  bubble.classList.add('thinking');
  bubble.textContent = 'consulting his authorities…';

  let res;
  try {
    res = await fetch('/.netlify/functions/chat', {
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

  if (res.status === 401) {
    bubble.closest('.msg').remove();
    gateError.hidden = !password ? true : false; // show "wrong word" only after an attempt
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
  } else {
    bubble.textContent = 'He fell silent, and gave no answer.';
  }
  busy = false;
  sendBtn.disabled = false;
  scrollDown();
}

function handleEvent(evt, bubble, cursor, append) {
  if (evt.type === 'sources') {
    renderSources(evt.method, evt.sources || []);
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
