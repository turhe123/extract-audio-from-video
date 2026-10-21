// app.js — Extract Audio from Video. Decodes the sound track with Web Audio, encodes MP3/WAV in worker.js.
// Everything runs on the device; nothing is fetched except the fixture loaded by window.__demo.
import { toast, downloadBlob, formatBytes, wireDropzone } from './site.js';

const $ = (id) => document.getElementById(id);
const zone = $('dropzone');
const input = $('file-input');
const results = $('results');
const filePanel = $('file-panel');
const fileName = $('file-name');
const fileInfo = $('file-info');
const wave = $('waveform');
const options = $('options');
const actions = $('actions');
const formatSel = $('format');
const bitrateSel = $('bitrate');
const bitrateField = $('bitrate-field');
const startIn = $('start');
const endIn = $('end');
const monoIn = $('mono');
const extractBtn = $('extract');
const progressWrap = $('progress-wrap');
const progressBar = $('progress');
const progressLabel = $('progress-label');

const MEDIA_EXT = /\.(mp4|m4v|mov|qt|webm|mkv|3gp|3g2|avi|ogv|ogg|oga|opus|m4a|mp3|wav|aac|flac|weba)$/i;
const SIZE_WARN = 1024 ** 3; // ~1 GB: reading the whole file may not fit in memory
const SIZE_MAX = 2 * 1024 ** 3; // a single ArrayBuffer this large fails in most browsers
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const MAX_SECONDS = IS_IOS ? 3600 : 7200; // an hour of 44.1 kHz stereo is ~600 MB of floats

let audioCtx = null;
let state = null; // { file, buffer: AudioBuffer, peaks }
let busy = false;
let loadToken = 0;
let playerUrl = null;

// ---------- helpers ----------
function fmtTime(sec, precise = true) {
  if (!Number.isFinite(sec)) return '';
  const tenths = Math.round(sec * 10);
  const h = Math.floor(tenths / 36000);
  const m = Math.floor((tenths % 36000) / 600);
  const s = (tenths % 600) / 10;
  const ss = precise ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function fmtLong(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

// Accepts "83.5", "1:23.5" and "1:01:23".
function parseTime(text) {
  const t = String(text).trim().replace(',', '.');
  if (!t) return null;
  if (!/^\d+(\.\d+)?$|^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(t)) return NaN;
  return t.split(':').reduce((acc, part) => acc * 60 + parseFloat(part), 0);
}

function baseName(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

function alertBox(message, kind = 'error') {
  const el = document.createElement('div');
  el.className = `alert alert--${kind}`;
  if (kind === 'error') el.setAttribute('role', 'alert');
  el.textContent = message;
  results.appendChild(el);
  return el;
}

function clearErrors() {
  results.querySelectorAll('.alert--error, .alert--warn').forEach((el) => el.remove());
}

function isMedia(file) {
  return /^(video|audio)\//.test(file.type) || MEDIA_EXT.test(file.name);
}

function getCtx() {
  // Created inside the tap/drop handler so Mobile Safari allows it.
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
  }
  return audioCtx;
}

function setLoaded(on) {
  filePanel.hidden = !on;
  options.hidden = !on;
  actions.hidden = !on;
  if (!on) state = null;
}

// Loads metadata through a <video> element: gives the duration before decoding and tells
// "codec not supported" apart from "not a media file" when decodeAudioData fails.
function probeMedia(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
      URL.revokeObjectURL(url);
      resolve(res);
    };
    const timer = setTimeout(() => finish({ playable: false, duration: NaN }), 5000);
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => finish({ playable: true, duration: v.duration });
    v.onerror = () => finish({ playable: false, duration: NaN });
    v.src = url;
  });
}

