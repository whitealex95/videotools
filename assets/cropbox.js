import { el, clamp, even } from './common.js';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/* Draggable crop rectangle drawn over an <img> inside a .frame-wrap. Rect is kept in source pixel coordinates. */
export class CropBox {
  constructor(wrap, { onChange = null } = {}) {
    this.wrap = wrap;
    this.img = wrap.querySelector('img');
    this.onChange = onChange;
    this.natural = { w: 0, h: 0 };
    this.rect = null;
    this.aspect = null;
    this.label = el('span', { class: 'label' });
    this.box = el('div', { class: 'cropbox hidden' }, el('div', { class: 'grid' }), HANDLES.map(h => el('div', { class: `handle h-${h}`, dataset: { h } })), this.label);
    wrap.append(this.box);
    this._drag = null;
    wrap.addEventListener('pointerdown', e => this._down(e));
    wrap.addEventListener('pointermove', e => this._move(e));
    wrap.addEventListener('pointerup', e => this._up(e));
    wrap.addEventListener('pointercancel', e => this._up(e));
    new ResizeObserver(() => this._render()).observe(wrap);
  }

  /* Source size in pixels. The preview image may be smaller; the ratio is derived from the image's rendered size. */
  setNatural(w, h, { keepRect = false } = {}) {
    const changed = w !== this.natural.w || h !== this.natural.h;
    this.natural = { w, h };
    if (!keepRect || !this.rect || changed) this.rect = { x: 0, y: 0, w, h };
    this._render();
  }

  get scale() { return this.natural.w ? this.img.clientWidth / this.natural.w : 1; }

  getRect() { return this.rect ? { ...this.rect } : null; }
  isFull() { const r = this.rect; return !r || (r.x === 0 && r.y === 0 && r.w === this.natural.w && r.h === this.natural.h); }

  setRect(r, { silent = false } = {}) {
    if (!this.natural.w) return;
    const n = this.natural;
    let w = clamp(even(r.w), 2, n.w), h = clamp(even(r.h), 2, n.h);
    let x = clamp(Math.round(r.x / 2) * 2, 0, n.w - w), y = clamp(Math.round(r.y / 2) * 2, 0, n.h - h);
    this.rect = { x, y, w, h };
    this._render();
    if (!silent) this.onChange?.(this.getRect());
  }

  setAspect(ratio) {
    this.aspect = ratio || null;
    if (this.aspect && this.rect) {
      const r = this.rect;
      let w = r.w, h = Math.round(w / this.aspect);
      if (h > this.natural.h) { h = this.natural.h; w = Math.round(h * this.aspect); }
      this.setRect({ x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h });
    }
  }

  reset() { if (this.natural.w) this.setRect({ x: 0, y: 0, w: this.natural.w, h: this.natural.h }); }
  show(v) { this.box.classList.toggle('hidden', !v || !this.rect); }

  _render() {
    if (!this.rect || !this.natural.w) return;
    const s = this.scale, r = this.rect;
    Object.assign(this.box.style, { left: `${r.x * s}px`, top: `${r.y * s}px`, width: `${r.w * s}px`, height: `${r.h * s}px` });
    this.label.textContent = `${r.w}×${r.h} @ ${r.x},${r.y}`;
    const nearBottom = (r.y + r.h) * s > this.img.clientHeight - 24;
    this.label.style.top = nearBottom ? 'auto' : '100%';
    this.label.style.bottom = nearBottom ? '100%' : 'auto';
  }

  _pos(e) {
    const b = this.img.getBoundingClientRect();
    const s = this.scale;
    return { x: clamp((e.clientX - b.left) / s, 0, this.natural.w), y: clamp((e.clientY - b.top) / s, 0, this.natural.h) };
  }

  _down(e) {
    if (!this.natural.w || e.button !== 0 || this.box.classList.contains('hidden')) return;
    e.preventDefault();
    this.wrap.setPointerCapture(e.pointerId);
    const p = this._pos(e);
    const handle = e.target.closest('.handle')?.dataset.h;
    if (handle) this._drag = { mode: 'resize', handle, start: p, rect: { ...this.rect } };
    else if (e.target.closest('.cropbox') && !this.isFull()) this._drag = { mode: 'move', start: p, rect: { ...this.rect } };
    else this._drag = { mode: 'draw', start: p, rect: { x: p.x, y: p.y, w: 0, h: 0 } };
  }

  _move(e) {
    const d = this._drag;
    if (!d) return;
    const p = this._pos(e);
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    const n = this.natural;
    if (d.mode === 'move') {
      this.setRect({ x: d.rect.x + dx, y: d.rect.y + dy, w: d.rect.w, h: d.rect.h });
      return;
    }
    let { x, y, w, h } = d.rect;
    let x2 = x + w, y2 = y + h;
    const hd = d.mode === 'draw' ? 'se' : d.handle;
    if (d.mode === 'draw') { x = Math.min(d.start.x, p.x); y = Math.min(d.start.y, p.y); x2 = Math.max(d.start.x, p.x); y2 = Math.max(d.start.y, p.y); }
    else {
      if (hd.includes('w')) x = clamp(d.rect.x + dx, 0, x2 - 2);
      if (hd.includes('e')) x2 = clamp(d.rect.x + d.rect.w + dx, x + 2, n.w);
      if (hd.includes('n')) y = clamp(d.rect.y + dy, 0, y2 - 2);
      if (hd.includes('s')) y2 = clamp(d.rect.y + d.rect.h + dy, y + 2, n.h);
    }
    w = x2 - x; h = y2 - y;
    if (this.aspect) {
      const vertical = hd === 'n' || hd === 's';
      if (vertical) w = h * this.aspect; else h = w / this.aspect;
      if (x + w > n.w) { w = n.w - x; h = w / this.aspect; }
      if (y + h > n.h) { h = n.h - y; w = h * this.aspect; }
      if (hd.includes('w')) x = x2 - w;
      if (hd.includes('n')) y = y2 - h;
    }
    this.setRect({ x, y, w: Math.max(w, 2), h: Math.max(h, 2) });
  }

  _up(e) {
    if (!this._drag) return;
    this._drag = null;
    try { this.wrap.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (this.rect.w < 8 || this.rect.h < 8) this.reset();
  }
}

export function cropFilter(r) {
  return `crop=${r.w}:${r.h}:${r.x}:${r.y}`;
}
