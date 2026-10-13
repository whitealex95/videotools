import { el, server, TONEMAP } from './common.js';

const X264_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
const NVENC_PRESETS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
const CONTAINERS = { mp4: 'mp4', mov: 'mov', mkv: 'mkv' };

const STORE_KEY = 'vt_encode';

export class EncodePanel {
  constructor(container, { compact = false, onChange = null } = {}) {
    this.onChange = onChange;
    const saved = load();
    this.f = {
      vmode: sel([['auto', 'auto (copy when already web-safe)'], ['reencode', 'always re-encode'], ['copy', 'copy stream (no filters)']], saved.vmode || 'auto'),
      encoder: sel([['libx264', 'H.264 (libx264)'], ['h264_nvenc', 'H.264 NVENC (GPU)'], ['libx265', 'H.265 (libx265)'], ['hevc_nvenc', 'H.265 NVENC (GPU)']], saved.encoder || 'libx264'),
      quality: num(saved.quality ?? 23, 0, 51),
      preset: sel(X264_PRESETS.map(p => [p, p]), saved.preset || 'medium'),
      maxWidth: num(saved.maxWidth ?? '', 16, 8192, 'keep'),
      fps: num(saved.fps ?? '', 1, 240, 'keep'),
      tonemap: sel([['auto', 'auto (when source is HDR)'], ['off', 'off']], saved.tonemap || 'auto'),
      amode: sel([['auto', 'auto (copy AAC, else encode)'], ['aac', 'AAC'], ['copy', 'copy'], ['none', 'no audio']], saved.amode || 'auto'),
      container: sel(Object.keys(CONTAINERS).map(c => [c, c]), saved.container || 'mp4'),
    };
    for (const [k, inp] of Object.entries(this.f)) {
      if (k === 'encoder') inp.addEventListener('input', () => { this._syncPresetList(); this._changed(); });
      else inp.addEventListener('input', () => this._changed());
    }
    this._syncPresetList(saved.preset);
    this.encNote = el('span', { class: 'small muted' });
    const field = (label, input, extra) => el('label', { class: 'field' }, el('span', {}, label), input, extra);
    const grid = el('div', { class: 'row top', style: { gap: '12px 18px' } },
      field('Video', this.f.vmode),
      field('Encoder', this.f.encoder),
      field('Quality (CRF / CQ, lower = better)', this.f.quality),
      field('Speed preset', this.f.preset),
      field('Max width (px)', this.f.maxWidth),
      field('FPS', this.f.fps),
      field('HDR → SDR tone map', this.f.tonemap),
      field('Audio', this.f.amode),
      field('Container', this.f.container),
    );
    container.append(el('div', { class: 'stack' }, grid, this.encNote));
    document.addEventListener('vt:server', () => this._updateEncoderAvailability());
    this._updateEncoderAvailability();
    if (compact) container.classList.add('tight');
  }

  _changed() { save(this.opts); this.onChange?.(); }

  _syncPresetList(keep) {
    const nv = this.f.encoder.value.includes('nvenc');
    const list = nv ? NVENC_PRESETS : X264_PRESETS;
    const cur = keep || this.f.preset.value;
    this.f.preset.replaceChildren(...list.map(p => el('option', { value: p }, p)));
    this.f.preset.value = list.includes(cur) ? cur : (nv ? 'p5' : 'medium');
  }

  _updateEncoderAvailability() {
    const enc = server.encoders;
    for (const opt of this.f.encoder.options) {
      const known = enc && opt.value in enc;
      const ok = !enc || enc[opt.value] !== false;
      opt.disabled = !ok;
      opt.textContent = opt.textContent.replace(/ \(not available\)$/, '') + (known && !ok ? ' (not available)' : '');
    }
    if (this.f.encoder.selectedOptions[0]?.disabled) { this.f.encoder.value = 'libx264'; this._syncPresetList(); }
    this.encNote.textContent = enc?.h264_nvenc ? 'NVENC is available on the server: much faster for long videos, slightly larger files at the same quality.' : '';
  }

