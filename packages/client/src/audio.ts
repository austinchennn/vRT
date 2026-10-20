import { CaptureResampler } from './capture.js';
import { PlaybackRing } from './ring.js';

/** Speaker side as the session uses it; swappable in tests and for custom output. */
export interface AudioSink {
  /** Queue mono little-endian PCM16 for `itemId`. */
  enqueue(itemId: string, pcm16: Uint8Array): void;
  /**
   * Stop at once (within one render quantum) and return the milliseconds played per item
   * since the last flush, with 0 for an item that was queued but never started (§8.4).
   */
  flush(): Promise<Record<string, number>>;
  close(): Promise<void>;
}

/** Microphone side: delivers 20 ms PCM16 frames until stopped. */
export interface AudioSource {
  stop(): Promise<void>;
}

const SPEAKER_WORKLET = (ring: string) => `const Ring = (${ring});
class Speaker extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Ring(sampleRate * 60);
    this.port.onmessage = ({ data }) => {
      if (data.type === 'push') this.ring.push(data.samples, data.item);
      else if (data.type === 'flush') this.port.postMessage({ type: 'flushed', id: data.id, played: this.ring.flush() });
    };
  }
  process(_inputs, outputs) {
    const output = outputs[0];
    this.ring.pull(output[0]);
    for (let c = 1; c < output.length; c++) output[c].set(output[0]);
    return true;
  }
}
registerProcessor('vrt-speaker', Speaker);`;

const CAPTURE_WORKLET = (resampler: string) => `const Resampler = (${resampler});
class Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { rate, frame } = options.processorOptions;
    this.resampler = new Resampler(sampleRate, rate, frame);
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) for (const frame of this.resampler.push(channel)) this.port.postMessage(frame.buffer, [frame.buffer]);
    return true;
  }
}
registerProcessor('vrt-capture', Capture);`;

const loaded = new WeakMap<BaseAudioContext, Set<string>>();

async function addWorklet(context: AudioContext, name: string, source: string): Promise<void> {
  const names = loaded.get(context) ?? new Set();
  loaded.set(context, names);
  if (names.has(name)) return;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    await context.audioWorklet.addModule(url);
    names.add(name);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function pcm16ToFloat(pcm: Uint8Array): Float32Array {
  const n = pcm.byteLength >> 1;
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/**
 * AudioWorklet ring-buffer speaker. Create it from a user gesture (or call
 * `context.resume()` in one), as browsers block audio that starts on its own.
 */
export async function createSpeaker(sampleRate: number, context = new AudioContext({ sampleRate })): Promise<AudioSink> {
  await addWorklet(context, 'vrt-speaker', SPEAKER_WORKLET(PlaybackRing.toString()));
  const node = new AudioWorkletNode(context, 'vrt-speaker', { numberOfInputs: 0, outputChannelCount: [1] });
  node.connect(context.destination);
  const pending = new Map<number, (played: Record<string, number>) => void>();
  let nextId = 0;
  node.port.onmessage = ({ data }) => {
    if (data.type !== 'flushed') return;
    pending.get(data.id)?.(data.played);
    pending.delete(data.id);
  };
  const toMs = (samples: Record<string, number>) =>
    Object.fromEntries(Object.entries(samples).map(([item, count]) => [item, (count / context.sampleRate) * 1000]));
  void context.resume().catch(() => {});
  return {
    enqueue(itemId, pcm16) {
      const samples = pcm16ToFloat(pcm16);
      node.port.postMessage({ type: 'push', item: itemId, samples }, [samples.buffer]);
    },
    flush() {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, (played) => resolve(toMs(played)));
        node.port.postMessage({ type: 'flush', id });
      });
    },
    async close() {
      node.disconnect();
      await context.close();
    },
  };
}

/** Microphone capture through an AudioWorklet, resampled to `sampleRate` and framed every `frameMs`. */
export async function createMicrophone(sampleRate: number, onFrame: (pcm16: Uint8Array) => void, frameMs = 20): Promise<AudioSource> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  // The device rate is used as-is (Firefox cannot mix rates); the worklet resamples.
  const context = new AudioContext();
  await addWorklet(context, 'vrt-capture', CAPTURE_WORKLET(CaptureResampler.toString()));
  const node = new AudioWorkletNode(context, 'vrt-capture', {
    numberOfOutputs: 0,
    processorOptions: { rate: sampleRate, frame: Math.round((sampleRate * frameMs) / 1000) },
  });
  node.port.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => onFrame(new Uint8Array(data));
  const source = context.createMediaStreamSource(stream);
  source.connect(node);
  await context.resume();
  return {
    async stop() {
      for (const track of stream.getTracks()) track.stop();
      source.disconnect();
      node.port.onmessage = null;
      await context.close();
    },
  };
}
