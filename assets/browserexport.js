import { server, el, toast } from './common.js';

/* In-browser video export with WebCodecs, through the mediabunny library. No ffmpeg, no server. */

const MB_URL = 'https://cdn.jsdelivr.net/npm/mediabunny@1.60.0/dist/bundles/mediabunny.min.mjs';
let mbPromise = null;
export function mb() { return (mbPromise ??= import(MB_URL)); }

export function browserExportSupported() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
}

function sourceFor(mf, M) {
  if (mf.file) return new M.BlobSource(mf.file);
  return new M.UrlSource(server.mediaUrl(mf.path));
}

export async function openInput(mf) {
  const M = await mb();
  const input = new M.Input({ formats: M.ALL_FORMATS, source: sourceFor(mf, M) });
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  if (!video) throw new Error(`${mf.name}: no video track`);
  if (!(await video.canDecode())) throw new Error(`${mf.name}: this browser cannot decode ${video.codec || 'this codec'}`);
  return { M, input, video, audio };
}

export function qualityFor(M, crf) {
  if (crf <= 18) return M.QUALITY_VERY_HIGH;
  if (crf <= 23) return M.QUALITY_HIGH;
  if (crf <= 28) return M.QUALITY_MEDIUM;
  return M.QUALITY_LOW;
}

async function audioCodecFor(M, track) {
  return M.getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: track.numberOfChannels, sampleRate: track.sampleRate });
}

function outputFor(M, container) {
  const format = container === 'mkv' ? new M.MkvOutputFormat()
    : container === 'mov' ? new M.MovOutputFormat({ fastStart: 'in-memory' })
      : new M.Mp4OutputFormat({ fastStart: 'in-memory' });
  return new M.Output({ format, target: new M.BufferTarget() });
}

function codecFor(encoder) {
  return /hevc|265/.test(encoder) ? 'hevc' : 'avc';
}

/* One input to one output: crop, resize, fps, trim, re-encode. Mirrors EncodePanel.buildArgs for the browser. */
export async function exportSingle({ mf, enc, crop = null, ss = null, duration = null, onProgress = null, ctl = null }) {
  const { M, input, video, audio } = await openInput(mf);
  const o = enc.opts;
  const output = outputFor(M, o.container);
  const videoOpts = { codec: codecFor(o.encoder), quality: qualityFor(M, o.quality) };
  if (crop) videoOpts.crop = { left: crop.x, top: crop.y, width: crop.w, height: crop.h };
  if (o.maxWidth) { videoOpts.width = Math.min(o.maxWidth, crop ? crop.w : await video.getDisplayWidth()); videoOpts.fit = 'contain'; }
  if (o.fps) videoOpts.frameRate = o.fps;
  if (o.vmode === 'reencode') videoOpts.forceTranscode = true;
  // {} lets mediabunny copy the audio when the container allows it and transcode otherwise.
  const audioOpts = o.amode === 'none' || !audio ? { discard: true } : {};
  if (o.amode === 'aac' && audio) {
    const codec = await audioCodecFor(M, audio);
    if (codec) audioOpts.codec = codec; else audioOpts.discard = true;
  }
  const trim = {};
  if (ss) trim.start = ss;
  if (duration) trim.end = (ss || 0) + duration;
  const conversion = await M.Conversion.init({ input, output, video: videoOpts, audio: audioOpts, trim: Object.keys(trim).length ? trim : undefined });
  if (!conversion.isValid) {
    const why = conversion.discardedTracks.map(d => `${d.track.type}: ${d.reason}`).join(', ');
    throw new Error(`cannot convert in this browser (${why})`);
  }
  conversion.onProgress = p => onProgress?.(p);
  if (ctl) ctl.cancel = () => conversion.cancel();
  await conversion.execute();
  return new Blob([output.target.buffer], { type: mime(o.container) });
}

/* Pulls decoded frames in order and returns the frame shown at a given time. */
class FrameCursor {
  constructor(sink, start, end) {
    this.gen = sink.samples(Math.max(0, start), end);
    this.cur = null;
    this.next = null;
    this.done = false;
  }
  async _pull() {
    const r = await this.gen.next();
    if (r.done) { this.done = true; return null; }
    return r.value;
  }
  async at(t) {
    if (!this.cur) { this.cur = await this._pull(); if (!this.cur) return null; }
    while (!this.done) {
      if (!this.next) this.next = await this._pull();
      if (!this.next || this.next.timestamp > t + 1e-4) break;
      this.cur.close();
      this.cur = this.next;
      this.next = null;
    }
    return this.cur;
  }
  close() { this.cur?.close(); this.next?.close(); this.gen.return?.(); }
}

