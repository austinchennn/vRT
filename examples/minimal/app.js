import { connect } from '@vrealtime/client';
import { accentColorTool } from './tools.js';

const $ = (id) => document.getElementById(id);
const url = location.origin.replace(/^http/, 'ws');
const lines = new Map();
let session;
let connecting;

function line(id, role, text) {
  let el = lines.get(id);
  if (!el) {
    el = document.createElement('li');
    el.className = role;
    $('log').append(el);
    lines.set(id, el);
  }
  el.textContent = text;
  el.scrollIntoView({ block: 'nearest' });
}

function note(text, kind = 'note') {
  const el = document.createElement('li');
  el.className = kind;
  el.textContent = text;
  $('log').append(el);
  el.scrollIntoView({ block: 'nearest' });
}

function setStatus(text) {
  $('status').textContent = text;
}

/** Connect from a click or submit, so the browser lets the page play audio. */
function start(voice) {
  connecting ??= connect(url, {
    tools: { set_accent_color: accentColorTool((color) => document.documentElement.style.setProperty('--accent', color)) },
    audio: voice ? { input: 'mic', output: 'speaker' } : { output: 'speaker' },
  }).then((s) => {
    session = s;
    setStatus(voice ? 'Listening. Talk any time; speaking over the agent interrupts it.' : 'Connected. Type a message.');
    $('talk').disabled = true;
    $('stop').disabled = false;
    s.on('state', (e) => { $('state').textContent = e.state; });
    s.on('transcript', (e) => line(e.itemId, e.role, e.text));
    s.on('tool.result', (e) => note(e.result.ok ? `✓ ${e.name} ${JSON.stringify(e.result.output)}` : `✗ ${e.name}: ${e.result.code}`, 'tool'));
    s.on('interrupted', () => note('Interrupted'));
    s.on('error', (e) => note(`${e.code}: ${e.message}`, 'error'));
    s.on('reconnecting', (e) => setStatus(`Reconnecting (attempt ${e.attempt})…`));
    s.on('ready', (e) => { if (e.resumed) setStatus('Reconnected.'); });
    s.on('closed', () => { setStatus('Disconnected. Reload to start again.'); $('stop').disabled = true; });
    return s;
  }, (error) => {
    connecting = undefined;
    setStatus(`Could not connect: ${error.message}`);
    throw error;
  });
  return connecting;
}

$('talk').onclick = () => void start(true).catch(() => {});
$('stop').onclick = () => session?.interrupt('user');
addEventListener('keydown', (e) => { if (e.key === 'Escape') session?.interrupt('keyboard'); });
$('form').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('text').value.trim();
  if (!text) return;
  $('text').value = '';
  const s = await start(false).catch(() => undefined);
  if (!s) return;
  line(`local-${Date.now()}`, 'user', text);
  s.sendText(text);
};
