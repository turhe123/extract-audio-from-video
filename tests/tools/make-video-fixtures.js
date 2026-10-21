// Generates the fictional video fixtures with headless Chromium (canvas + WebAudio -> MediaRecorder, MP4 / VP9 + Opus).
//   node tests/tools/make-video-fixtures.js
// sample-video.mp4: 12 s "Sample Video", a moving colour bar and a three tone melody (C5, E5, G5).
// silent-video.mp4: 3 s, the same picture with no audio track at all.
const fs = require('fs');
const path = require('path');
const home = process.env.WEBFACTORY_HOME;
const { chromium } = require(home ? path.join(home, 'node_modules/playwright-core') : 'playwright-core');

async function record(page, seconds, withAudio) {
  return page.evaluate(async ({ seconds, withAudio }) => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    document.body.appendChild(canvas);
    const g = canvas.getContext('2d');
    const t0 = performance.now();
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      g.fillStyle = '#1b1d2a'; g.fillRect(0, 0, 320, 180);
      const hue = (t * 30) % 360;
      g.fillStyle = `hsl(${hue} 80% 55%)`;
      g.fillRect(((t / seconds) * 360) % 360 - 40, 60, 80, 60);
      g.fillStyle = '#fff'; g.font = 'bold 20px sans-serif'; g.fillText('Sample Video', 12, 30);
      g.font = '14px sans-serif'; g.fillText(`${t.toFixed(1)} s`, 12, 165);
    };
    draw();
    const timer = setInterval(draw, 1000 / 15);
    const stream = canvas.captureStream(15);
    let ctx;
    if (withAudio) {
      ctx = new AudioContext({ sampleRate: 48000 });
      await ctx.resume();
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.3;
      osc.type = 'triangle';
      osc.connect(gain).connect(dest);
      const notes = [523.25, 659.25, 783.99];
      const start = ctx.currentTime + 0.05;
      for (let i = 0; i < seconds * 2; i++) osc.frequency.setValueAtTime(notes[i % 3], start + i * 0.5);
      osc.start(start);
      dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
    }
    const mime = withAudio ? 'video/mp4;codecs=vp9,opus' : 'video/mp4;codecs=vp9';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 120_000, audioBitsPerSecond: 48_000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((r) => { rec.onstop = r; });
    rec.start(1000);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    rec.stop();
    await done;
    clearInterval(timer);
    if (ctx) await ctx.close();
    const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, { seconds, withAudio });
}

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.goto('about:blank');
  const out = path.join(__dirname, '..', 'fixtures');
  for (const [name, secs, audio] of [['sample-video.mp4', 12, true], ['silent-video.mp4', 3, false]]) {
    const b64 = await record(page, secs, audio);
    fs.writeFileSync(path.join(out, name), Buffer.from(b64, 'base64'));
    console.log(name, fs.statSync(path.join(out, name)).size, 'bytes');
  }
  await browser.close();
})();