/* Several inputs composed on one canvas: the browser version of the side-by-side filter graph. */
export async function exportComposite({ layers, W, H, fps, duration, bg = '#000000', fontSize = 36, audioFrom = null, enc, onProgress = null, ctl = null }) {
  const M = await mb();
  const opened = await Promise.all(layers.map(l => openInput(l.mf)));
  const o = enc.opts;
  const output = outputFor(M, o.container);
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const videoSource = new M.CanvasSource(canvas, { codec: codecFor(o.encoder), quality: qualityFor(M, o.quality) });
  output.addVideoTrack(videoSource, { frameRate: fps });

  let audioSink = null, audioSource = null, audioStart = 0;
  const aud = audioFrom != null ? opened[audioFrom].audio : null;
  const audioCodec = aud && await aud.canDecode() ? await audioCodecFor(M, aud) : null;
  if (aud && !audioCodec) toast('This browser cannot encode audio, exporting without sound', true);
  if (audioCodec) {
    audioSource = new M.AudioSampleSource({ codec: audioCodec, bitrate: 160e3 });
    output.addAudioTrack(audioSource);
    audioSink = new M.AudioSampleSink(aud);
    audioStart = layers[audioFrom].start || 0;
  }
  await output.start();

  const cursors = opened.map((op, i) => new FrameCursor(new M.VideoSampleSink(op.video), layers[i].start || 0, (layers[i].start || 0) + duration + 1));
  let cancelled = false;
  if (ctl) ctl.cancel = () => { cancelled = true; };
  const n = Math.max(1, Math.round(duration * fps));
  try {
    for (let i = 0; i < n; i++) {
      if (cancelled) throw new Error('cancelled');
      const t = i / fps;
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      for (let k = 0; k < layers.length; k++) {
        const L = layers[k];
        const s = await cursors[k].at((L.start || 0) + t);
        if (!s) continue;
        const r = L.crop, d = L.dest;
        s.draw(ctx, r.x, r.y, r.w, r.h, d.x, d.y, d.w, d.h);
        if (L.label) drawLabel(ctx, L.label, d.x, d.y, fontSize);
      }
      await videoSource.add(t, 1 / fps);
      if (i % 5 === 0) onProgress?.(i / n);
    }
    if (audioSink) {
      for await (const sample of audioSink.samples(audioStart, audioStart + duration)) {
        if (cancelled) throw new Error('cancelled');
        sample.setTimestamp(Math.max(0, sample.timestamp - audioStart));
        await audioSource.add(sample);
        sample.close();
      }
    }
    await output.finalize();
  } finally {
    cursors.forEach(c => c.close());
    if (cancelled) output.cancel?.();
  }
  onProgress?.(1);
  return new Blob([output.target.buffer], { type: mime(o.container) });
}

export function drawLabel(ctx, text, x, y, fs) {
  ctx.font = `${fs}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const pad = Math.round(fs / 4), tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(0,0,0,.5)';
  ctx.fillRect(x + fs / 2 - pad, y + fs / 2 - pad, tw + pad * 2, fs * 1.15 + pad * 2);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, x + fs / 2, y + fs / 2);
}

function mime(container) { return container === 'mkv' ? 'video/x-matroska' : container === 'mov' ? 'video/quicktime' : 'video/mp4'; }

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* Button + progress bar that drives one export function. `run` receives ({onProgress, ctl}) and returns [blob, filename]. */
export class ExportButton {
  constructor(container, { label = 'Export in browser', run }) {
    this.run = run;
    this.btn = el('button', { class: 'btn', onclick: () => this.start(), title: 'Decode and encode inside this browser with WebCodecs, then download. No server or ffmpeg needed.' }, label);
    this.cancelBtn = el('button', { class: 'btn sm danger hidden', onclick: () => this.ctl?.cancel?.() }, 'cancel');
    this.bar = el('div', { class: 'progress hidden', style: { width: '160px' } }, el('i'));
    this.msg = el('span', { class: 'small muted' });
    this.root = el('span', { class: 'row', style: { gap: '8px' } }, this.btn, this.cancelBtn, this.bar, this.msg);
    container.append(this.root);
    if (!browserExportSupported()) { this.btn.disabled = true; this.msg.textContent = 'This browser has no WebCodecs (use Chrome or Edge).'; }
  }
  set enabled(v) { if (browserExportSupported()) this.btn.disabled = !v; }
  async start() {
    this.ctl = {};
    this.btn.disabled = true;
    this.cancelBtn.classList.remove('hidden');
    this.bar.classList.remove('hidden');
    this.bar.className = 'progress';
    this.msg.textContent = 'starting…';
    const t0 = performance.now();
    try {
      const res = await this.run({
        onProgress: (p, note = '') => { this.bar.firstChild.style.width = `${Math.round(p * 100)}%`; this.msg.textContent = `${Math.round(p * 100)}% ${note}`; },
        ctl: this.ctl,
      });
      this.bar.classList.add('done');
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      if (Array.isArray(res)) {
        const [blob, name] = res;
        downloadBlob(blob, name);
        this.msg.textContent = `done in ${secs}s · ${(blob.size / 1048576).toFixed(1)} MB → ${name}`;
      } else this.msg.textContent = `${res} (${secs}s)`;
    } catch (e) {
      this.bar.classList.add('failed');
      this.msg.textContent = e.message;
      toast(e.message, true);
    } finally {
      this.btn.disabled = false;
      this.cancelBtn.classList.add('hidden');
    }
  }
}
