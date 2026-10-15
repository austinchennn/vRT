import { AUDIO_HEADER_BYTES, type AudioFrameHeader } from './messages.js';

export interface AudioFrame extends AudioFrameHeader {
  /** A view into the received buffer; never copied. */
  payload: Uint8Array;
}

/** Writes `[kind u8][seq u32 BE]` into the first five bytes of `frame`. */
export function writeAudioHeader(frame: Uint8Array, kind: 1 | 2, seq: number): void {
  frame[0] = kind;
  new DataView(frame.buffer, frame.byteOffset, AUDIO_HEADER_BYTES).setUint32(1, seq >>> 0, false);
}

/** Builds one binary frame. For zero-copy sending, allocate `AUDIO_HEADER_BYTES + n`, fill the payload and call `writeAudioHeader`. */
export function encodeAudioFrame(kind: 1 | 2, seq: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(AUDIO_HEADER_BYTES + payload.byteLength);
  writeAudioHeader(frame, kind, seq);
  frame.set(payload, AUDIO_HEADER_BYTES);
  return frame;
}

/** Decodes a binary frame without copying its payload. Returns undefined for malformed frames; never throws. */
export function decodeAudioFrame(data: Uint8Array | ArrayBuffer): AudioFrame | undefined {
  const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : undefined;
  if (bytes === undefined || bytes.byteLength < AUDIO_HEADER_BYTES) return undefined;
  const kind = bytes[0];
  if (kind !== 1 && kind !== 2) return undefined;
  const seq = new DataView(bytes.buffer, bytes.byteOffset, AUDIO_HEADER_BYTES).getUint32(1, false);
  return { kind, seq, payload: bytes.subarray(AUDIO_HEADER_BYTES) };
}