  get opts() {
    const f = this.f;
    return {
      vmode: f.vmode.value, encoder: f.encoder.value, quality: Number(f.quality.value) || 23, preset: f.preset.value,
      maxWidth: f.maxWidth.value ? Number(f.maxWidth.value) : null, fps: f.fps.value ? Number(f.fps.value) : null,
      tonemap: f.tonemap.value, amode: f.amode.value, container: f.container.value,
    };
  }
  get ext() { return CONTAINERS[this.opts.container]; }

  needsVideoEncode(info, { hasFilters = false } = {}) {
    const o = this.opts;
    if (o.vmode === 'copy') return false;
    if (o.vmode === 'reencode' || hasFilters || o.maxWidth || o.fps) return true;
    const v = info?.video;
    if (!v || v.web_safe == null) return true;
    if (v.hdr && o.tonemap !== 'off') return true;
    return !v.web_safe;
  }

  /* Filters applied to one video stream before encoding, in order: caller filters, scale, tone map, fps, pixel format. */
  videoFilters(info, vf = [], { format = true } = {}) {
    const o = this.opts, v = info?.video;
    const chain = [...vf];
    if (o.maxWidth) chain.push(`scale=min(${o.maxWidth}\\,iw):-2`);
    if (v?.hdr && o.tonemap !== 'off') chain.push(TONEMAP);
    if (o.fps) chain.push(`fps=${o.fps}`);
    if (format) chain.push('format=yuv420p');
    return chain;
  }

  videoCodecArgs(info) {
    const o = this.opts;
    const args = [];
    switch (o.encoder) {
      case 'h264_nvenc':
      case 'hevc_nvenc':
        args.push('-c:v', o.encoder, '-preset', o.preset, '-tune', 'hq', '-rc', 'vbr', '-cq', String(o.quality), '-b:v', '0');
        break;
      case 'libx265':
        args.push('-c:v', 'libx265', '-preset', o.preset, '-crf', String(o.quality));
        break;
      default:
        args.push('-c:v', 'libx264', '-preset', o.preset, '-crf', String(o.quality));
    }
    if (o.encoder.includes('hevc') || o.encoder === 'libx265') args.push('-tag:v', 'hvc1');
    if (info?.video?.hdr && o.tonemap !== 'off') args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
    return args;
  }

  audioArgs(info) {
    const o = this.opts, a = info?.audio;
    if (o.amode === 'none') return ['-an'];
    if (o.amode === 'copy') return ['-c:a', 'copy'];
    if (o.amode === 'auto' && a?.codec === 'aac') return ['-c:a', 'copy'];
    if (o.amode === 'auto' && info && !info.audio_unknown && !a) return ['-an'];
    return ['-c:a', 'aac', '-b:a', '160k'];
  }

  containerArgs() {
    return this.opts.container === 'mkv' ? [] : ['-movflags', '+faststart'];
  }

  /* Full ffmpeg argument list (after "ffmpeg") for one input to one output. */
  buildArgs({ input, output, info, vf = [], ss = null, duration = null }) {
    const args = ['-y'];
    if (ss != null && ss > 0) args.push('-ss', fmtSec(ss));
    args.push('-i', input);
    if (duration != null && duration > 0) args.push('-t', fmtSec(duration));
    args.push('-map', '0:v:0', '-map', '0:a:0?');
    if (this.needsVideoEncode(info, { hasFilters: vf.length > 0 })) {
      args.push('-vf', this.videoFilters(info, vf).join(','));
      args.push(...this.videoCodecArgs(info));
    } else {
      args.push('-c:v', 'copy');
    }
    args.push(...this.audioArgs(info), ...this.containerArgs(), output);
    return args;
  }
}

export const fmtSec = s => String(Math.round(s * 1000) / 1000);

function sel(options, value) {
  const s = el('select', {}, options.map(([v, label]) => el('option', { value: v }, label)));
  s.value = value;
  return s;
}
function num(value, min, max, placeholder = '') {
  return el('input', { type: 'number', min, max, step: 1, value: value === '' ? null : value, placeholder });
}
function load() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { return {}; } }
function save(opts) { try { localStorage.setItem(STORE_KEY, JSON.stringify(opts)); } catch { /* ignore */ } }
