import { $, $$, el, initPage, pickFiles, fmtTime, parseTime, server, toast, clamp, round3 } from '../assets/common.js';

initPage({ root: '../', active: 'sync' });

const vA = $('#vA'), vB = $('#vB'), stage = $('#stage');
const S = { a: { mf: null, info: null, v: vA, notice: $('#noticeA') }, b: { mf: null, info: null, v: vB, notice: $('#noticeB') } };
let offset = 0;          // tB = tA + offset
let unlinked = false;
let swapped = false;
const DRIFT_TOL = 0.04;

$('#pickA').onclick = async () => { const [mf] = await pickFiles({ title: 'Choose video A' }); if (mf) load('a', mf); };
$('#pickB').onclick = async () => { const [mf] = await pickFiles({ title: 'Choose video B' }); if (mf) load('b', mf); };
$('#play').onclick = togglePlay;
$$('[data-step]').forEach(b => b.addEventListener('click', () => step(+b.dataset.step)));
$$('[data-off]').forEach(b => b.addEventListener('click', () => nudgeOffset(b.dataset.off)));
$('#offset').addEventListener('change', () => setOffset(parseTime($('#offset').value)));
$('#offsetRange').addEventListener('input', () => setOffset(+$('#offsetRange').value));
$('#seek').addEventListener('input', () => seekA($('#seek').value / 10000 * (vA.duration || 0)));
$('#seekB').addEventListener('input', () => { vB.currentTime = $('#seekB').value / 10000 * (vB.duration || 0); });
$('#unlink').addEventListener('change', () => { unlinked = $('#unlink').checked; $('#rowB').classList.toggle('hidden', !unlinked); if (!unlinked) syncB(true); });
$('#setFromCurrent').onclick = () => { setOffset(vB.currentTime - vA.currentTime); $('#unlink').checked = false; unlinked = false; $('#rowB').classList.add('hidden'); };
$('#view').addEventListener('change', applyView);
$('#opacity').addEventListener('input', applyView);
$('#rate').addEventListener('change', () => { vA.playbackRate = vB.playbackRate = +$('#rate').value; });
$('#mute').addEventListener('change', () => { vA.muted = $('#mute').checked; vB.muted = true; });
$('#toSbs').onclick = handoff;

async function load(key, mf) {
  const s = S[key];
  s.mf = mf; s.info = null;
  $(key === 'a' ? '#nameA' : '#nameB').textContent = mf.name;
  s.notice.classList.add('hidden');
  try { s.info = await mf.probe(); } catch (e) { toast(`${mf.name}: ${e.message}`, true); }
  s.v.src = mf.playbackUrl();
  s.v.load();
  updateButtons();
}

function fps() { return S.a.info?.video?.fps || S.b.info?.video?.fps || 30; }

vA.addEventListener('loadedmetadata', () => { $('#durA').textContent = `/ ${fmtTime(vA.duration)}`; updateTimes(); });
for (const key of ['a', 'b']) {
  const s = S[key];
  s.v.addEventListener('error', () => onPlaybackError(key));
  s.v.addEventListener('loadeddata', () => { s.notice.classList.add('hidden'); if (key === 'b') syncB(true); });
}

async function onPlaybackError(key) {
  const s = S[key];
  if (!s.mf) return;
  if (!s.mf.isServer || !server.connected) {
    showNotice(s, 'The browser cannot play this file. Convert it to H.264 MP4 first (Convert tool).');
    return;
  }
  showNotice(s, 'Browser cannot play this file. Making a preview proxy…');
  try {
    let r = await server.proxy(s.mf.path);
    while (!r.ready) {
      await new Promise(res => setTimeout(res, 1000));
      const jobs = await server.jobs();
      const job = jobs.find(j => j.id === r.job_id);
      if (!job || job.status === 'failed' || job.status === 'cancelled') throw new Error(job?.error || 'proxy job vanished');
      showNotice(s, `Making a preview proxy… ${Math.round((job.progress || 0) * 100)}%`);
      if (job.status === 'done') r = { ...r, ready: true };
    }
    s.v.src = server.withToken(server.api(r.url));
    s.v.load();
    s.proxy = true;
  } catch (e) { showNotice(s, `Proxy failed: ${e.message}`); }
}

function showNotice(s, text) {
  s.notice.textContent = text;
  s.notice.classList.remove('hidden');
}

// ---------- playback sync ----------

function targetB() { return vA.currentTime + offset; }

function syncB(force = false) {
  if (unlinked || !vB.duration) return;
  const t = targetB();
  if (t < 0 || t > vB.duration) {
    if (!vB.paused) vB.pause();
    const clamped = clamp(t, 0, vB.duration);
    if (Math.abs(vB.currentTime - clamped) > 0.001) vB.currentTime = clamped;
    return;
  }
  if (force || Math.abs(vB.currentTime - t) > DRIFT_TOL) vB.currentTime = t;
  if (!vA.paused && vB.paused) vB.play().catch(() => {});
}

