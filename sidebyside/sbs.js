import { $, el, initPage, pickFiles, codecSummary, fmtTime, parseTime, CommandPanel, server, toast, MediaFile, even, clamp, debounce, loadImage, TONEMAP, round3 } from '../assets/common.js';
import { EncodePanel, fmtSec } from '../assets/encode.js';
import { Scrubber } from '../assets/scrubber.js';
import { CropBox } from '../assets/cropbox.js';
import { ExportButton, exportComposite } from '../assets/browserexport.js';

initPage({ root: '../', active: 'sidebyside' });

const cards = { a: makeCard('a', 'A'), b: makeCard('b', 'B') };
const custom = { W: 0, H: 0, a: { x: 0, y: 0, w: 0 }, b: { x: 0, y: 0, w: 0 } };
const state = { outEdited: false, otime: 0 };
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
const enc = new EncodePanel($('#encode'), { onChange: () => { syncExt(); refresh(); } });
const cmd = new CommandPanel($('#cmd'));
cmd.getCommands = () => (bothReady() ? [buildArgs()] : []);
cmd.getJobs = () => (bothReady() && cards.a.mf.isServer && cards.b.mf.isServer)
  ? [{ label: `side by side: ${cards.a.mf.name} + ${cards.b.mf.name}`, args: buildArgs(), output: $('#out').value, duration: duration() }] : [];
const exp = new ExportButton(cmd.actions, {
  run: async ({ onProgress, ctl }) => {
    const L = layout();
    const labelsOn = $('#labels').checked;
    const layer = (card, r, d) => ({ mf: card.mf, start: card.start, crop: r, dest: d, label: labelsOn ? card.label.trim() : '' });
    const audio = $('#audio').value;
    const blob = await exportComposite({
      layers: [layer(cards.a, L.ra, L.pa), layer(cards.b, L.rb, L.pb)], W: L.W, H: L.H, fps: fps(), duration: duration(),
      bg: $('#bg').value, fontSize: Math.max(8, +$('#fontsize').value || 36), audioFrom: audio === 'a' ? 0 : audio === 'b' ? 1 : null,
      enc, onProgress, ctl,
    });
    return [blob, $('#out').value.split('/').pop()];
  },
});
exp.enabled = false;

for (const id of ['layout', 'size', 'gap', 'bg', 'cW', 'cH', 'aX', 'aY', 'aW', 'bX', 'bY', 'bW', 'dur', 'fps', 'audio', 'labels', 'fontsize']) {
  $('#' + id).addEventListener('input', ev => { if (id === 'layout') onLayoutChange(); else if (['cW', 'cH', 'aX', 'aY', 'aW', 'bX', 'bY', 'bW'].includes(id)) readCustomInputs(); refresh(); });
}
$('#out').addEventListener('input', () => { state.outEdited = true; cmd.refresh(); });
$('#orange').addEventListener('input', () => { state.otime = $('#orange').value / 1000 * duration(); $('#otime').value = fmtTime(state.otime); seekLive(); renderPreview(); });
$('#otime').addEventListener('change', () => { const t = parseTime($('#otime').value); if (!isNaN(t)) { state.otime = clamp(t, 0, duration()); updateOutScrub(); seekLive(); renderPreview(); } });
$('#oplay').onclick = toggleLive;
document.addEventListener('keydown', e => {
  if (e.code !== 'Space' || e.target.closest('input, select, textarea, button')) return;
  e.preventDefault();
  toggleLive();
});

// ---------- combined playback: both card videos play together and are drawn on the canvas ----------
const live = { on: false };

async function toggleLive() {
  if (live.on) { stopLive(); return; }
  if (!bothReady()) return;
  const D = duration();
  if (state.otime >= D - 0.02) state.otime = 0;
  const btn = $('#oplay');
  btn.disabled = true;
  try {
    await Promise.all([cards.a.scrub.prime(cards.a.start + state.otime), cards.b.scrub.prime(cards.b.start + state.otime)]);
    const audio = $('#audio').value;
    live.on = true;
    btn.textContent = '❚❚';
    await Promise.all([cards.a.scrub.play(cards.a.start + D, { onTick: liveTick }), cards.b.scrub.play(cards.b.start + D)]);
    cards.a.scrub.video.muted = audio !== 'a';
    cards.b.scrub.video.muted = audio !== 'b';
  } catch (e) { toast(e.message, true); stopLive(); }
  finally { btn.disabled = false; }
}

