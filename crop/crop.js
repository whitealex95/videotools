import { $, el, initPage, pickFiles, codecSummary, fmtTime, parseTime, CommandPanel, outputPath, toast, frameStepButtons, arrowKeyStep, clamp } from '../assets/common.js';
import { EncodePanel } from '../assets/encode.js';
import { Scrubber } from '../assets/scrubber.js';
import { CropBox, cropFilter } from '../assets/cropbox.js';
import { ExportButton, exportSingle, exportComposite, textRect } from '../assets/browserexport.js';
import { TextOverlays } from '../assets/textoverlay.js';

initPage({ root: '../', active: 'crop' });

const state = { mf: null, info: null, outEdited: false };
const scrub = new Scrubber($('#scrub'), { width: 1280 });
const crop = new CropBox(scrub.wrap, { onChange: r => { fillInputs(r); refresh(); } });
const enc = new EncodePanel($('#encode'), { onChange: () => { syncExt(); refresh(); } });
const texts = new TextOverlays($('#texts'), $('#addText'), { onChange: () => refresh() });
texts.getSize = outputSize;
const textCanvas = el('canvas', { class: 'text-canvas hidden' });
scrub.wrap.append(textCanvas);
const tctx = textCanvas.getContext('2d');
new ResizeObserver(() => drawTexts()).observe(scrub.wrap);
const cmd = new CommandPanel($('#cmd'));
cmd.getCommands = () => state.info ? [buildArgs()] : [];
cmd.getJobs = () => state.info && state.mf.isServer ? [{ label: `crop ${state.mf.name}`, args: buildArgs(), output: $('#out').value, duration: trimDuration() ?? state.info.duration }] : [];
const exp = new ExportButton(cmd.actions, {
  run: async ({ onProgress, ctl }) => {
    const rect = crop.isFull() ? null : crop.getRect();
    let blob;
    if (texts.active().length) {
      const S = outputSize();
      const ss = trimStart() || 0;
      blob = await exportComposite({
        layers: [{ mf: state.mf, start: ss, crop: rect || { x: 0, y: 0, w: state.info.video.width, h: state.info.video.height }, dest: { x: 0, y: 0, w: S.W, h: S.H }, label: '' }],
        W: S.W, H: S.H, fps: enc.opts.fps || state.info.video.fps || 30, duration: trimDuration() ?? Math.max(0, state.info.duration - ss),
        texts: texts.active(), audioFrom: enc.opts.amode === 'none' ? null : 0, enc, onProgress, ctl,
      });
    } else {
      blob = await exportSingle({ mf: state.mf, enc, crop: rect, ss: trimStart(), duration: trimDuration(), onProgress, ctl });
    }
    return [blob, $('#out').value.split('/').pop()];
  },
});
exp.enabled = false;

$('#pick').onclick = async () => { const [mf] = await pickFiles({ title: 'Choose a video to crop' }); if (mf) load(mf); };
$('#reset').onclick = () => crop.reset();
$('#aspect').onchange = () => { const [a, b] = $('#aspect').value.split(':').map(Number); crop.setAspect(a && b ? a / b : null); };
for (const id of ['cx', 'cy', 'cw', 'ch']) $('#' + id).addEventListener('change', () => {
  crop.setRect({ x: +$('#cx').value, y: +$('#cy').value, w: +$('#cw').value, h: +$('#ch').value });
});
$('#setstart').onclick = () => { $('#tstart').value = fmtTime(scrub.time); refresh(); };
$('#setend').onclick = () => { $('#tend').value = fmtTime(scrub.time); refresh(); };
$('#cleartrim').onclick = () => { $('#tstart').value = ''; $('#tend').value = ''; refresh(); };
for (const id of ['tstart', 'tend']) $('#' + id).addEventListener('change', refresh);
$('#setstart').before(...frameStepButtons(n => nudgeTrim('tstart', n), { title: 'start' }));
$('#setend').before(...frameStepButtons(n => nudgeTrim('tend', n), { title: 'end' }));
arrowKeyStep($('#tstart'), n => nudgeTrim('tstart', n));
arrowKeyStep($('#tend'), n => nudgeTrim('tend', n));

function nudgeTrim(id, frames) {
  if (!state.info) return;
  const cur = parseTime($('#' + id).value);
  const base = isNaN(cur) ? (id === 'tstart' ? 0 : state.info.duration) : cur;
  const t = clamp(base + frames / scrub.fps, 0, state.info.duration);
  $('#' + id).value = fmtTime(t);
  scrub.seek(t);
  refresh();
}
$('#out').addEventListener('input', () => { state.outEdited = true; refresh(); });

async function load(mf) {
  state.mf = mf; state.info = null; state.outEdited = false;
  $('#fname').textContent = mf.name;
  $('#finfo').textContent = '';
  crop.show(false);
  const info = await scrub.setFile(mf);
  if (!info?.video) { toast('No video stream found', true); return; }
  state.info = info;
  $('#finfo').textContent = `${codecSummary(info)} · ${fmtTime(info.duration, false)}`;
  crop.setNatural(info.video.width, info.video.height);
  crop.show(true);
  fillInputs(crop.getRect());
  $('#out').value = outputPath(mf, '_crop', enc.ext);
  refresh();
}

