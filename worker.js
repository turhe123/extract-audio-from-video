// worker.js — encodes decoded PCM to MP3 (lamejs) or 16-bit WAV off the main thread.
// In:  { format: 'mp3' | 'wav', kbps, sampleRate, channels: Float32Array[] }  (1 or 2 channels)
// Out: { type: 'progress', done, total } … then { type: 'done', parts: Uint8Array[] } or { type: 'error', message }
/* global lamejs */
importScripts('vendor/lamejs/lame.min.js');

const CHUNK = 1152; // one MP3 frame of samples per channel

function toInt16(src, start, end) {
  const out = new Int16Array(end - start);
  for (let i = start, j = 0; i < end; i++, j++) {
    const s = Math.max(-1, Math.min(1, src[i]));
    out[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function encodeMp3({ kbps, sampleRate, channels }) {
  const enc = new lamejs.Mp3Encoder(channels.length, sampleRate, kbps);
  const total = channels[0].length;
  const parts = [];
  let lastPost = 0;
  for (let i = 0; i < total; i += CHUNK) {
    const end = Math.min(total, i + CHUNK);
    const left = toInt16(channels[0], i, end);
    const buf = channels.length > 1 ? enc.encodeBuffer(left, toInt16(channels[1], i, end)) : enc.encodeBuffer(left);
    if (buf.length) parts.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.length).slice());
    if (end - lastPost >= CHUNK * 64 || end === total) { lastPost = end; postMessage({ type: 'progress', done: end, total }); }
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Uint8Array(tail.buffer, tail.byteOffset, tail.length).slice());
  return parts;
}

function encodeWav({ sampleRate, channels }) {
  const n = channels.length;
  const frames = channels[0].length;
  const dataBytes = frames * n * 2;
  const header = new DataView(new ArrayBuffer(44));
  const ascii = (off, s) => { for (let i = 0; i < s.length; i++) header.setUint8(off + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF'); header.setUint32(4, 36 + dataBytes, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, n, true);
  header.setUint32(24, sampleRate, true); header.setUint32(28, sampleRate * n * 2, true);
  header.setUint16(32, n * 2, true); header.setUint16(34, 16, true);
  ascii(36, 'data'); header.setUint32(40, dataBytes, true);
  const parts = [new Uint8Array(header.buffer)];
  const step = CHUNK * 256;
  for (let i = 0; i < frames; i += step) {
    const end = Math.min(frames, i + step);
    const block = new Int16Array((end - i) * n);
    for (let c = 0; c < n; c++) {
      const src = channels[c];
      for (let f = i, k = c; f < end; f++, k += n) {
        const s = Math.max(-1, Math.min(1, src[f]));
        block[k] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
    }
    parts.push(new Uint8Array(block.buffer));
    postMessage({ type: 'progress', done: end, total: frames });
  }
  return parts;
}

self.onmessage = (e) => {
  try {
    const parts = e.data.format === 'wav' ? encodeWav(e.data) : encodeMp3(e.data);
    postMessage({ type: 'done', parts }, parts.map((p) => p.buffer));
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