// Looks inside the container for an audio track. true / false, or null when the container is unknown.
function detectAudioTrack(u8) {
  const type = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // MP4 / MOV / M4A: walk the top-level boxes to the moov box, then look for a 'soun' handler.
  if (u8.length > 12 && ['ftyp', 'moov', 'wide', 'free', 'mdat', 'skip'].includes(type(4))) {
    let off = 0;
    while (off + 8 <= u8.length) {
      let size = dv.getUint32(off);
      const t = type(off + 4);
      if (size === 1 && off + 16 <= u8.length) size = Number(dv.getBigUint64(off + 8));
      else if (size === 0) size = u8.length - off;
      if (size < 8) return null;
      if (t === 'moov') {
        const end = Math.min(u8.length, off + size);
        for (let i = off + 8; i + 16 <= end; i++) {
          if (u8[i] === 0x68 && type(i) === 'hdlr' && type(i + 12) === 'soun') return true;
        }
        return false;
      }
      off += size;
    }
    return null;
  }
  // WebM / Matroska: EBML header, then TrackType elements (0x83) inside Tracks; 2 means audio.
  if (u8.length > 4 && dv.getUint32(0) === 0x1a45dfa3) {
    const limit = Math.min(u8.length, 16 * 1024 * 1024);
    let sawTracks = false;
    for (let i = 4; i + 4 < limit; i++) {
      if (u8[i] === 0x16 && u8[i + 1] === 0x54 && u8[i + 2] === 0xae && u8[i + 3] === 0x6b) sawTracks = true;
      else if (sawTracks && u8[i] === 0x83 && u8[i + 1] === 0x81 && u8[i + 2] === 0x02) return true;
      else if (sawTracks && u8[i] === 0x1f && u8[i + 1] === 0x43 && u8[i + 2] === 0xb6 && u8[i + 3] === 0x75) return false; // first Cluster
    }
    return sawTracks ? false : null;
  }
  return null;
}

// ---------- loading ----------
function handleFiles(files) {
  const media = files.filter(isMedia);
  const rejected = files.filter((f) => !isMedia(f));
  if (media.length) getCtx(); // still inside the user gesture
  results.replaceChildren();
  if (rejected.length) {
    const names = rejected.map((f) => f.name).join(', ');
    alertBox(media.length
      ? `Skipped ${names}: only video and audio files can be used.`
      : `${names} is not a video or audio file. Choose an MP4, MOV, WebM or audio file.`);
  }
  if (!media.length) { setLoaded(false); return; }
  if (media.length > 1) toast(`One file at a time: using ${media[0].name}`);
  return loadFile(media[0]);
}

async function loadFile(file) {
  const token = ++loadToken;
  setLoaded(false);
  progressWrap.hidden = true;
  if (file.size > SIZE_MAX) {
    alertBox(`${file.name} is ${formatBytes(file.size)}, too large to read into this browser's memory. Trim or split the video first (for example with your phone's or computer's video editor), then extract the audio from each part.`);
    return;
  }
  if (file.size > SIZE_WARN) {
    alertBox(`${file.name} is ${formatBytes(file.size)}. Files over about 1 GB may not fit in memory, especially on phones. If the tab runs out of memory, trim the video first.`, 'warn');
  }
  const status = alertBox('', 'info');
  status.innerHTML = '<span class="spinner" aria-hidden="true"></span> <span>Reading the sound track…</span>';
  const ctx = getCtx();
  try {
    const probe = await probeMedia(file);
    if (token !== loadToken) return;
    if (probe.duration > MAX_SECONDS && Number.isFinite(probe.duration)) {
      status.remove();
      alertBox(`This video is ${fmtLong(probe.duration)} long. Decoded sound takes a lot of memory (about 600 MB for every hour of stereo audio), so this browser can handle at most ${fmtLong(MAX_SECONDS)} at once. Trim the video into shorter parts first.`);
      return;
    }
    let data;
    try {
      data = await file.arrayBuffer();
    } catch {
      status.remove();
      alertBox(`${file.name} (${formatBytes(file.size)}) is too large for this browser's memory. Trim the video into shorter parts first, or try a desktop browser.`);
      return;
    }
    if (token !== loadToken) return;
    const hasAudio = detectAudioTrack(new Uint8Array(data));
    if (hasAudio === false) {
      status.remove();
      alertBox(`${file.name} has no sound: it contains no audio track, so there is nothing to extract.`);
      return;
    }
    let buffer;
    try {
      buffer = await ctx.decodeAudioData(data);
    } catch (err) {
      if (token !== loadToken) return;
      status.remove();
      if (err && err.name === 'RangeError') alertBox(`${file.name} is too large to decode in this browser's memory. Trim the video into shorter parts first.`);
      else if (probe.playable) alertBox(`This browser can play ${file.name} but cannot decode its sound codec. Try opening this page in another browser, such as Chrome, Edge, Firefox or Safari.`);
      else alertBox(`${file.name} is in a container or codec this browser does not support. Try an MP4, MOV or WebM file, or open this page in another browser.`);
      return;
    }
    if (token !== loadToken) return;
    status.remove();
    if (!buffer.length) { alertBox(`${file.name} has no sound: its audio track is empty.`); return; }
    state = { file, buffer, peaks: null };
    showFile();
  } catch (err) {
    status.remove();
    alertBox(`Could not read ${file.name}: ${err && err.message || err}`);
  }
}