function fillInputs(r) {
  if (!r) return;
  $('#cx').value = r.x; $('#cy').value = r.y; $('#cw').value = r.w; $('#ch').value = r.h;
}

function syncExt() {
  if (!state.mf || state.outEdited) return;
  $('#out').value = $('#out').value.replace(/\.[^.\/]+$/, '.' + enc.ext);
}

function trimStart() { const t = parseTime($('#tstart').value); return isNaN(t) || t <= 0 ? null : t; }
function trimDuration() {
  const end = parseTime($('#tend').value);
  if (isNaN(end)) return null;
  return Math.max(0, end - (trimStart() || 0));
}

/* Output size in pixels after the crop and the max-width scale, as ffmpeg produces it. */
function outputSize() {
  if (!state.info) return null;
  const r = crop.getRect() || { w: state.info.video.width, h: state.info.video.height };
  const W = enc.opts.maxWidth ? Math.min(enc.opts.maxWidth, r.w) : r.w;
  const H = W === r.w ? r.h : Math.round(r.h * W / r.w / 2) * 2;
  return { W, H };
}

function buildArgs() {
  const vf = crop.isFull() ? [] : [cropFilter(crop.getRect())];
  return enc.buildArgs({ input: state.mf.inputArg, output: $('#out').value, info: state.info, vf, vfAfter: texts.filters(), ss: trimStart(), duration: trimDuration() });
}

/* Draws the texts on a canvas laid over the crop region, scaled from output pixels to screen pixels. */
function drawTexts() {
  const S = outputSize();
  const active = S ? texts.active() : [];
  textCanvas.classList.toggle('hidden', !active.length);
  if (!active.length) return;
  const r = crop.getRect(), s = crop.scale;
  Object.assign(textCanvas.style, { left: `${r.x * s}px`, top: `${r.y * s}px`, width: `${r.w * s}px`, height: `${r.h * s}px` });
  if (textCanvas.width !== S.W || textCanvas.height !== S.H) { textCanvas.width = S.W; textCanvas.height = S.H; }
  // keep every text inside the output, otherwise it could become unreachable after a smaller crop
  let moved = false;
  for (const t of texts.items) {
    const r = textRect(texts.measureCtx, { ...t, text: t.text.trim() || 'x' });
    const x = clamp(t.x, 0, Math.max(0, S.W - (r.w - 2 * r.pad))), y = clamp(t.y, 0, Math.max(0, S.H - (r.h - 2 * r.pad)));
    if (x !== t.x || y !== t.y) { t.x = x; t.y = y; moved = true; }
  }
  if (moved) texts.syncRows();
  tctx.clearRect(0, 0, S.W, S.H);
  texts.draw(tctx);
}

// dragging a text on the frame takes priority over the crop box
let tdrag = null;
function textPos(e) {
  const S = outputSize(); if (!S) return null;
  const b = textCanvas.getBoundingClientRect();
  if (!b.width) return null;
  const k = S.W / b.width;
  return { x: (e.clientX - b.left) * k, y: (e.clientY - b.top) * k };
}
scrub.wrap.addEventListener('pointerdown', e => {
  if (e.button !== 0 || textCanvas.classList.contains('hidden')) return;
  const p = textPos(e); if (!p) return;
  const t = texts.hitTest(p.x, p.y); if (!t) return;
  e.stopPropagation(); e.preventDefault();
  tdrag = { t, x0: p.x, y0: p.y, sx: t.x, sy: t.y };
  try { scrub.wrap.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
}, true);
scrub.wrap.addEventListener('pointermove', e => {
  if (!tdrag) return;
  e.stopPropagation();
  const p = textPos(e); if (!p) return;
  tdrag.t.x = Math.max(0, Math.round(tdrag.sx + p.x - tdrag.x0));
  tdrag.t.y = Math.max(0, Math.round(tdrag.sy + p.y - tdrag.y0));
  texts.syncRows();
  refresh();
}, true);
for (const ev of ['pointerup', 'pointercancel']) scrub.wrap.addEventListener(ev, e => { if (tdrag) { tdrag = null; e.stopPropagation(); } }, true);

function refresh() {
  const note = $('#encnote');
  const hasFilters = !crop.isFull() || texts.active().length > 0;
  if (state.info && hasFilters && !enc.needsVideoEncode(state.info, { hasFilters: true })) {
    note.textContent = 'Video mode is "copy", so the crop and texts cannot be applied. Choose "always re-encode".';
  } else note.textContent = '';
  const s = trimStart() || 0, d = trimDuration();
  scrub.setRange(s || d != null ? s : null, d != null ? s + d : null);
  drawTexts();
  cmd.refresh();
  exp.enabled = !!state.info;
}
