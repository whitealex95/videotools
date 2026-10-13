import { $, $$, el, initPage, pickFiles, makeDropZone, fmtBytes, fmtTime, codecSummary, CommandPanel, jobsStore, server, debounce } from '../assets/common.js';
import { EncodePanel } from '../assets/encode.js';
import { ExportButton, exportSingle, downloadBlob } from '../assets/browserexport.js';

initPage({ root: '../', active: 'convert' });

const rows = [];
const tbody = $('#files tbody');
const enc = new EncodePanel($('#encode'), { onChange: refresh });
const cmd = new CommandPanel($('#cmd'), { scriptMode: true });

cmd.getCommands = () => ready().map(buildArgs);
cmd.getPrelude = () => {
  const dirs = new Set(ready().filter(r => !r.mf.isServer).map(r => outDir(r)).filter(Boolean));
  return [...dirs].map(d => `mkdir -p '${d}'`).join('\n');
};
cmd.getJobs = () => ready().filter(r => r.mf.isServer).map(r => ({
  label: r.mf.name, args: buildArgs(r), output: outPath(r), duration: r.info.duration, meta: { id: r.mf.id },
}));
const exp = new ExportButton(cmd.actions, {
  label: 'Export all in browser',
  run: async ({ onProgress, ctl }) => {
    const list = ready();
    let done = 0, failed = 0;
    for (const r of list) {
      if (ctl.cancelled) break;
      r.browserStatus = 'exporting';
      refresh();
      const sub = {};
      ctl.cancel = () => { ctl.cancelled = true; sub.cancel?.(); };
      try {
        const blob = await exportSingle({ mf: r.mf, enc, onProgress: p => onProgress((done + p) / list.length, `${r.mf.name}`), ctl: sub });
        downloadBlob(blob, outName(r));
        r.browserStatus = 'downloaded';
      } catch (e) {
        r.browserStatus = `failed: ${e.message}`;
        failed++;
      }
      done++;
      refresh();
    }
    onProgress(1);
    return `${done - failed} of ${list.length} downloaded${failed ? `, ${failed} failed` : ''}`;
  },
});
exp.enabled = false;

cmd.onRun = (ids, jobs) => {
  jobs.forEach((j, i) => { const r = rows.find(x => x.mf.id === j.meta.id); if (r) { r.jobId = ids[i]; r.exists = false; } });
  refresh();
};

$('#add').onclick = async () => addFiles(await pickFiles({ multiple: true, title: 'Choose videos to convert' }));
$('#clear').onclick = () => { rows.length = 0; refresh(); };
makeDropZone($('#dropzone'), addFiles);
for (const id of ['pattern', 'find', 'replace', 'regex', 'outdir']) $('#' + id).addEventListener('input', refresh);
$$('input[name=outmode]').forEach(r => r.addEventListener('change', refresh));
document.addEventListener('vt:jobs', updateProgress);

function ready() { return rows.filter(r => r.info); }
function outMode() { return $('input[name=outmode]:checked').value; }

async function addFiles(files) {
  for (const mf of files) {
    if (mf.isServer && rows.some(r => r.mf.path === mf.path)) continue;
    const row = { mf, info: null, error: null, jobId: null, exists: false };
    rows.push(row);
    if (!$('#outdir').value) $('#outdir').value = mf.isServer ? `${mf.dir}/converted` : 'converted';
    mf.probe().then(info => { row.info = info; refresh(); }, e => { row.error = e.message; refresh(); });
  }
  refresh();
}

function ymd(d) { return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; }
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function outName(r) {
  const i = rows.indexOf(r) + 1;
  let stem = r.mf.stem;
  const find = $('#find').value;
  if (find) {
    try { stem = stem.replace(new RegExp($('#regex').checked ? find : escapeRe(find), 'g'), $('#replace').value); }
    catch { /* invalid regex while typing */ }
  }
  const date = r.info?.mtime ? new Date(r.info.mtime * 1000) : new Date(r.mf.file?.lastModified || Date.now());
  const name = ($('#pattern').value || '{name}')
    .replace(/\{name\}/g, stem).replace(/\{nnn\}/g, String(i).padStart(3, '0')).replace(/\{nn\}/g, String(i).padStart(2, '0'))
    .replace(/\{n\}/g, String(i)).replace(/\{date\}/g, ymd(date)).replace(/\{ext\}/g, r.mf.ext);
  return `${name}.${enc.ext}`;
}