function liveTick() {
  if (!live.on) return;
  const va = cards.a.scrub.video, vb = cards.b.scrub.video;
  const D = duration();
  state.otime = clamp(va.currentTime - cards.a.start, 0, D);
  const tb = cards.b.start + state.otime;
  if (!vb.seeking && Math.abs(vb.currentTime - tb) > 0.06) vb.currentTime = tb;
  updateOutScrub();
  drawComposite(layout(), va, vb);
  if (!cards.a.scrub.playing || !cards.b.scrub.playing || state.otime >= D - 0.01) stopLive();
}

function seekLive() {
  if (!live.on) return;
  cards.a.scrub.video.currentTime = cards.a.start + state.otime;
  cards.b.scrub.video.currentTime = cards.b.start + state.otime;
}

function stopLive() {
  if (live.on) state.otime = clamp(cards.a.scrub.video.currentTime - cards.a.start, 0, duration());
  live.on = false;
  for (const c of [cards.a, cards.b]) { c.scrub.stop(); c.scrub.video.muted = true; }
  $('#oplay').textContent = '▶';
  updateOutScrub();
  renderPreview();
}

function makeCard(key, title) {
  const card = { key, mf: null, info: null, start: 0, end: null, label: '' };
  const root = el('div', { class: 'card vidcard' });
  card.nameEl = el('span', { class: 'mono small' });
  card.infoEl = el('span', { class: 'small muted' });
  card.startEl = el('input', { type: 'text', class: 'mono w-s', value: '0' });
  card.endEl = el('input', { type: 'text', class: 'mono w-s', placeholder: 'end' });
  card.labelEl = el('input', { type: 'text', class: 'w-m', placeholder: title === 'A' ? 'e.g. Ours' : 'e.g. Baseline' });
  card.cropEls = ['x', 'y', 'w', 'h'].map(k => el('input', { type: 'number', class: 'w-s', step: 2, min: 0, title: k }));
  const scrubHost = el('div');
  root.append(
    el('div', { class: 'row between', style: { marginBottom: '8px' } },
      el('div', { class: 'row' }, el('b', {}, title), el('button', { class: 'btn primary sm', onclick: async () => { const [mf] = await pickFiles({ title: `Choose video ${title}` }); if (mf) loadCard(card, mf); } }, 'Choose…'), card.nameEl),
      card.infoEl),
    scrubHost,
    el('div', { class: 'row', style: { marginTop: '8px' } },
      el('label', { class: 'field' }, el('span', {}, 'Start'), el('div', { class: 'row', style: { gap: '4px' } }, card.startEl,
        el('button', { class: 'btn sm', title: 'use the current frame as the start', onclick: () => { card.startEl.value = String(round3(card.scrub.time)); onStartChange(card); } }, 'here'))),
      el('label', { class: 'field' }, el('span', {}, 'End'), el('div', { class: 'row', style: { gap: '4px' } }, card.endEl,
        el('button', { class: 'btn sm', title: 'use the current frame as the end', onclick: () => { card.endEl.value = String(round3(card.scrub.time)); onEndChange(card); } }, 'here'),
        el('button', { class: 'btn sm', title: 'clear the end (play to the end of the file)', onclick: () => { card.endEl.value = ''; onEndChange(card); } }, '✕'))),
      el('label', { class: 'field' }, el('span', {}, 'Crop x, y, w, h'), el('div', { class: 'row', style: { gap: '4px' } }, card.cropEls,
        el('button', { class: 'btn sm', onclick: () => card.crop.reset() }, 'full'))),
      el('label', { class: 'field' }, el('span', {}, 'Label'), card.labelEl),
    ),
  );
  card.scrub = new Scrubber(scrubHost, { width: 960 });
  card.scrub.onStop = () => { if (live.on) stopLive(); };
  card.crop = new CropBox(card.scrub.wrap, { onChange: r => { fillCrop(card, r); refresh(); } });
  card.startEl.addEventListener('change', () => onStartChange(card));
  card.endEl.addEventListener('change', () => onEndChange(card));
  card.labelEl.addEventListener('input', () => { card.label = card.labelEl.value; refresh(); });
  card.cropEls.forEach(i => i.addEventListener('change', () => card.crop.setRect({ x: +card.cropEls[0].value, y: +card.cropEls[1].value, w: +card.cropEls[2].value, h: +card.cropEls[3].value })));
  $('#cards').append(root);
  return card;
}

function onStartChange(card) {
  const t = parseTime(card.startEl.value);
  card.start = isNaN(t) ? 0 : Math.max(0, t);
  card.startEl.value = String(round3(card.start));
  if (card.end != null && card.end <= card.start) { card.end = null; card.endEl.value = ''; }
  refresh();
}

