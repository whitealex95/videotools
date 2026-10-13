import { el, clamp, fmtTime, parseTime, debounce, toast } from './common.js';

/* Frame preview with a time slider. Frames come from MediaFile.frame(), so it works for files the browser cannot play. */
export class Scrubber {
  constructor(container, { width = 640, onTime = null, onFrame = null, showControls = true } = {}) {
    this.width = width;
    this.onTime = onTime;
    this.onFrame = onFrame;
    this.mf = null;
    this.info = null;
    this.time = 0;
    this.fps = 30;
    this.img = el('img', { alt: '' });
    this.wrap = el('div', { class: 'frame-wrap' }, this.img);
    this.range = el('input', { type: 'range', min: 0, max: 1000, step: 1, value: 0, disabled: true });
    this.timeInput = el('input', { type: 'text', class: 'mono w-s', value: '0:00.000', title: 'time (m:ss.mmm or seconds)' });
    this.timeLabel = el('span', { class: 'time muted' });
    this.range.addEventListener('input', () => this.seek(this.range.value / 1000 * this.duration, { fromSlider: true }));
    this.timeInput.addEventListener('change', () => {
      const t = parseTime(this.timeInput.value);
      if (isNaN(t)) { this.timeInput.value = fmtTime(this.time); return; }
      this.seek(t);
    });
    const step = n => el('button', { class: 'btn sm', title: `${n > 0 ? '+' : ''}${n} frame`, onclick: () => this.step(n) }, n < 0 ? (n === -1 ? '‹' : '«') : (n === 1 ? '›' : '»'));
    this.band = el('div', { class: 'range-band hidden' }, el('span', { class: 'mark start' }), el('span', { class: 'mark end' }));
    this.rangeWrap = el('div', { class: 'range-wrap' }, this.band, this.range);
    this.controls = el('div', { class: 'controls' }, step(-10), step(-1), this.timeInput, step(1), step(10), this.rangeWrap, this.timeLabel);
    this._range = null;
    this.root = el('div', { class: 'scrubber' }, this.wrap, showControls && this.controls);
    container.append(this.root);
    this._load = debounce(() => this._loadFrame(), 120);
    this._seq = 0;
  }

  get duration() { return this.info?.duration || 0; }

  async setFile(mf, { time = 0 } = {}) {
    this.mf = mf;
    this.info = null;
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
    if (immediate) this._loadFrame(); else this._load();
  }

  step(frames) { this.seek(this.time + frames / this.fps); }

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
    this.band.classList.toggle('narrow', (b - a) * this.rangeWrap.clientWidth < 60);
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
      if (seq === this._seq) this.wrap.classList.remove('loading');
    }
  }
}
