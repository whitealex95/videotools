import { $$, el } from './common.js';
import { drawText, textRect } from './browserexport.js';

const dtEsc = s => s.replace(/\\/g, '\\\\').replace(/'/g, '’').replace(/%\{/g, '% {').replace(/:/g, '\\:');

/* Editable list of text items drawn on an output. x, y are where the text starts, in output pixels (same as ffmpeg drawtext). */
export class TextOverlays {
  constructor(host, addBtn, { onChange = null } = {}) {
    this.host = host;
    this.items = [];
    this.onChange = onChange;
    this.addBtn = addBtn;
    addBtn.addEventListener('click', () => this.add());
    this.getSize = () => null;
    this.measureCtx = document.createElement('canvas').getContext('2d');
  }

  active() { return this.items.filter(t => t.text.trim()).map(t => ({ ...t, text: t.text.trim() })); }

  add() {
    const size = 36;
    const t = { text: 'Text', size, color: '#ffffff', box: true, x: 24, y: 24 };
    const S = this.getSize();
    if (S) {
      const r = textRect(this.measureCtx, t);
      t.x = Math.max(0, Math.round((S.W - r.w) / 2 + r.pad));
      t.y = Math.max(0, Math.round(S.H - r.h - 24 + r.pad) - this.items.length * Math.round(size * 1.6));
    }
    this.items.push(t);
    this.renderRows();
    this.onChange?.();
    this.host.lastElementChild?.querySelector('input[type=text]')?.select();
  }

  renderRows() {
    this.host.replaceChildren(...this.items.map((t, i) => {
      const bind = (input, key, parse = v => v) => {
        input.addEventListener('input', () => { t[key] = parse(input.value); this.onChange?.(); });
        return input;
      };
      const num = (key, title) => bind(el('input', { type: 'number', class: 'w-s', value: t[key], title, min: 0 }), key, v => Math.max(0, Math.round(+v || 0)));
      const box = el('input', { type: 'checkbox' });
      box.checked = t.box;
      box.addEventListener('change', () => { t.box = box.checked; this.onChange?.(); });
      return el('div', { class: 'row textrow', style: { gap: '6px' } },
        bind(el('input', { type: 'text', class: 'w-m', value: t.text, placeholder: 'text' }), 'text'),
        el('label', { class: 'field inline' }, el('span', {}, 'size'), num('size', 'font size (px)')),
        bind(el('input', { type: 'color', value: t.color, title: 'text color' }), 'color'),
        el('label', { class: 'field inline' }, el('span', {}, 'x'), num('x', 'x of the text (px)')),
        el('label', { class: 'field inline' }, el('span', {}, 'y'), num('y', 'y of the text (px)')),
        el('label', { class: 'check', title: 'dark box behind the text' }, box, ' box'),
        el('button', { class: 'btn sm icon', title: 'remove this text', onclick: () => { this.items.splice(i, 1); this.renderRows(); this.onChange?.(); } }, '✕'),
      );
    }));
  }

  /* Writes x and y back into the rows after a drag. */
  syncRows() {
    $$('.textrow', this.host).forEach((row, i) => {
      const t = this.items[i]; if (!t) return;
      const nums = row.querySelectorAll('input[type=number]');
      nums[1].value = t.x; nums[2].value = t.y;
    });
  }

  draw(ctx) { for (const t of this.active()) drawText(ctx, t); }

  /* Topmost item whose box contains (x, y) in output pixels. */
  hitTest(x, y) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const t = this.items[i];
      if (!t.text.trim()) continue;
      const r = textRect(this.measureCtx, { ...t, text: t.text.trim() });
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return t;
    }
    return null;
  }

  /* ffmpeg drawtext filters, one per item. */
  filters() {
    return this.active().map(t => {
      const pad = Math.round(t.size / 4);
      return `drawtext=text='${dtEsc(t.text)}':font=Sans:fontsize=${t.size}:fontcolor=0x${t.color.replace('#', '')}:x=${t.x}:y=${t.y}` +
        (t.box ? `:box=1:boxcolor=black@0.5:boxborderw=${pad}` : '');
    });
  }
}