function onEndChange(card) {
  const t = parseTime(card.endEl.value);
  card.end = isNaN(t) || t <= card.start ? null : t;
  card.endEl.value = card.end == null ? '' : String(round3(card.end));
  refresh();
}

function cardEnd(card) { return Math.min(card.end ?? Infinity, card.info?.duration ?? Infinity); }

function fillCrop(card, r) { if (r) [r.x, r.y, r.w, r.h].forEach((v, i) => { card.cropEls[i].value = v; }); }

async function loadCard(card, mf, { start = null } = {}) {
  stopLive();
  card.mf = mf; card.info = null;
  card.end = null; card.endEl.value = '';
  card.nameEl.textContent = mf.name;
  card.infoEl.textContent = '';
  card.crop.show(false);
  const info = await card.scrub.setFile(mf, { time: start || 0 });
  if (!info?.video) { toast(`${mf.name}: no video stream`, true); return; }
  card.info = info;
  card.infoEl.textContent = `${codecSummary(info)} · ${fmtTime(info.duration, false)}`;
  card.crop.setNatural(info.video.width, info.video.height);
  card.crop.show(true);
  fillCrop(card, card.crop.getRect());
  if (start != null) { card.startEl.value = String(round3(start)); card.start = start; }
  if (!state.outEdited && cards.a.mf && cards.b.mf) $('#out').value = defaultOut();
  if (bothReady() && $('#layout').value === 'custom') initCustom();
  refresh();
}

function defaultOut() {
  const a = cards.a.mf, b = cards.b.mf;
  const name = `${a.stem}_vs_${b.stem}.${enc.ext}`;
  return a.isServer ? `${a.dir}/${name}` : name;
}
function syncExt() { if (!state.outEdited && $('#out').value) $('#out').value = $('#out').value.replace(/\.[^.\/]+$/, '.' + enc.ext); }
function bothReady() { return !!(cards.a.info && cards.b.info); }

function cropOf(card) { return card.crop.getRect() || { x: 0, y: 0, w: card.info.video.width, h: card.info.video.height }; }

function layout() {
  if (!bothReady()) return null;
  const ra = cropOf(cards.a), rb = cropOf(cards.b);
  const gap = Math.max(0, +$('#gap').value || 0);
  const mode = $('#layout').value;
  let W, H, pa, pb;
  if (mode === 'h') {
    const h = even(+$('#size').value || Math.min(ra.h, rb.h));
    const wa = even(ra.w * h / ra.h), wb = even(rb.w * h / rb.h);
    W = wa + gap + wb; H = h;
    pa = { x: 0, y: 0, w: wa, h }; pb = { x: wa + gap, y: 0, w: wb, h };
  } else if (mode === 'v') {
    const w = even(+$('#size').value || Math.min(ra.w, rb.w));
    const ha = even(ra.h * w / ra.w), hb = even(rb.h * w / rb.w);
    W = w; H = ha + gap + hb;
    pa = { x: 0, y: 0, w, h: ha }; pb = { x: 0, y: ha + gap, w, h: hb };
  } else {
    if (!custom.W) initCustom();
    W = even(custom.W); H = even(custom.H);
    pa = { x: custom.a.x, y: custom.a.y, w: even(custom.a.w), h: even(custom.a.w * ra.h / ra.w) };
    pb = { x: custom.b.x, y: custom.b.y, w: even(custom.b.w), h: even(custom.b.w * rb.h / rb.w) };
  }
  return { W: even(W), H: even(H), pa, pb, ra, rb };
}

function initCustom() {
  const prev = $('#layout').value;
  $('#layout').value = 'h';
  const L = layout();
  $('#layout').value = prev;
  if (!L) return;
  custom.W = L.W; custom.H = L.H;
  custom.a = { x: L.pa.x, y: L.pa.y, w: L.pa.w }; custom.b = { x: L.pb.x, y: L.pb.y, w: L.pb.w };
  writeCustomInputs();
}
function writeCustomInputs() {
  $('#cW').value = custom.W; $('#cH').value = custom.H;
  $('#aX').value = custom.a.x; $('#aY').value = custom.a.y; $('#aW').value = custom.a.w;
  $('#bX').value = custom.b.x; $('#bY').value = custom.b.y; $('#bW').value = custom.b.w;
}
function readCustomInputs() {
  custom.W = +$('#cW').value || custom.W; custom.H = +$('#cH').value || custom.H;
  custom.a = { x: +$('#aX').value || 0, y: +$('#aY').value || 0, w: +$('#aW').value || custom.a.w };
  custom.b = { x: +$('#bX').value || 0, y: +$('#bY').value || 0, w: +$('#bW').value || custom.b.w };
}
function onLayoutChange() {
  const mode = $('#layout').value;
  $('#customRow').classList.toggle('hidden', mode !== 'custom');
  $('#sizeField').classList.toggle('hidden', mode === 'custom');
  $('#dragHint').classList.toggle('hidden', mode !== 'custom');
  $('#sizeLabel').textContent = mode === 'v' ? 'Width' : 'Height';
  if (mode === 'custom' && bothReady()) initCustom();
}

