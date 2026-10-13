import { $, initPage, pickFiles, codecSummary, fmtTime, parseTime, CommandPanel, outputPath, toast } from '../assets/common.js';
import { EncodePanel } from '../assets/encode.js';
import { Scrubber } from '../assets/scrubber.js';
import { CropBox, cropFilter } from '../assets/cropbox.js';

initPage({ root: '../', active: 'crop' });

const state = { mf: null, info: null, outEdited: false };
const scrub = new Scrubber($('#scrub'), { width: 1280 });
const crop = new CropBox(scrub.wrap, { onChange: r => { fillInputs(r); refresh(); } });
const enc = new EncodePanel($('#encode'), { onChange: () => { syncExt(); refresh(); } });
const cmd = new CommandPanel($('#cmd'));
cmd.getCommands = () => state.info ? [buildArgs()] : [];
cmd.getJobs = () => state.info && state.mf.isServer ? [{ label: `crop ${state.mf.name}`, args: buildArgs(), output: $('#out').value, duration: trimDuration() ?? state.info.duration }] : [];

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

function buildArgs() {
  const vf = crop.isFull() ? [] : [cropFilter(crop.getRect())];
  return enc.buildArgs({ input: state.mf.inputArg, output: $('#out').value, info: state.info, vf, ss: trimStart(), duration: trimDuration() });
}

function refresh() {
  const note = $('#encnote');
  if (state.info && !crop.isFull() && !enc.needsVideoEncode(state.info, { hasFilters: true })) {
    note.textContent = 'Video mode is "copy", so the crop cannot be applied. Choose "always re-encode".';
  } else note.textContent = '';
  cmd.refresh();
}