function outDir(r) {
  if (outMode() === 'dir') return $('#outdir').value.trim().replace(/\/+$/, '') || (r.mf.isServer ? r.mf.dir : 'converted');
  return r.mf.isServer ? r.mf.dir : '';
}

function outPath(r) {
  const dir = outDir(r);
  let p = dir ? `${dir}/${outName(r)}` : outName(r);
  if (r.mf.isServer && p === r.mf.path) p = p.replace(/\.[^.]+$/, `_converted.${enc.ext}`);
  return p;
}

function buildArgs(r) { return enc.buildArgs({ input: r.mf.inputArg, output: outPath(r), info: r.info }); }

function statusCell(r) {
  if (r.error) return el('span', { class: 'badge err', title: r.error }, 'error');
  if (!r.info) return el('span', { class: 'muted small' }, 'probing…');
  const job = r.jobId && jobsStore.byId(r.jobId);
  if (job) {
    const pct = Math.round((job.progress || 0) * 100);
    return el('div', {},
      el('div', { class: 'small' }, job.status === 'running' ? `${pct}% ${job.speed || ''}` : job.status),
      el('div', { class: `progress ${job.status}` }, el('i', { style: { width: `${job.status === 'done' ? 100 : pct}%` } })));
  }
  const badges = [];
  if (r.browserStatus) badges.push(el('span', { class: `badge ${r.browserStatus === 'downloaded' ? 'ok' : r.browserStatus.startsWith('failed') ? 'err' : 'accent'}`, title: r.browserStatus }, r.browserStatus.split(':')[0]));
  const willCopy = !enc.needsVideoEncode(r.info);
  badges.push(willCopy ? el('span', { class: 'badge ok', title: 'video stream is copied, no quality loss' }, 'copy') : el('span', { class: 'badge accent' }, 're-encode'));
  if (r.info.video?.hdr) badges.push(el('span', { class: 'badge warn' }, 'HDR'));
  if (r.exists) badges.push(el('span', { class: 'badge warn', title: 'output file exists and will be overwritten' }, 'overwrite'));
  return el('div', { class: 'row', style: { gap: '4px' } }, badges);
}

function refresh() {
  $('#empty').classList.toggle('hidden', rows.length > 0);
  $('#count').textContent = rows.length ? `${rows.length} file${rows.length > 1 ? 's' : ''} · ${fmtBytes(rows.reduce((s, r) => s + (r.mf.size || 0), 0))}` : '';
  const outs = rows.map(outPath);
  const dups = new Set(outs.filter((o, i) => outs.indexOf(o) !== i));
  tbody.replaceChildren(...rows.map((r, i) => el('tr', {},
    el('td', { class: 'muted' }, i + 1),
    el('td', {}, el('div', {}, r.mf.name), el('div', { class: 'small muted mono' }, r.mf.isServer ? r.mf.dir : 'local file')),
    el('td', { class: 'small muted' }, r.info ? `${codecSummary(r.info)} · ${fmtTime(r.info.duration, false)} · ${fmtBytes(r.info.size)}` : (r.error || '')),
    el('td', {}, statusCell(r)),
    el('td', {}, el('span', { class: 'mono small', style: dups.has(outs[i]) ? { color: 'var(--err)' } : {} }, outName(r))),
    el('td', {}, el('button', { class: 'btn sm icon', title: 'remove', onclick: () => { rows.splice(rows.indexOf(r), 1); refresh(); } }, '✕')),
  )));
  $('#warn').textContent = dups.size ? 'Two or more files would get the same output name. Add {n} to the pattern.' : '';
  cmd.refresh();
  exp.enabled = ready().length > 0;
  checkExists();
}

const checkExists = debounce(async () => {
  if (!server.connected) return;
  const srv = rows.filter(r => r.mf.isServer && !r.jobId);
  if (!srv.length) return;
  try {
    const res = await server.stat(srv.map(outPath));
    let changed = false;
    res.forEach((s, i) => { if (srv[i].exists !== !!s.exists) { srv[i].exists = !!s.exists; changed = true; } });
    if (changed) refresh();
  } catch { /* ignore */ }
}, 400);

function updateProgress() {
  if (rows.some(r => r.jobId)) {
    $$('tbody tr', $('#files')).forEach((tr, i) => { if (rows[i]?.jobId) tr.children[3].replaceChildren(statusCell(rows[i])); });
  }
}
