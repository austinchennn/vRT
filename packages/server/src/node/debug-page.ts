/**
 * Microphone debug page served by `serve()` at `/`. A dependency-free protocol v1
 * client: text and voice in, transcripts and audio out, a barge-in interrupt and
 * one app-side tool (`set_accent_color`) behind an epoch gate.
 */
export const DEBUG_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>vRealTime debug</title>
<style>
  :root { --accent: #2563eb; --bg: #fff; --fg: #111827; --muted: #6b7280; --line: #e5e7eb; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b0f17; --fg: #e5e7eb; --muted: #9ca3af; --line: #1f2937; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 20px; margin: 0 0 4px; color: var(--accent); }
  .muted { color: var(--muted); font-size: 13px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 12px 0; }
  button { background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; font: inherit; cursor: pointer; }
  button.secondary { background: transparent; color: var(--fg); border: 1px solid var(--line); }
  form { display: flex; gap: 8px; }
  input { flex: 1; min-width: 0; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; font: inherit; }
  #state { padding: 2px 8px; border-radius: 99px; border: 1px solid var(--accent); color: var(--accent); font-size: 13px; }
  #log { border-top: 1px solid var(--line); margin-top: 12px; padding-top: 8px; }
  #log p { margin: 6px 0; } .user { font-weight: 600; } .note { color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>vRealTime</h1>
  <div class="muted" id="status">connecting…</div>
  <div class="row">
    <button id="mic">Start mic</button>
    <button id="stop" class="secondary">Interrupt</button>
    <span id="state">idle</span>
  </div>
  <form id="form"><input id="text" placeholder="Type a message" autocomplete="off"><button>Send</button></form>
  <div id="log"></div>
</main>
<script type="module">
const RATE = 24000, FRAME = 480, TRANSIENT = ['hello', 'ack', 'ping'];
const $ = (id) => document.getElementById(id);
let seq = 0, lastSeq = 0, epoch = 0, closedEpoch = -1, audioSeq = 0;

const tools = {
  set_accent_color: {
    description: 'Set the page accent color to any CSS color.',
    parameters: { type: 'object', properties: { color: { type: 'string' } }, required: ['color'] },
    run: ({ color }) => { document.documentElement.style.setProperty('--accent', color); return { color }; },
  },
};

const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + location.pathname);
ws.binaryType = 'arraybuffer';
const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify({ v: 1, seq: TRANSIENT.includes(m.type) ? 0 : ++seq, ...m })); };
ws.onopen = () => send({
  type: 'hello',
  tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, parameters: t.parameters })),
  input: { encoding: 'pcm16', sampleRate: RATE }, output: { encoding: 'pcm16', sampleRate: RATE },
});
ws.onclose = (e) => { $('status').textContent = 'disconnected (' + e.code + ')'; };
setInterval(() => { send({ type: 'ping' }); if (lastSeq) send({ type: 'ack', upTo: lastSeq }); }, 10000);

const lines = new Map();
function line(id, role, text) {
  let el = lines.get(id);
  if (!el) { el = document.createElement('p'); el.className = role; $('log').append(el); lines.set(id, el); }
  el.textContent = (role === 'user' ? 'You: ' : 'Agent: ') + text;
  el.scrollIntoView({ block: 'end' });
}
function note(text) { const el = document.createElement('p'); el.className = 'note'; el.textContent = text; $('log').append(el); }

// Playback: schedule PCM16 chunks back to back; track what was actually heard per item.
let ctx, playhead = 0, sources = [], item;
const audio = () => (ctx ??= new AudioContext({ sampleRate: RATE }));
function play(bytes) {
  const c = audio(), n = bytes.byteLength >> 1, view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  const buffer = c.createBuffer(1, n, RATE), data = buffer.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = view.getInt16(i * 2, true) / 32768;
  const src = c.createBufferSource();
  src.buffer = buffer; src.connect(c.destination);
  const at = Math.max(playhead, c.currentTime + 0.02);
  if (item.start === undefined) item.start = at;
  src.start(at); playhead = at + buffer.duration; item.end = playhead;
  sources.push(src); src.onended = () => { sources = sources.filter((s) => s !== src); };
}
function stopPlayback() {
  for (const s of sources) s.stop();
  sources = []; playhead = 0;
  if (item && item.start !== undefined) {
    const heard = Math.max(0, Math.min(audio().currentTime, item.end) - item.start) * 1000;
    send({ type: 'playback', itemId: item.id, playedMs: Math.round(heard) });
  }
  item = undefined;
}
function interrupt() {
  closedEpoch = Math.max(closedEpoch, epoch);
  stopPlayback();
  send({ type: 'interrupt', epoch, reason: 'user' });
}