function showFile() {
  const { file, buffer } = state;
  fileName.textContent = file.name;
  const ch = buffer.numberOfChannels === 1 ? 'mono' : buffer.numberOfChannels === 2 ? 'stereo' : `${buffer.numberOfChannels} channels`;
  fileInfo.innerHTML = '';
  const dur = document.createElement('span');
  dur.id = 'duration';
  dur.dataset.seconds = buffer.duration.toFixed(3);
  dur.textContent = `Duration ${fmtTime(buffer.duration)}`;
  fileInfo.append(dur, ` · ${ch} · ${(buffer.sampleRate / 1000).toFixed(1)} kHz · ${formatBytes(file.size)}`);
  startIn.value = '0:00.0';
  endIn.value = fmtTime(buffer.duration);
  setLoaded(true);
  state.peaks = null;
  drawWave();
  toast('Sound track loaded. Nothing was uploaded.');
}

// ---------- waveform ----------
function computePeaks(buffer, columns) {
  const len = buffer.length;
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const peaks = new Float32Array(columns * 2);
  const per = len / columns;
  for (let x = 0; x < columns; x++) {
    const a = Math.floor(x * per);
    const b = Math.max(a + 1, Math.floor((x + 1) * per));
    const stride = Math.max(1, Math.floor((b - a) / 2000)); // sample long columns sparsely
    let lo = 0, hi = 0;
    for (const d of chans) {
      for (let i = a; i < b && i < len; i += stride) {
        const v = d[i];
        if (v < lo) lo = v; else if (v > hi) hi = v;
      }
    }
    peaks[x * 2] = lo; peaks[x * 2 + 1] = hi;
  }
  return peaks;
}

function drawWave() {
  if (!state || filePanel.hidden) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(wave.clientWidth * dpr));
  const h = Math.max(1, Math.round(wave.clientHeight * dpr));
  if (wave.width !== w || wave.height !== h) { wave.width = w; wave.height = h; }
  if (!state.peaks || state.peaks.length !== w * 2) state.peaks = computePeaks(state.buffer, w);
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim() || '#5b4bdb';
  const muted = css.getPropertyValue('--line-2').trim() || '#c9cdda';
  const g = wave.getContext('2d');
  g.clearRect(0, 0, w, h);
  const dur = state.buffer.duration;
  let s = parseTime(startIn.value); let e = parseTime(endIn.value);
  if (!Number.isFinite(s) || s < 0) s = 0;
  if (!Number.isFinite(e) || e > dur) e = dur;
  const x0 = (s / dur) * w; const x1 = (e / dur) * w;
  let max = 0;
  for (const v of state.peaks) max = Math.max(max, Math.abs(v));
  const scale = (h / 2 - 2 * dpr) / Math.max(max, 0.05);
  const mid = h / 2;
  for (let x = 0; x < w; x++) {
    g.fillStyle = x >= x0 && x <= x1 ? accent : muted;
    const top = mid - state.peaks[x * 2 + 1] * scale;
    const bot = mid - state.peaks[x * 2] * scale;
    g.fillRect(x, top, 1, Math.max(dpr, bot - top));
  }
  wave.setAttribute('aria-label', `Waveform of the audio track, ${fmtTime(dur)} long; selected ${fmtTime(s)} to ${fmtTime(Math.max(s, e))}`);
}

// ---------- extraction ----------
function readRange() {
  const dur = state.buffer.duration;
  let s = parseTime(startIn.value);
  let e = parseTime(endIn.value);
  if (s === null) s = 0;
  if (e === null) e = dur;
  if (Number.isNaN(s) || Number.isNaN(e)) throw new Error('Start and end must be times like 1:05.5 or 65.5.');
  if (e > dur + 0.05) throw new Error(`End is after the end of the audio (${fmtTime(dur)}).`);
  e = Math.min(e, dur);
  if (s >= e) throw new Error('Start must be before end.');
  return [s, e];
}

function setProgress(done, total) {
  const pct = total ? Math.floor((done / total) * 1000) / 10 : 0; // floor: 99.9% never shows as 100%
  progressBar.firstElementChild.style.width = `${pct}%`;
  progressBar.setAttribute('aria-valuenow', String(pct));
  progressLabel.textContent = `Encoding… ${pct.toFixed(1)}%`;
}

function runWorker(msg, transfer) {
  return new Promise((resolve, reject) => {
    const w = new Worker('./worker.js');
    w.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'progress') setProgress(d.done, d.total);
      else { w.terminate(); d.type === 'done' ? resolve(d.parts) : reject(new Error(d.message)); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'The encoder stopped unexpectedly.')); };
    w.postMessage(msg, transfer);
  });
}

