import { el, clamp, fmtTime, parseTime, debounce, toast, proxyUrl } from './common.js';

/* Frame preview with a time slider. Frames come from MediaFile.frame(), so it works for files the browser cannot play.
   Playback uses a <video> element laid over the frame image, with a server-made proxy as a fallback. */
export class Scrubber {
  constructor(container, { width = 640, onTime = null, onFrame = null, showControls = true } = {}) {
    this.width = width;
    this.onTime = onTime;
    this.onFrame = onFrame;
    this.mf = null;
    this.info = null;
    this.time = 0;
    this.fps = 30;
    this.playing = false;
    this.onStop = null;
    this.img = el('img', { alt: '' });
    this.video = el('video', { muted: true, playsinline: true, preload: 'auto' });
    this.video.muted = true;
    this.video.addEventListener('pause', () => { if (this.playing) this.stop(); });
    this.wrap = el('div', { class: 'frame-wrap' }, this.img, this.video);
    this.range = el('input', { type: 'range', min: 0, max: 1000, step: 1, value: 0, disabled: true });
    this.timeInput = el('input', { type: 'text', class: 'mono w-s', value: '0:00.000', title: 'time (m:ss.mmm or seconds)' });
    this.timeLabel = el('span', { class: 'time muted' });
    this.playBtn = el('button', { class: 'btn sm play', title: 'play / pause (plays the marked range when one is set)', onclick: () => this.togglePlay() }, '▶');
    this.range.addEventListener('input', () => this.seek(this.range.value / 1000 * this.duration, { fromSlider: true }));
    this.timeInput.addEventListener('change', () => {
      const t = parseTime(this.timeInput.value);
      if (isNaN(t)) { this.timeInput.value = fmtTime(this.time); return; }
      this.seek(t);
    });
    const step = n => el('button', { class: 'btn sm', title: `${n > 0 ? '+' : ''}${n} frame`, onclick: () => this.step(n) }, n < 0 ? (n === -1 ? '‹' : '«') : (n === 1 ? '›' : '»'));
    this.band = el('div', { class: 'range-band hidden' }, el('span', { class: 'mark start' }), el('span', { class: 'mark end' }));
    // The band lives on a track inset by half the slider thumb, so 0% and 100% line up with the thumb's end positions.
    this.bandTrack = el('div', { class: 'range-band-track' }, this.band);
    this.rangeWrap = el('div', { class: 'range-wrap' }, this.bandTrack, this.range);
    this.controls = el('div', { class: 'controls' }, this.playBtn, step(-10), step(-1), this.timeInput, step(1), step(10), this.rangeWrap, this.timeLabel);
    this._range = null;
    this.root = el('div', { class: 'scrubber' }, this.wrap, showControls && this.controls);
    container.append(this.root);
    this._load = debounce(() => this._loadFrame(), 120);
    this._seq = 0;
    this._videoReady = null;
  }

  get duration() { return this.info?.duration || 0; }

  async setFile(mf, { time = 0 } = {}) {
    this.stop();
    this.mf = mf;
    this.info = null;
    this._videoReady = null;
    this.video.removeAttribute('src');
    this.video.load();
    this.img.removeAttribute('src');
    this.wrap.classList.add('loading');
    try {
      this.info = await mf.probe();
    } catch (e) { toast(`Cannot read ${mf.name}: ${e.message}`, true); this.wrap.classList.remove('loading'); return null; }
    this.fps = this.info.video?.fps || 30;
    this.range.disabled = false;
    this._renderRange();
    this.seek(time, { immediate: true });
    return this.info;
  }

  seek(t, { fromSlider = false, immediate = false } = {}) {
    if (!this.info) return;
    this.time = clamp(t, 0, Math.max(0, this.duration - 0.01));
    if (!fromSlider) this.range.value = this.duration ? Math.round(this.time / this.duration * 1000) : 0;
    this.timeInput.value = fmtTime(this.time);
    this.timeLabel.textContent = `/ ${fmtTime(this.duration)}`;
    this.onTime?.(this.time);
    if (this.playing) { this.video.currentTime = this.time; return; }
    if (immediate) this._loadFrame(); else this._load();
  }

  step(frames) { this.stop(); this.seek(this.time + frames / this.fps); }

  /* Highlights [start, end] on the slider. Pass null to hide. */
  setRange(start, end) {
    this._range = start == null ? null : { start, end };
    this._renderRange();
  }