async function runTool(m) {
  const tool = tools[m.name];
  if (m.epoch <= closedEpoch) return send({ type: 'tool.result', callId: m.callId, epoch: m.epoch, ok: false, code: 'INTERRUPTED', message: 'interrupted' });
  if (!tool) return send({ type: 'tool.result', callId: m.callId, epoch: m.epoch, ok: false, code: 'FAILED', message: 'unknown tool' });
  try {
    const output = await tool.run(m.arguments);
    send({ type: 'tool.result', callId: m.callId, epoch: m.epoch, ok: true, output });
    note('tool ' + m.name + ' ' + JSON.stringify(m.arguments));
  } catch (e) {
    send({ type: 'tool.result', callId: m.callId, epoch: m.epoch, ok: false, code: 'FAILED', message: String(e) });
  }
}

ws.onmessage = (e) => {
  if (typeof e.data !== 'string') {
    const bytes = new Uint8Array(e.data);
    if (bytes[0] === 2 && item) play(bytes.subarray(5));
    return;
  }
  const m = JSON.parse(e.data);
  if (m.seq > 0) { if (m.seq <= lastSeq) return; lastSeq = m.seq; }
  switch (m.type) {
    case 'ready': $('status').textContent = 'session ' + m.sessionId; break;
    case 'turn.state':
      epoch = Math.max(epoch, m.epoch); $('state').textContent = m.state;
      if (m.state === 'listening' && sources.length) stopPlayback();
      break;
    case 'transcript': line(m.itemId, m.role, m.text); break;
    case 'text': line(m.responseId, 'agent', ((lines.get(m.responseId)?.textContent ?? 'Agent: ').slice(7)) + m.delta); break;
    case 'audio.start': item = m.epoch > closedEpoch ? { id: m.itemId } : undefined; break;
    case 'tool.call': runTool(m); break;
    case 'interrupted': closedEpoch = Math.max(closedEpoch, m.epoch); stopPlayback(); note('interrupted'); break;
    case 'error': note('error ' + m.code + ': ' + m.message); break;
  }
};

$('form').onsubmit = (e) => {
  e.preventDefault();
  const text = $('text').value.trim();
  if (!text) return;
  stopPlayback(); line('local-' + seq, 'user', text); send({ type: 'text', text }); $('text').value = '';
};
$('stop').onclick = interrupt;

// Microphone: AudioWorklet → 20 ms PCM16 frames → [kind=1][seq u32 BE][payload].
const WORKLET = \`class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(\${FRAME}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = s < 0 ? s * 32768 : s * 32767;
      if (this.n === \${FRAME}) { this.port.postMessage(this.buf.buffer.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('vrt-capture', Capture);\`;
let mic;
$('mic').onclick = async () => {
  if (mic) { mic.getTracks().forEach((t) => t.stop()); mic = undefined; $('mic').textContent = 'Start mic'; return; }
  const c = audio();
  await c.resume();
  mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  await c.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
  const node = new AudioWorkletNode(c, 'vrt-capture');
  node.port.onmessage = ({ data }) => {
    if (!mic || ws.readyState !== 1) return;
    const frame = new Uint8Array(5 + data.byteLength);
    frame[0] = 1; new DataView(frame.buffer).setUint32(1, audioSeq++ >>> 0); frame.set(new Uint8Array(data), 5);
    ws.send(frame);
  };
  c.createMediaStreamSource(mic).connect(node);
  $('mic').textContent = 'Stop mic';
};
</script>
</body>
</html>
`;