function tick() {
  if (!vA.paused) syncB();
  updateTimes();
  if ('requestVideoFrameCallback' in vA) vA.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
}
if ('requestVideoFrameCallback' in vA) vA.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
setInterval(updateTimes, 250);

vA.addEventListener('play', () => { $('#play').textContent = '❚❚'; syncB(true); });
vA.addEventListener('pause', () => { $('#play').textContent = '▶'; vB.pause(); syncB(true); });
vA.addEventListener('seeked', () => syncB(true));
vA.addEventListener('ended', () => vB.pause());

function togglePlay() {
  if (!vA.src) return;
  if (vA.paused) vA.play().catch(e => toast(e.message, true)); else vA.pause();
}

function seekA(t) { vA.currentTime = clamp(t, 0, vA.duration || 0); }
function step(frames) { vA.pause(); seekA(vA.currentTime + frames / fps()); }

function setOffset(v) {
  if (isNaN(v)) { $('#offset').value = offset.toFixed(3); return; }
  offset = round3(v);
  $('#offset').value = offset.toFixed(3);
  $('#offsetRange').value = clamp(offset, -10, 10);
  syncB(true);
  updateHandoffInfo();
}
function nudgeOffset(spec) {
  const d = spec.endsWith('f') ? parseFloat(spec) / fps() : parseFloat(spec);
  setOffset(offset + d);
}

function updateTimes() {
  $('#timeA').textContent = `A ${fmtTime(vA.currentTime || 0)}`;
  $('#timeB').textContent = `B ${fmtTime(vB.currentTime || 0)}`;
  if (vA.duration) $('#seek').value = Math.round(vA.currentTime / vA.duration * 10000);
  if (vB.duration && unlinked) $('#seekB').value = Math.round(vB.currentTime / vB.duration * 10000);
}

// ---------- views ----------

function applyView() {
  const mode = $('#view').value;
  stage.classList.toggle('side', mode === 'side');
  stage.classList.toggle('overlay', mode === 'overlay');
  $('#opacityField').classList.toggle('hidden', mode !== 'overlay');
  vA.classList.toggle('hidden', mode === 'b');
  vB.classList.toggle('hidden', mode === 'a');
  const top = swapped ? vA : vB, bottom = swapped ? vB : vA;
  if (mode === 'overlay') {
    top.style.opacity = $('#opacity').value; bottom.style.opacity = '1';
    top.style.zIndex = '2'; bottom.style.zIndex = '1';
  } else { vA.style.opacity = vB.style.opacity = '1'; vA.style.zIndex = vB.style.zIndex = ''; }
}

document.addEventListener('keydown', e => {
  if (e.target.matches?.('input, select, textarea')) return;
  const views = { 1: 'a', 2: 'b', 3: 'side', 4: 'overlay' };
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(e.shiftKey ? -10 : -1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); step(e.shiftKey ? 10 : 1); }
  else if (e.key === '[') nudgeOffset('-1f');
  else if (e.key === ']') nudgeOffset('1f');
  else if (e.key === ',') nudgeOffset('-0.01');
  else if (e.key === '.') nudgeOffset('0.01');
  else if (e.key === 'o') { swapped = !swapped; applyView(); }
  else if (views[e.key]) { $('#view').value = views[e.key]; applyView(); }
});

// ---------- hand-off ----------

function handoffTimes() {
  let startA = vA.currentTime || 0, startB = startA + offset;
  if (startB < 0) { startA -= startB; startB = 0; }
  return { startA: round3(startA), startB: round3(startB) };
}
function updateHandoffInfo() {
  const { startA, startB } = handoffTimes();
  $('#handoffInfo').textContent = `offset ${offset >= 0 ? '+' : ''}${offset.toFixed(3)} s → A from ${fmtTime(startA)}, B from ${fmtTime(startB)}`;
}
function updateButtons() { $('#toSbs').disabled = !(S.a.mf && S.b.mf); updateHandoffInfo(); }
function handoff() {
  const { startA, startB } = handoffTimes();
  try {
    localStorage.setItem('vt_handoff', JSON.stringify({ a: S.a.mf.toJSON(), b: S.b.mf.toJSON(), startA, startB, ts: Date.now() }));
  } catch { /* ignore */ }
  if (!S.a.mf.isServer || !S.b.mf.isServer) toast(`Local files: pick them again there. A start ${startA}s, B start ${startB}s`);
  location.href = '../sidebyside/';
}

applyView();
updateButtons();
setInterval(updateHandoffInfo, 500);