  _renderRange() {
    const r = this._range;
    if (!r || !this.duration) { this.band.classList.add('hidden'); return; }
    const a = clamp(r.start / this.duration, 0, 1), b = clamp((r.end ?? this.duration) / this.duration, 0, 1);
    this.band.classList.remove('hidden');
    this.band.style.left = `${a * 100}%`;
    this.band.style.width = `${Math.max(0, b - a) * 100}%`;
    this.band.title = `${fmtTime(r.start)} – ${fmtTime(r.end ?? this.duration)}`;
    this.band.classList.toggle('narrow', (b - a) * this.bandTrack.clientWidth < 60);
  }

  // ---------- playback ----------

  /* Resolves with the <video> once it can play this file, making a proxy when the browser cannot decode it. */
  ensureVideo() {
    if (!this.mf) return Promise.reject(new Error('no file'));
    if (!this._videoReady) {
      const v = this.video;
      const open = url => new Promise((res, rej) => {
        const done = () => { cleanup(); res(v); };
        const fail = () => { cleanup(); rej(new Error('cannot decode')); };
        const cleanup = () => { v.removeEventListener('loadeddata', done); v.removeEventListener('error', fail); };
        v.addEventListener('loadeddata', done); v.addEventListener('error', fail);
        v.src = url; v.load();
      });
      this._videoReady = open(this.mf.playbackUrl()).catch(async () => {
        toast(`${this.mf.name}: the browser cannot play this file, making a preview proxy…`);
        const url = await proxyUrl(this.mf, p => { this.wrap.dataset.note = `proxy ${Math.round(p * 100)}%`; });
        delete this.wrap.dataset.note;
        return open(url);
      }).catch(e => { this._videoReady = null; throw e; });
    }
    return this._videoReady;
  }

  /* Loads the video and seeks it to t without playing. Call play() next. */
  async prime(t) {
    const v = await this.ensureVideo();
    t = clamp(t, 0, Math.max(0, (v.duration || this.duration) - 0.01));
    if (Math.abs(v.currentTime - t) > 0.001) {
      await new Promise(res => { v.addEventListener('seeked', res, { once: true }); v.currentTime = t; });
    }
    this.wrap.classList.add('video');
    return v;
  }

  /* Plays from the video's current position until `until` (seconds), updating the slider as it goes. */
  async play(until = Infinity, { onTick = null } = {}) {
    const v = await this.ensureVideo();
    this.wrap.classList.add('video');
    this.playing = true;
    this.playBtn.textContent = '❚❚';
    this.video.muted = true;
    await v.play().catch(e => { this.stop(); throw e; });
    const tick = () => {
      if (!this.playing) return;
      this._showTime(v.currentTime);
      onTick?.(v.currentTime);
      if (v.ended || v.currentTime >= until - 0.005) { this.stop(); return; }
      if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
    };
    tick();
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    this.video.pause();
    this.playBtn.textContent = '▶';
    this._showTime(this.video.currentTime);
    this._loadFrame();
    this.onStop?.();
  }

  _showTime(t) {
    this.time = clamp(t, 0, Math.max(0, this.duration - 0.01));
    this.range.value = this.duration ? Math.round(this.time / this.duration * 1000) : 0;
    this.timeInput.value = fmtTime(this.time);
    this.onTime?.(this.time);
  }

  async togglePlay() {
    if (this.playing) { this.stop(); return; }
    if (!this.info) return;
    const r = this._range;
    const until = r ? (r.end ?? this.duration) : this.duration;
    const from = r && (this.time < r.start || this.time >= until - 0.02) ? r.start : (this.time >= this.duration - 0.02 ? 0 : this.time);
    this.playBtn.disabled = true;
    try {
      await this.prime(from);
      await this.play(until);
    } catch (e) { toast(e.message, true); this.stop(); }
    finally { this.playBtn.disabled = false; }
  }

  async _loadFrame() {
    if (!this.mf) return;
    const seq = ++this._seq;
    this.wrap.classList.add('loading');
    try {
      const url = await this.mf.frame(this.time, this.width);
      if (seq !== this._seq) return;
      await new Promise((res, rej) => {
        const img = this.img;
        const onload = () => { cleanup(); res(); };
        const onerror = () => { cleanup(); rej(new Error('frame failed')); };
        const cleanup = () => { img.removeEventListener('load', onload); img.removeEventListener('error', onerror); };
        img.addEventListener('load', onload); img.addEventListener('error', onerror);
        if (this._blobUrl) URL.revokeObjectURL(this._blobUrl);
        this._blobUrl = url.startsWith('blob:') ? url : null;
        img.src = url;
      });
      if (seq !== this._seq) return;
      this.onFrame?.(this.img, this.time);
    } catch (e) {
      if (seq === this._seq) toast(`Could not load a frame: ${e.message}`, true);
    } finally {
      if (seq === this._seq) {
        this.wrap.classList.remove('loading');
        if (!this.playing) this.wrap.classList.remove('video');
      }
    }
  }
}