function autoDuration() {
  if (!bothReady()) return 0;
  return Math.max(0, Math.min(cardEnd(cards.a) - cards.a.start, cardEnd(cards.b) - cards.b.start));
}
function duration() { return +$('#dur').value || autoDuration(); }
function fps() { return +$('#fps').value || Math.max(cards.a.info?.video?.fps || 0, cards.b.info?.video?.fps || 0) || 30; }

const dtEsc = s => s.replace(/\\/g, '\\\\').replace(/'/g, '’').replace(/%\{/g, '% {').replace(/:/g, '\\:');

function buildArgs() {
  const L = layout();
  const args = ['-y'];
  if (cards.a.start > 0) args.push('-ss', fmtSec(cards.a.start));
  args.push('-i', cards.a.mf.inputArg);
  if (cards.b.start > 0) args.push('-ss', fmtSec(cards.b.start));
  args.push('-i', cards.b.mf.inputArg);
  const fs = Math.max(8, +$('#fontsize').value || 36);
  const labelsOn = $('#labels').checked;
  const chain = (idx, card, r, p) => {
    const f = [`[${idx}:v]crop=${r.w}:${r.h}:${r.x}:${r.y}`];
    if (card.info.video.hdr && enc.opts.tonemap !== 'off') f.push(TONEMAP);
    f.push(`scale=${p.w}:${p.h}`, 'setsar=1');
    if (labelsOn && card.label.trim()) {
      f.push(`drawtext=text='${dtEsc(card.label.trim())}':font=Sans:fontsize=${fs}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=${Math.round(fs / 4)}:x=${Math.round(fs / 2)}:y=${Math.round(fs / 2)}`);
    }
    return f.join(',');
  };
  const bg = '0x' + $('#bg').value.replace('#', '');
  const fc = [
    chain(0, cards.a, L.ra, L.pa) + '[a]',
    chain(1, cards.b, L.rb, L.pb) + '[b]',
    `color=c=${bg}:s=${L.W}x${L.H}:r=${fps()}[bg]`,
    `[bg][a]overlay=${L.pa.x}:${L.pa.y}:shortest=1[t]`,
    `[t][b]overlay=${L.pb.x}:${L.pb.y}:shortest=1,format=yuv420p[v]`,
  ].join(';');
  args.push('-filter_complex', fc, '-map', '[v]');
  const audio = $('#audio').value;
  if (audio === 'a') args.push('-map', '0:a:0?', ...enc.audioArgs(cards.a.info));
  else if (audio === 'b') args.push('-map', '1:a:0?', ...enc.audioArgs(cards.b.info));
  else args.push('-an');
  const hdr = cards.a.info.video.hdr || cards.b.info.video.hdr;
  args.push('-t', fmtSec(duration()), ...enc.videoCodecArgs({ video: { hdr } }), ...enc.containerArgs(), $('#out').value);
  return args;
}

function updateOutScrub() {
  const D = duration();
  state.otime = clamp(state.otime, 0, D);
  $('#orange').value = D ? Math.round(state.otime / D * 1000) : 0;
  $('#otime').value = fmtTime(state.otime);
  $('#odur').textContent = `/ ${fmtTime(D)}`;
}

function refresh() {
  const L = layout();
  $('#outsize').textContent = L ? `Output ${L.W}×${L.H} @ ${fps()} fps · ${fmtTime(duration(), false)} long (A from ${fmtTime(cards.a.start)}, B from ${fmtTime(cards.b.start)})` : 'Choose two videos.';
  if ($('#layout').value === 'custom' && L) writeCustomInputs();
  for (const c of [cards.a, cards.b]) if (c.info) c.scrub.setRange(c.start, Math.min(c.start + duration(), cardEnd(c)));
  updateOutScrub();
  cmd.refresh();
  exp.enabled = !!L;
  $('#oplay').disabled = !L;
  renderPreview();
}

const frameCache = new Map();
async function frameImg(card, t) {
  const key = `${card.mf.id}|${t.toFixed(3)}`;
  if (!frameCache.has(key)) {
    if (frameCache.size > 60) frameCache.clear();
    frameCache.set(key, card.mf.frame(clamp(t, 0, Math.max(0, card.info.duration - 0.01)), 960).then(loadImage));
  }
  return frameCache.get(key);
}

let renderSeq = 0;
const renderPreview = debounce(async () => {
  const L = layout();
  const seq = ++renderSeq;
  if (!L) {
    canvas.width = 640; canvas.height = 200;
    ctx.fillStyle = '#111'; ctx.fillRect(0, 0, 640, 200);
    ctx.fillStyle = '#888'; ctx.font = '16px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('Choose video A and video B', 320, 105);
    return;
  }
  let ia = null, ib = null;
  try {
    [ia, ib] = await Promise.all([frameImg(cards.a, cards.a.start + state.otime), frameImg(cards.b, cards.b.start + state.otime)]);
  } catch { /* draw what we have */ }
  if (seq !== renderSeq || live.on) return;
  drawComposite(L, ia, ib);
}, 120);

/* srcA/srcB are frame images or <video> elements. */
function drawComposite(L, srcA, srcB) {
  if (!L) return;
  if (canvas.width !== L.W || canvas.height !== L.H) { canvas.width = L.W; canvas.height = L.H; }
  ctx.fillStyle = $('#bg').value; ctx.fillRect(0, 0, L.W, L.H);
  const draw = (src, card, r, p) => {
    const sw = src?.naturalWidth || src?.videoWidth;
    if (!sw) { ctx.fillStyle = '#333'; ctx.fillRect(p.x, p.y, p.w, p.h); return; }
    const k = sw / card.info.video.width;
    ctx.drawImage(src, r.x * k, r.y * k, r.w * k, r.h * k, p.x, p.y, p.w, p.h);
    if ($('#labels').checked && card.label.trim()) {
      const fs = Math.max(8, +$('#fontsize').value || 36);
      ctx.font = `${fs}px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      const pad = Math.round(fs / 4), tw = ctx.measureText(card.label.trim()).width;
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(p.x + fs / 2 - pad, p.y + fs / 2 - pad, tw + pad * 2, fs * 1.15 + pad * 2);
      ctx.fillStyle = '#fff'; ctx.fillText(card.label.trim(), p.x + fs / 2, p.y + fs / 2);
    }
  };
  draw(srcA, cards.a, L.ra, L.pa);
  draw(srcB, cards.b, L.rb, L.pb);
}

// dragging videos on the preview in custom mode
let drag = null;
canvas.addEventListener('pointerdown', e => {
  if ($('#layout').value !== 'custom') return;
  const L = layout(); if (!L) return;
  const k = canvas.width / canvas.clientWidth;
  const x = e.offsetX * k, y = e.offsetY * k;
  const hit = (p) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h;
  const key = hit(L.pb) ? 'b' : hit(L.pa) ? 'a' : null;
  if (!key) return;
  drag = { key, x0: x, y0: y, sx: custom[key].x, sy: custom[key].y };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e => {
  if (!drag) return;
  const k = canvas.width / canvas.clientWidth;
  custom[drag.key].x = Math.round((drag.sx + (e.offsetX * k - drag.x0)) / 2) * 2;
  custom[drag.key].y = Math.round((drag.sy + (e.offsetY * k - drag.y0)) / 2) * 2;
  refresh();
});
canvas.addEventListener('pointerup', () => { drag = null; });

// hand-off from the sync tool
(async function restoreHandoff() {
  let h = null;
  try { h = JSON.parse(localStorage.getItem('vt_handoff') || 'null'); } catch { /* ignore */ }
  if (!h || Date.now() - (h.ts || 0) > 3600e3) return;
  localStorage.removeItem('vt_handoff');
  const a = MediaFile.fromJSON(h.a), b = MediaFile.fromJSON(h.b);
  $('#handoff').textContent = `from Sync: A starts at ${fmtTime(h.startA)}, B at ${fmtTime(h.startB)}`;
  if (!a || !b) { toast(`Pick the files again. A start ${h.startA}s, B start ${h.startB}s`); cards.a.startEl.value = h.startA; cards.a.start = h.startA; cards.b.startEl.value = h.startB; cards.b.start = h.startB; return; }
  if (!server.connected) await new Promise(res => document.addEventListener('vt:server', res, { once: true }));
  if (!server.connected) { toast('Server not connected, cannot reopen the files', true); return; }
  await Promise.all([loadCard(cards.a, a, { start: h.startA }), loadCard(cards.b, b, { start: h.startB })]);
  refresh();
})();

onLayoutChange();
refresh();
