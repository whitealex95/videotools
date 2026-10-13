export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'value') node.value = v;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : String(c));
  }
  return node;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const even = n => Math.max(2, Math.round(n / 2) * 2);
export const round3 = n => Math.round(n * 1000) / 1000;

export function fmtBytes(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

export function fmtTime(s, ms = true) {
  if (!isFinite(s)) return '--:--';
  const sign = s < 0 ? '-' : '';
  s = Math.abs(s);
  const m = Math.floor(s / 60), sec = s - m * 60;
  const secStr = ms ? sec.toFixed(3).padStart(6, '0') : String(Math.floor(sec)).padStart(2, '0');
  return `${sign}${m}:${secStr}`;
}

export function parseTime(str) {
  if (typeof str === 'number') return str;
  str = String(str).trim();
  if (!str) return NaN;
  const neg = str.startsWith('-');
  const parts = str.replace(/^-/, '').split(':').map(Number);
  if (parts.some(isNaN)) return NaN;
  const v = parts.reduce((acc, p) => acc * 60 + p, 0);
  return neg ? -v : v;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function shq(a) {
  a = String(a);
  if (/^[A-Za-z0-9_\/.:=+@%,^-]+$/.test(a)) return a;
  if (a.includes("'") && !/["$`\\]/.test(a)) return `"${a}"`;
  return `'${a.replace(/'/g, `'\\''`)}'`;
}

export function argsToShell(args, { multiline = true } = {}) {
  let out = 'ffmpeg';
  args.forEach((a, i) => {
    const brk = multiline && (a === '-i' || a === '-filter_complex' || a === '-vf' || i === args.length - 1);
    out += (brk ? ' \\\n  ' : ' ') + shq(a);
  });
  return out;
}

export const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch { toast('Copy failed (clipboard needs https or localhost)', true); }
}

let toastTimer;
export function toast(msg, isErr = false) {
  let t = $('#vt-toast');
  if (!t) { t = el('div', { id: 'vt-toast', class: 'toast' }); document.body.append(t); }
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), isErr ? 5000 : 2000);
}

function defaultServerUrl() {
  const h = location.hostname;
  if (location.protocol === 'file:' || !h || h.endsWith('jhkim.me') || h.endsWith('github.io')) return 'http://localhost:8765';
  return location.origin;
}

export class Server {
  constructor() {
    const q = new URLSearchParams(location.search);
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('vt_server') || 'null') || {}; } catch { /* ignore */ }
    this.url = q.get('server') || saved.url || defaultServerUrl();
    this.token = q.get('token') || saved.token || '';
    if (q.has('server') || q.has('token')) {
      this.save();
      q.delete('server'); q.delete('token');
      history.replaceState(null, '', location.pathname + (q.size ? '?' + q : '') + location.hash);
    }
    this.info = null;
    this.connected = false;
    this.error = null;
  }
  save() { try { localStorage.setItem('vt_server', JSON.stringify({ url: this.url, token: this.token })); } catch { /* ignore */ } }
  api(path) { return this.url.replace(/\/+$/, '') + path; }
  withToken(url) { return this.token ? url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(this.token) : url; }
  async fetch(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (this.token) headers['X-Token'] = this.token;
    const r = await fetch(this.api(path), { ...opts, headers });
    if (!r.ok) {
      let msg = `${r.status} ${r.statusText}`;
      try { msg = (await r.json()).error || msg; } catch { /* ignore */ }
      const e = new Error(msg); e.status = r.status; throw e;
    }
    return r;
  }
  async json(path, opts) { return (await this.fetch(path, opts)).json(); }
  post(path, body) {
    return this.json(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  }
  async check() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const info = await this.json('/api/health', { signal: ctrl.signal });
      this.info = info;
      this.connected = !!info.ok && !!info.authorized;
      this.error = info.ok && !info.authorized ? 'token required' : null;
    } catch (e) {
      this.info = null; this.connected = false;
      this.error = e.name === 'AbortError' ? 'timeout' : e.message;
    } finally { clearTimeout(timer); }
    document.dispatchEvent(new CustomEvent('vt:server', { detail: this }));
    return this.connected;
  }
  get encoders() { return this.info?.encoders || null; }
  ls(path) { return this.json('/api/ls' + (path ? '?path=' + encodeURIComponent(path) : '')); }
  probe(path) { return this.json('/api/probe?path=' + encodeURIComponent(path)); }
  frameUrl(path, t, w) { return this.withToken(this.api(`/api/frame?path=${encodeURIComponent(path)}&t=${Number(t).toFixed(3)}&w=${w}`)); }
  mediaUrl(path) { return this.withToken(this.api('/media?path=' + encodeURIComponent(path))); }
  submit(jobs) { return this.post('/api/jobs', { jobs }); }
  jobs() { return this.json('/api/jobs'); }
  cancel(id) { return this.post(`/api/jobs/${id}/cancel`); }
  clearJobs() { return this.post('/api/jobs/clear'); }
  proxy(path) { return this.post('/api/proxy', { path }); }
  stat(paths) { return this.post('/api/stat', { paths }); }
  mkdir(path) { return this.post('/api/mkdir', { path }); }
}

export const server = new Server();

// ---------- media files ----------

let mfSeq = 0;

export class MediaFile {
  constructor({ path = null, file = null, name = null, size = null } = {}) {
    this.id = 'mf' + (++mfSeq);
    this.path = path;
    this.file = file;
    this.name = name || (path ? path.split('/').pop() : file?.name) || 'video';
    this.size = size ?? file?.size ?? 0;
    this.info = null;
    this._url = null;
    this._video = null;
    this._queue = Promise.resolve();
    this._lastFrameUrl = null;
  }
  get isServer() { return !!this.path; }
  get dir() { return this.path ? this.path.slice(0, this.path.lastIndexOf('/')) : ''; }
  get stem() { return this.name.replace(/\.[^.]+$/, ''); }
  get ext() { const m = this.name.match(/\.([^.]+)$/); return m ? m[1].toLowerCase() : ''; }
  get inputArg() { return this.path || this.name; }
  toJSON() { return { path: this.path, name: this.name, size: this.size }; }
  static fromJSON(o) { return o?.path ? new MediaFile(o) : null; }

  playbackUrl() {
    if (this.path) return server.mediaUrl(this.path);
    if (!this._url) this._url = URL.createObjectURL(this.file);
    return this._url;
  }

  async probe() {
    if (this.info) return this.info;
    if (this.path) {
      this.info = await server.probe(this.path);
    } else {
      const v = await this._videoEl();
      this.info = {
        path: null, name: this.name, size: this.size, duration: v.duration || 0, container: null,
        video: v.videoWidth ? { width: v.videoWidth, height: v.videoHeight, fps: null, codec: null, pix_fmt: null, hdr: false, web_safe: null, rotation: 0 } : null,
        audio: null, audio_unknown: true, web_safe: null, local: true,
      };
    }
    return this.info;
  }

  _videoEl() {
    if (this._video) return this._video.readyState >= 1 ? Promise.resolve(this._video) : this._videoReady;
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true;
    v.src = this.playbackUrl();
    this._video = v;
    this._videoReady = new Promise((res, rej) => {
      v.addEventListener('loadedmetadata', () => res(v), { once: true });
      v.addEventListener('error', () => rej(new Error('browser cannot open this file')), { once: true });
    });
    return this._videoReady;
  }

  async frame(t, w = 640) {
    if (this.path) return server.frameUrl(this.path, t, w);
    const run = async () => {
      const v = await this._videoEl();
      t = clamp(t, 0, Math.max(0, (v.duration || 0) - 0.001));
      if (Math.abs(v.currentTime - t) > 0.001 || v.readyState < 2) {
        await new Promise((res, rej) => {
          const done = () => { v.removeEventListener('seeked', done); res(); };
          v.addEventListener('seeked', done);
          v.addEventListener('error', rej, { once: true });
          v.currentTime = t;
        });
      }
      const scale = Math.min(1, w / v.videoWidth);
      const c = document.createElement('canvas');
      c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
      return URL.createObjectURL(blob);
    };
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }
}

export async function loadImage(url) {
  const img = new Image();
  img.decoding = 'async';
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('frame failed')); img.src = url; });
  return img;
}

export function codecSummary(info) {
  if (!info) return '';
  const v = info.video, a = info.audio;
  const parts = [];
  if (v) {
    parts.push([v.codec, v.pix_fmt].filter(Boolean).join(' ') || 'video');
    if (v.width) parts.push(`${v.width}×${v.height}`);
    if (v.fps) parts.push(`${v.fps}fps`);
    if (v.hdr) parts.push('HDR');
  } else if (info.local) parts.push('local file');
  if (a) parts.push(a.codec + (a.channels ? ` ${a.channels}ch` : ''));
  else if (!info.audio_unknown) parts.push('no audio');
  return parts.join(' · ');
}

// ---------- page shell ----------

const NAV = [
  ['convert', 'Convert'], ['crop', 'Crop'], ['sidebyside', 'Side by side'], ['sync', 'Sync'],
];

export function initPage({ root = '../', active = '' } = {}) {
  const header = el('header', { class: 'topbar' },
    el('a', { class: 'brand', href: root }, 'videotools'),
    el('nav', {}, NAV.map(([k, label]) => el('a', { href: `${root}${k}/`, class: k === active ? 'active' : '' }, label))),
    el('div', { class: 'spacer' }),
    el('button', { class: 'pill off', id: 'vt-status', onclick: openServerDialog }, el('span', { class: 'dot' }), el('span', { class: 'txt' }, 'checking server…')),
    el('button', { class: 'btn sm', id: 'vt-jobs-btn', onclick: toggleDrawer }, 'Jobs ', el('span', { class: 'badge', id: 'vt-jobs-badge' }, '0')),
  );
  document.body.prepend(header);
  document.body.append(buildDrawer(), buildServerDialog());
  document.addEventListener('vt:server', renderStatus);
  server.check().then(() => { if (server.connected) jobsStore.start(); });
  return { server };
}

function renderStatus() {
  const pill = $('#vt-status');
  if (!pill) return;
  pill.classList.remove('ok', 'warn', 'off');
  if (server.connected) {
    pill.classList.add('ok');
    pill.querySelector('.txt').textContent = `server: ${server.info.hostname}`;
  } else if (server.error === 'token required') {
    pill.classList.add('warn');
    pill.querySelector('.txt').textContent = 'server: token needed';
  } else {
    pill.classList.add('off');
    pill.querySelector('.txt').textContent = 'no server · command mode';
  }
}

function buildServerDialog() {
  const url = el('input', { type: 'text', class: 'w-full', id: 'vt-srv-url' });
  const tok = el('input', { type: 'text', class: 'w-full', id: 'vt-srv-token', placeholder: '(only when the server asks for one)' });
  const dlg = el('dialog', { id: 'vt-server-dlg' },
    el('div', { class: 'dlg-head' }, 'Job server', el('button', { class: 'btn sm', onclick: () => dlg.close() }, '✕')),
    el('div', { class: 'dlg-body stack' },
      el('p', { class: 'small muted' }, 'The server runs ffmpeg on the machine that holds your files. Without it, every tool still builds the ffmpeg command for you to copy.'),
      el('label', { class: 'field' }, el('span', {}, 'Server URL'), url),
      el('label', { class: 'field' }, el('span', {}, 'Token'), tok),
      el('div', { class: 'small muted', id: 'vt-srv-msg' }),
      el('details', { class: 'small' }, el('summary', {}, 'How to start the server'),
        el('pre', { class: 'cmd' }, 'cd ~/Projects/videotools\npython3 server/videotools_server.py --root ~/Downloads --root ~/Projects'),
        el('p', { class: 'muted', style: { marginTop: '8px' } }, 'From another machine, tunnel the port over ssh and keep the URL as localhost:'),
        el('pre', { class: 'cmd' }, 'ssh -N -L 8765:localhost:8765 cc-thunderbluff'),
        el('p', { class: 'muted', style: { marginTop: '8px' } }, 'If Chrome asks for permission to access the local network, allow it.'),
      ),
    ),
    el('div', { class: 'dlg-foot' },
      el('button', { class: 'btn', onclick: () => { server.url = 'http://localhost:8765'; server.token = ''; fill(); } }, 'Reset'),
      el('button', { class: 'btn primary', onclick: async () => {
        server.url = url.value.trim().replace(/\/+$/, ''); server.token = tok.value.trim(); server.save();
        $('#vt-srv-msg').textContent = 'connecting…';
        const ok = await server.check();
        $('#vt-srv-msg').textContent = ok ? `connected to ${server.info.hostname} (${server.info.ffmpeg})` : `not connected: ${server.error}`;
        if (ok) { jobsStore.start(); setTimeout(() => dlg.close(), 600); }
      } }, 'Save & connect'),
    ),
  );
  const fill = () => { url.value = server.url; tok.value = server.token; };
  dlg.addEventListener('vt:open', fill);
  return dlg;
}

export function openServerDialog() {
  const dlg = $('#vt-server-dlg');
  dlg.dispatchEvent(new Event('vt:open'));
  $('#vt-srv-msg').textContent = server.connected ? `connected to ${server.info.hostname}` : (server.error ? `not connected: ${server.error}` : '');
  dlg.showModal();
}

// ---------- jobs ----------

export const jobsStore = {
  jobs: [],
  timer: null,
  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
  },
  async tick() {
    if (!server.connected) return;
    const drawerOpen = $('#vt-drawer')?.classList.contains('open');
    const active = this.jobs.some(j => j.status === 'running' || j.status === 'queued');
    this._n = (this._n || 0) + 1;
    if (!drawerOpen && !active && this._n % 5 !== 0) return;
    try {
      this.jobs = await server.jobs();
      document.dispatchEvent(new CustomEvent('vt:jobs', { detail: this.jobs }));
      renderJobs();
    } catch { /* server went away; status pill updates on next check */ }
  },
  byId(id) { return this.jobs.find(j => j.id === id); },
};

export async function submitJobs(jobs) {
  const { ids } = await server.submit(jobs);
  toast(`${ids.length} job${ids.length > 1 ? 's' : ''} started`);
  jobsStore.start();
  jobsStore.tick();
  openDrawer(true);
  return ids;
}

function buildDrawer() {
  return el('aside', { class: 'drawer', id: 'vt-drawer' },
    el('header', {}, el('b', {}, 'Jobs'), el('div', { class: 'spacer' }),
      el('button', { class: 'btn sm', onclick: async () => { await server.clearJobs(); jobsStore.tick(); } }, 'Clear finished'),
      el('button', { class: 'btn sm', onclick: () => openDrawer(false) }, '✕')),
    el('div', { class: 'list', id: 'vt-jobs-list' }, el('div', { class: 'muted small' }, 'No jobs yet.')),
  );
}

export function openDrawer(open) { $('#vt-drawer').classList.toggle('open', open); if (open) jobsStore.tick(); }
function toggleDrawer() { openDrawer(!$('#vt-drawer').classList.contains('open')); }

function renderJobs() {
  const list = $('#vt-jobs-list');
  const jobs = jobsStore.jobs;
  const active = jobs.filter(j => j.status === 'running' || j.status === 'queued').length;
  const badge = $('#vt-jobs-badge');
  badge.textContent = active || jobs.length;
  badge.className = 'badge' + (active ? ' accent' : jobs.some(j => j.status === 'failed') ? ' err' : jobs.length ? ' ok' : '');
  if (!jobs.length) { list.replaceChildren(el('div', { class: 'muted small' }, 'No jobs yet.')); return; }
  list.replaceChildren(...[...jobs].reverse().map(j => {
    const pct = Math.round((j.progress || 0) * 100);
    const meta = [];
    if (j.status === 'running') meta.push(`${pct}%`, j.speed ? `${j.speed}` : '', j.fps ? `${j.fps} fps` : '');
    if (j.status === 'done') meta.push(fmtBytes(j.size), j.ended && j.started ? `${(j.ended - j.started).toFixed(1)}s` : '');
    if (j.status === 'queued') meta.push('waiting for a free slot');
    if (j.status === 'cancelled') meta.push('cancelled');
    return el('div', { class: 'job' },
      el('div', { class: 'title' }, el('b', { title: j.output || '' }, j.label),
        el('span', { class: `badge ${j.status === 'done' ? 'ok' : j.status === 'failed' ? 'err' : j.status === 'running' ? 'accent' : ''}` }, j.status)),
      el('div', { class: 'meta' }, meta.filter(Boolean).map(m => el('span', {}, m)), el('span', { class: 'spacer' }),
        (j.status === 'running' || j.status === 'queued') && el('button', { class: 'btn sm danger', onclick: () => server.cancel(j.id).then(() => jobsStore.tick()) }, 'cancel')),
      el('div', { class: `progress ${j.status}` }, el('i', { style: { width: `${j.status === 'done' ? 100 : pct}%` } })),
      j.output && j.status === 'done' && el('div', { class: 'small muted mono', style: { marginTop: '4px', wordBreak: 'break-all' } }, j.output),
      j.status === 'failed' && el('pre', {}, j.error || 'failed'),
    );
  }));
}

// ---------- file picker ----------

let lastDir = null;
try { lastDir = localStorage.getItem('vt_lastdir'); } catch { /* ignore */ }

export function pickFiles({ multiple = false, title = 'Choose video' } = {}) {
  if (!server.connected) return pickLocalFiles({ multiple });
  return new Promise(resolve => {
    let selected = new Map();
    let current = null;
    const pathInput = el('input', { type: 'text', class: 'mono', onkeydown: e => { if (e.key === 'Enter') load(pathInput.value); } });
    const dirList = el('div', { class: 'list' });
    const fileList = el('div', { class: 'list' });
    const localInput = el('input', { type: 'file', accept: 'video/*,.mov,.mkv,.avi,.mp4', multiple, class: 'hidden', onchange: () => {
      const files = [...localInput.files].map(f => new MediaFile({ file: f }));
      if (files.length) { dlg.close(); resolve(files); }
    } });
    const okBtn = el('button', { class: 'btn primary', disabled: true, onclick: () => { dlg.close(); resolve([...selected.values()]); } }, 'Select');
    const dlg = el('dialog', { class: 'picker' },
      el('div', { class: 'dlg-head' }, title, el('button', { class: 'btn sm', onclick: () => { dlg.close(); resolve([]); } }, '✕')),
      el('div', { class: 'dlg-body' },
        el('div', { class: 'crumbs' }, el('button', { class: 'btn sm', title: 'up', onclick: () => current?.parent && load(current.parent) }, '↑'), pathInput,
          el('button', { class: 'btn sm', onclick: () => load(pathInput.value) }, 'Go')),
        el('div', { class: 'lists' }, dirList, fileList),
      ),
      el('div', { class: 'dlg-foot' },
        el('span', { class: 'muted small', style: { flex: 1 } }, multiple ? 'Click files to toggle. Double-click a file to pick just that one.' : 'Double-click a file, or select it and press Select.'),
        el('button', { class: 'btn', onclick: () => localInput.click() }, 'Local file instead…'), localInput, okBtn),
    );
    document.body.append(dlg);
    dlg.addEventListener('close', () => dlg.remove());

    const updateOk = () => { okBtn.disabled = selected.size === 0; okBtn.textContent = selected.size > 1 ? `Select ${selected.size} files` : 'Select'; };
    async function load(path) {
      try {
        current = await server.ls(path);
      } catch (e) { toast(e.message, true); return; }
      pathInput.value = current.path;
      try { localStorage.setItem('vt_lastdir', current.path); } catch { /* ignore */ }
      dirList.replaceChildren(
        ...current.roots.filter(r => r !== current.path).map(r => el('div', { class: 'item muted', onclick: () => load(r) }, '⌂ ', el('span', { class: 'name' }, r))),
        ...current.dirs.map(d => el('div', { class: 'item', onclick: () => load(d.path) }, '📁 ', el('span', { class: 'name' }, d.name))),
      );
      if (!current.dirs.length) dirList.append(el('div', { class: 'empty' }, 'no sub-folders'));
      fileList.replaceChildren(...current.files.map(f => {
        const item = el('div', { class: 'item' + (selected.has(f.path) ? ' selected' : '') },
          el('span', { class: 'name' }, f.name), el('span', { class: 'size' }, fmtBytes(f.size)));
        item.addEventListener('click', () => {
          const mf = new MediaFile(f);
          if (multiple) {
            if (selected.has(f.path)) selected.delete(f.path); else selected.set(f.path, mf);
          } else { selected = new Map([[f.path, mf]]); $$('.item.selected', fileList).forEach(x => x.classList.remove('selected')); }
          item.classList.toggle('selected', selected.has(f.path));
          updateOk();
        });
        item.addEventListener('dblclick', () => { dlg.close(); resolve([new MediaFile(f)]); });
        return item;
      }));
      if (!current.files.length) fileList.append(el('div', { class: 'empty' }, 'no video files here'));
    }
    dlg.showModal();
    load(lastDir || server.info?.roots?.[0] || '');
  });
}

export function pickLocalFiles({ multiple = false } = {}) {
  return new Promise(resolve => {
    const input = el('input', { type: 'file', accept: 'video/*,.mov,.mkv,.avi,.mp4', multiple });
    input.onchange = () => resolve([...input.files].map(f => new MediaFile({ file: f })));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export function makeDropZone(zone, onFiles) {
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('over');
    const files = [...e.dataTransfer.files].filter(f => /video|\.(mov|mp4|mkv|avi|webm|m4v|mts)$/i.test(f.type + f.name)).map(f => new MediaFile({ file: f }));
    if (files.length) onFiles(files);
  });
}

// ---------- command panel ----------

export class CommandPanel {
  constructor(container, { runLabel = 'Run on server', scriptMode = false } = {}) {
    this.scriptMode = scriptMode;
    this.getCommands = () => [];
    this.getJobs = () => [];
    this.onRun = null;
    this.pre = el('pre', { class: 'cmd' }, '');
    this.runBtn = el('button', { class: 'btn primary', onclick: () => this.run() }, runLabel);
    this.copyBtn = el('button', { class: 'btn', onclick: () => copyText(this.text()) }, scriptMode ? 'Copy script' : 'Copy command');
    this.note = el('span', { class: 'small muted' });
    container.append(el('div', { class: 'cmdpanel' },
      el('div', { class: 'actions' }, this.runBtn, this.copyBtn, this.note), this.pre));
    document.addEventListener('vt:server', () => this.refresh());
    this.refresh();
  }
  text() {
    const cmds = this.getCommands();
    if (!cmds.length) return '';
    const body = cmds.map(a => argsToShell(a)).join('\n\n');
    const pre = this.getPrelude?.() || '';
    return this.scriptMode ? `#!/bin/bash\nset -e\n${pre ? pre + '\n' : ''}\n${body}\n` : body;
  }
  refresh() {
    const cmds = this.getCommands();
    this.pre.textContent = cmds.length ? this.text() : '(pick a file first)';
    this.runBtn.disabled = !server.connected || !cmds.length;
    this.copyBtn.disabled = !cmds.length;
    this.note.textContent = server.connected ? '' : 'No server connected: copy the command and run it in a terminal with ffmpeg installed.';
  }
  async run() {
    const jobs = this.getJobs();
    if (!jobs.length) return;
    try {
      const ids = await submitJobs(jobs);
      if (this.onRun) this.onRun(ids, jobs);
    } catch (e) { toast(e.message, true); }
  }
}

export function outputPath(mf, suffix, ext, dir = null) {
  const name = `${mf.stem}${suffix}.${ext}`;
  if (!mf.isServer) return name;
  return `${dir || mf.dir}/${name}`;
}