async function extract() {
  if (!state || busy) return;
  clearErrors();
  let range;
  try { range = readRange(); } catch (err) { alertBox(err.message); return; }
  const { buffer, file } = state;
  const format = formatSel.value;
  const kbps = Number(bitrateSel.value);
  const mono = monoIn.checked || buffer.numberOfChannels === 1;
  const sr = buffer.sampleRate;
  const a = Math.floor(range[0] * sr);
  const b = Math.min(buffer.length, Math.round(range[1] * sr));
  busy = true;
  extractBtn.disabled = true;
  progressWrap.hidden = false;
  setProgress(0, 1);
  results.querySelector('.eav-result')?.remove();
  try {
    let channels;
    if (mono) {
      const out = new Float32Array(b - a);
      const n = buffer.numberOfChannels;
      for (let c = 0; c < n; c++) {
        const d = buffer.getChannelData(c);
        for (let i = a, j = 0; i < b; i++, j++) out[j] += d[i] / n;
      }
      channels = [out];
    } else {
      channels = [0, 1].map((c) => buffer.getChannelData(c).slice(a, b)); // more than 2 channels: front left/right
    }
    const parts = await runWorker({ format, kbps, sampleRate: sr, channels }, channels.map((c) => c.buffer));
    const blob = new Blob(parts, { type: format === 'wav' ? 'audio/wav' : 'audio/mpeg' });
    showResult(blob, {
      name: `${baseName(file.name)}.${format}`,
      format, kbps, mono, seconds: (b - a) / sr,
    });
    progressLabel.textContent = 'Done: 100%';
  } catch (err) {
    progressWrap.hidden = true;
    alertBox(/memory|allocation|Array buffer/i.test(String(err && err.message))
      ? 'The browser ran out of memory while encoding. Choose a shorter start to end range or mix down to mono.'
      : `Could not encode the audio: ${err && err.message || err}`);
  } finally {
    busy = false;
    extractBtn.disabled = false;
  }
}

function showResult(blob, { name, format, kbps, mono, seconds }) {
  if (playerUrl) URL.revokeObjectURL(playerUrl);
  playerUrl = URL.createObjectURL(blob);
  const card = document.createElement('div');
  card.className = 'result eav-result';
  card.dataset.seconds = seconds.toFixed(3);
  card.innerHTML = `
    <div class="result__meta">
      <p class="result__name"></p>
      <p class="result__info"></p>
    </div>
    <audio class="eav-player" controls preload="metadata"></audio>
    <button class="btn btn--primary eav-download" id="download" type="button"></button>`;
  card.querySelector('.result__name').textContent = name;
  const desc = format === 'mp3' ? `MP3 · ${kbps} kbps` : 'WAV · 16-bit';
  card.querySelector('.result__info').textContent = `${desc} · ${mono ? 'mono' : 'stereo'} · ${fmtTime(seconds)} · ${formatBytes(blob.size)}`;
  const audio = card.querySelector('audio');
  audio.src = playerUrl;
  audio.setAttribute('aria-label', `Preview of ${name}`);
  const btn = card.querySelector('button');
  btn.textContent = `Download ${name}`;
  btn.addEventListener('click', () => downloadBlob(blob, name));
  results.appendChild(card);
  card.scrollIntoView({ block: 'nearest' });
  toast(`${name} is ready (${formatBytes(blob.size)})`);
}

// ---------- wiring ----------
wireDropzone(zone, input, handleFiles);
extractBtn.addEventListener('click', extract);
formatSel.addEventListener('change', () => { bitrateField.hidden = formatSel.value !== 'mp3'; });
[startIn, endIn].forEach((el) => el.addEventListener('input', drawWave));
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawWave, 120); });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawWave);
new MutationObserver(drawWave).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  const t = e.target;
  const tag = t && t.tagName;
  const interactive = t && t.closest && t.closest('button, a, select, textarea, audio, summary, [role="button"], [contenteditable="true"]');
  if (e.key === 'Enter' && state && !options.hidden) {
    if (interactive || (tag === 'INPUT' && !options.contains(t))) return;
    e.preventDefault();
    extract();
  } else if (e.key === ' ' && !interactive && tag !== 'INPUT') {
    const player = results.querySelector('.eav-player');
    if (!player) return;
    e.preventDefault();
    player.paused ? player.play().catch(() => {}) : player.pause();
  }
});

// Called by the factory's screenshot script: loads the bundled demo clip and shows a finished MP3.
window.__demo = async () => {
  const res = await fetch('./tests/fixtures/sample-video.mp4');
  const file = new File([await res.blob()], 'Sample Video.mp4', { type: 'video/mp4' });
  await handleFiles([file]);
  startIn.value = '0:01.0';
  endIn.value = '0:09.0';
  drawWave();
  await extract();
};

export { handleFiles, parseTime, detectAudioTrack };
