#!/usr/bin/env python3
"""Local job server for the videotools web UI. Standard library only.

    python3 videotools_server.py                      # localhost:8765, root = home
    python3 videotools_server.py --host 0.0.0.0       # LAN access, token required
    python3 videotools_server.py --root ~/Videos --root ~/Downloads
"""
import argparse
import hashlib
import json
import mimetypes
import os
import queue
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

VERSION = "0.1.0"
STATIC_DIR = Path(__file__).resolve().parent.parent
CACHE_DIR = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "videotools"
CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "videotools"
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mts", ".m2ts", ".ts", ".wmv", ".flv", ".gif", ".mpg", ".mpeg", ".3gp"}
TONEMAP = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv"
LOOPBACK = {"127.0.0.1", "localhost", "::1"}

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("video/quicktime", ".mov")
mimetypes.add_type("video/x-matroska", ".mkv")


class Config:
    roots = []
    read_roots = []
    token = None
    parallel = 4
    ffmpeg = "ffmpeg"
    ffprobe = "ffprobe"
    ffmpeg_version = ""
    encoders = {}
    verbose = False


CFG = Config()


def is_within(path: Path, roots) -> bool:
    return any(path == r or r in path.parents for r in roots)


def safe_path(s: str, write=False) -> Path:
    if not s:
        raise PermissionError("empty path")
    p = Path(os.path.expanduser(s))
    if not p.is_absolute():
        raise PermissionError(f"path must be absolute: {s}")
    p = p.resolve()
    roots = CFG.roots if write else CFG.read_roots
    if not is_within(p, roots):
        raise PermissionError(f"path outside allowed roots: {s}")
    return p


def frac(s):
    try:
        n, d = s.split("/")
        return float(n) / float(d) if float(d) else 0.0
    except (ValueError, AttributeError):
        return 0.0


PROBE_CACHE = {}
PROBE_LOCK = threading.Lock()


def probe(path: Path) -> dict:
    st = path.stat()
    key = (str(path), st.st_mtime_ns, st.st_size)
    with PROBE_LOCK:
        if key in PROBE_CACHE:
            return PROBE_CACHE[key]
    r = subprocess.run(
        [CFG.ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, timeout=120,
    )
    data = json.loads(r.stdout or "{}")
    streams = data.get("streams", [])
    fmt = data.get("format", {})
    v = next((s for s in streams if s.get("codec_type") == "video"
              and not (s.get("disposition") or {}).get("attached_pic")), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    info = {
        "path": str(path), "name": path.name, "size": st.st_size, "mtime": st.st_mtime,
        "duration": float(fmt.get("duration") or (v or {}).get("duration") or 0),
        "container": fmt.get("format_name"), "bitrate": int(fmt.get("bit_rate") or 0),
        "nb_streams": len(streams), "video": None, "audio": None,
    }
    if v:
        rotation = 0
        for sd in v.get("side_data_list") or []:
            if "rotation" in sd:
                rotation = int(float(sd["rotation"]))
        if "rotate" in (v.get("tags") or {}):
            rotation = int(float(v["tags"]["rotate"]))
        w, h = int(v.get("width") or 0), int(v.get("height") or 0)
        if rotation % 180:
            w, h = h, w
        trc, prim = v.get("color_transfer"), v.get("color_primaries")
        hdr = trc in ("smpte2084", "arib-std-b67") or prim == "bt2020"
        info["video"] = {
            "codec": v.get("codec_name"), "profile": v.get("profile"), "pix_fmt": v.get("pix_fmt"),
            "width": w, "height": h, "rotation": rotation,
            "fps": round(frac(v.get("avg_frame_rate", "0/1")) or frac(v.get("r_frame_rate", "0/1")), 3),
            "color_transfer": trc, "color_primaries": prim, "color_space": v.get("color_space"),
            "hdr": hdr, "nb_frames": int(v.get("nb_frames") or 0), "bitrate": int(v.get("bit_rate") or 0),
            "web_safe": v.get("codec_name") == "h264" and v.get("pix_fmt") in ("yuv420p", "yuvj420p") and not hdr,
        }
    if a:
        info["audio"] = {
            "codec": a.get("codec_name"), "channels": a.get("channels"),
            "sample_rate": a.get("sample_rate"), "bitrate": int(a.get("bit_rate") or 0),
        }
    container_ok = any(x in (fmt.get("format_name") or "") for x in ("mp4", "mov"))
    info["web_safe"] = bool(v and info["video"]["web_safe"] and container_ok
                            and (not a or a.get("codec_name") == "aac"))
    with PROBE_LOCK:
        PROBE_CACHE[key] = info
    return info


def frame_jpeg(path: Path, t: float, w: int) -> bytes:
    st = path.stat()
    key = hashlib.sha1(f"{path}|{st.st_mtime_ns}|{t:.3f}|{w}".encode()).hexdigest()
    out = CACHE_DIR / "frames" / f"{key}.jpg"
    if out.exists():
        return out.read_bytes()
    info = probe(path)
    vf = []
    if info.get("video", {}) and info["video"]["hdr"]:
        vf.append(TONEMAP)
    vf.append(f"scale=min({w}\\,iw):-2")
    cmd = [CFG.ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-ss", f"{max(t, 0):.3f}",
           "-i", str(path), "-frames:v", "1", "-vf", ",".join(vf), "-q:v", "4",
           "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"]
    r = subprocess.run(cmd, capture_output=True, timeout=120)
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError(r.stderr.decode(errors="replace")[-400:] or "no frame")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(r.stdout)
    return r.stdout


class Job:
    def __init__(self, label, args, output, duration=0.0, kind="ffmpeg", meta=None):
        self.id = uuid.uuid4().hex[:10]
        self.label, self.args, self.output = label, args, output
        self.duration, self.kind, self.meta = float(duration or 0), kind, meta
        self.status = "queued"
        self.progress = 0.0
        self.out_time = 0.0
        self.speed = self.fps = ""
        self.size = 0
        self.error = None
        self.log = deque(maxlen=40)
        self.proc = None
        self.created, self.started, self.ended = time.time(), None, None

    def to_dict(self):
        return {
            "id": self.id, "label": self.label, "status": self.status, "progress": self.progress,
            "out_time": self.out_time, "duration": self.duration, "speed": self.speed, "fps": self.fps,
            "size": self.size, "output": self.output, "error": self.error, "kind": self.kind,
            "meta": self.meta, "log_tail": list(self.log)[-12:],
            "created": self.created, "started": self.started, "ended": self.ended,
        }


class JobRunner:
    def __init__(self, parallel):
        self.jobs = {}
        self.order = []
        self.q = queue.Queue()
        self.lock = threading.Lock()
        for _ in range(parallel):
            threading.Thread(target=self._worker, daemon=True).start()

    def submit(self, job):
        with self.lock:
            self.jobs[job.id] = job
            self.order.append(job.id)
        self.q.put(job.id)
        return job

    def get(self, jid):
        return self.jobs.get(jid)

    def list(self):
        with self.lock:
            return [self.jobs[j].to_dict() for j in self.order]

    def cancel(self, jid):
        job = self.jobs.get(jid)
        if not job:
            return False
        if job.status == "queued":
            job.status = "cancelled"
            job.ended = time.time()
        elif job.status == "running" and job.proc:
            job.status = "cancelled"
            try:
                job.proc.terminate()
            except OSError:
                pass
        return True

    def clear_finished(self):
        with self.lock:
            keep = [j for j in self.order if self.jobs[j].status in ("queued", "running")]
            for j in self.order:
                if j not in keep:
                    del self.jobs[j]
            self.order = keep

    def _worker(self):
        while True:
            jid = self.q.get()
            job = self.jobs.get(jid)
            if job and job.status == "queued":
                self._run(job)

    def _run(self, job):
        job.status, job.started = "running", time.time()
        if job.output:
            Path(job.output).parent.mkdir(parents=True, exist_ok=True)
        cmd = [CFG.ffmpeg, "-nostdin", "-hide_banner", "-nostats", "-loglevel", "warning",
               "-progress", "pipe:1"] + job.args
        if CFG.verbose:
            print("[job]", " ".join(cmd), flush=True)
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        except OSError as e:
            job.status, job.error, job.ended = "failed", str(e), time.time()
            return
        job.proc = proc

        def read_err():
            for line in proc.stderr:
                job.log.append(line.rstrip())
        threading.Thread(target=read_err, daemon=True).start()

        for line in proc.stdout:
            k, _, v = line.strip().partition("=")
            if k == "out_time_us" and v.lstrip("-").isdigit():
                job.out_time = int(v) / 1e6
                if job.duration > 0:
                    job.progress = max(0.0, min(0.999, job.out_time / job.duration))
            elif k == "speed":
                job.speed = v.strip()
            elif k == "fps":
                job.fps = v.strip()
            elif k == "total_size" and v.isdigit():
                job.size = int(v)
        rc = proc.wait()
        job.ended = time.time()
        if job.status == "cancelled":
            if job.output and Path(job.output).exists():
                try:
                    Path(job.output).unlink()
                except OSError:
                    pass
        elif rc == 0:
            job.status, job.progress = "done", 1.0
        else:
            job.status = "failed"
            job.error = "\n".join(list(job.log)[-5:]) or f"ffmpeg exited with code {rc}"


RUNNER = None


def validate_job_args(args):
    if not isinstance(args, list) or not args or not all(isinstance(a, str) for a in args):
        raise ValueError("args must be a non-empty list of strings")
    for i, a in enumerate(args):
        if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", a):
            raise PermissionError(f"URLs are not allowed: {a}")
        if a.startswith(("/", "~")):
            safe_path(a)
        if a == "-i" and i + 1 < len(args):
            safe_path(args[i + 1])
    return safe_path(args[-1], write=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"videotools/{VERSION}"

    def log_message(self, fmt, *args):
        if CFG.verbose or (self.path.startswith("/api/") and not self.path.startswith(("/api/jobs", "/api/frame"))):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin") or "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Token, Range")
        self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Vary", "Origin")

    def send_bytes(self, body: bytes, status=200, ctype="application/octet-stream", extra=None):
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, obj, status=200):
        self.send_bytes(json.dumps(obj).encode(), status, "application/json")

    def fail(self, status, msg):
        self.send_json({"error": str(msg)}, status)

    def query(self):
        return {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        return json.loads(raw or b"{}")

    def authorized(self):
        if CFG.token is None:
            return True
        tok = self.headers.get("X-Token") or self.query().get("token")
        return tok is not None and secrets.compare_digest(tok, CFG.token)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/health":
                return self.api_health()
            if path.startswith("/api/") or path == "/media":
                if not self.authorized():
                    return self.fail(401, "token required")
                q = self.query()
                if path == "/api/ls":
                    return self.api_ls(q)
                if path == "/api/probe":
                    return self.send_json(probe(safe_path(q.get("path"))))
                if path == "/api/frame":
                    return self.api_frame(q)
                if path == "/api/jobs":
                    return self.send_json(RUNNER.list())
                if path == "/media":
                    return self.serve_file(safe_path(q.get("path")), ranged=True)
                return self.fail(404, "unknown endpoint")
            return self.serve_static(path)
        except PermissionError as e:
            return self.fail(403, e)
        except FileNotFoundError as e:
            return self.fail(404, e)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001
            return self.fail(500, f"{type(e).__name__}: {e}")

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if not self.authorized():
                self.read_body()
                return self.fail(401, "token required")
            body = self.read_body()
            if path == "/api/jobs":
                return self.api_submit(body)
            if path == "/api/jobs/clear":
                RUNNER.clear_finished()
                return self.send_json({"ok": True})
            m = re.match(r"^/api/jobs/([0-9a-f]+)/cancel$", path)
            if m:
                return self.send_json({"ok": RUNNER.cancel(m.group(1))})
            if path == "/api/proxy":
                return self.api_proxy(body)
            if path == "/api/mkdir":
                p = safe_path(body.get("path"), write=True)
                p.mkdir(parents=True, exist_ok=True)
                return self.send_json({"ok": True, "path": str(p)})
            if path == "/api/stat":
                res = []
                for s in body.get("paths") or []:
                    try:
                        p = safe_path(s)
                        res.append({"path": s, "exists": p.exists(), "size": p.stat().st_size if p.exists() else 0})
                    except PermissionError:
                        res.append({"path": s, "exists": False, "error": "outside roots"})
                return self.send_json(res)
            return self.fail(404, "unknown endpoint")
        except PermissionError as e:
            return self.fail(403, e)
        except FileNotFoundError as e:
            return self.fail(404, e)
        except (ValueError, KeyError, TypeError) as e:
            return self.fail(400, e)
        except Exception as e:  # noqa: BLE001
            return self.fail(500, f"{type(e).__name__}: {e}")

    def api_health(self):
        info = {"ok": True, "version": VERSION, "hostname": socket.gethostname(),
                "needs_token": CFG.token is not None, "authorized": self.authorized()}
        if info["authorized"]:
            info.update({
                "roots": [str(r) for r in CFG.roots], "home": str(Path.home()),
                "ffmpeg": CFG.ffmpeg_version, "encoders": CFG.encoders, "parallel": CFG.parallel,
                "cache": str(CACHE_DIR), "static": str(STATIC_DIR),
                "jobs_running": sum(1 for j in RUNNER.list() if j["status"] == "running"),
            })
        self.send_json(info)

    def api_ls(self, q):
        p = safe_path(q.get("path") or str(CFG.roots[0]))
        if not p.is_dir():
            return self.fail(404, "not a directory")
        dirs, files = [], []
        for e in sorted(p.iterdir(), key=lambda e: e.name.lower()):
            if e.name.startswith("."):
                continue
            try:
                st = e.stat()
            except OSError:
                continue
            if e.is_dir():
                dirs.append({"name": e.name, "path": str(e)})
            elif q.get("all") or e.suffix.lower() in VIDEO_EXT:
                files.append({"name": e.name, "path": str(e), "size": st.st_size, "mtime": st.st_mtime})
        parent = p.parent
        self.send_json({
            "path": str(p), "parent": str(parent) if is_within(parent, CFG.read_roots) else None,
            "dirs": dirs, "files": files, "roots": [str(r) for r in CFG.roots],
        })

    def api_frame(self, q):
        p = safe_path(q.get("path"))
        t = float(q.get("t") or 0)
        w = max(16, min(int(q.get("w") or 640), 4096))
        try:
            data = frame_jpeg(p, t, w)
        except RuntimeError as e:
            return self.fail(422, e)
        self.send_bytes(data, 200, "image/jpeg", {"Cache-Control": "private, max-age=3600"})

    def api_submit(self, body):
        specs = body.get("jobs")
        if not isinstance(specs, list) or not specs:
            raise ValueError("jobs must be a non-empty list")
        ids = []
        for spec in specs:
            args = spec.get("args")
            out = validate_job_args(args)
            if spec.get("output") and safe_path(spec["output"], write=True) != out:
                raise ValueError("output does not match last argument")
            job = Job(spec.get("label") or out.name, args, str(out), spec.get("duration") or 0,
                      "ffmpeg", spec.get("meta"))
            ids.append(RUNNER.submit(job).id)
        self.send_json({"ids": ids})

    def api_proxy(self, body):
        p = safe_path(body.get("path"))
        st = p.stat()
        key = hashlib.sha1(f"{p}|{st.st_mtime_ns}|{st.st_size}".encode()).hexdigest()[:12]
        out = CACHE_DIR / "proxy" / f"{p.stem}.{key}.mp4"
        url = f"/media?path={quote(str(out))}"
        if out.exists():
            return self.send_json({"ready": True, "path": str(out), "url": url})
        for j in RUNNER.list():
            if j["output"] == str(out) and j["status"] in ("queued", "running"):
                return self.send_json({"ready": False, "job_id": j["id"], "path": str(out), "url": url})
        info = probe(p)
        vf = [TONEMAP] if info["video"] and info["video"]["hdr"] else []
        vf += ["scale=min(960\\,iw):-2", "format=yuv420p"]
        if CFG.encoders.get("h264_nvenc"):
            enc = ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "28", "-b:v", "0"]
        else:
            enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26"]
        args = ["-y", "-i", str(p), "-map", "0:v:0", "-map", "0:a:0?", "-vf", ",".join(vf), *enc,
                "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(out)]
        job = RUNNER.submit(Job(f"preview proxy: {p.name}", args, str(out), info["duration"], "proxy"))
        self.send_json({"ready": False, "job_id": job.id, "path": str(out), "url": url})

    def serve_static(self, urlpath):
        rel = urlpath.lstrip("/")
        target = (STATIC_DIR / rel).resolve() if rel else STATIC_DIR
        if not is_within(target, [STATIC_DIR]):
            return self.fail(403, "forbidden")
        if target.is_dir():
            target = target / "index.html"
        hidden = any(part.startswith(".") for part in target.relative_to(STATIC_DIR).parts)
        if hidden or not target.is_file():
            return self.fail(404, "not found")
        self.serve_file(target, ranged=False, cache="no-cache")

    def serve_file(self, path: Path, ranged=True, cache="private, max-age=0"):
        if not path.is_file():
            raise FileNotFoundError(path)
        size = path.stat().st_size
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype == "application/json":
            ctype += "; charset=utf-8"
        start, end, status = 0, size - 1, 200
        rng = self.headers.get("Range") if ranged else None
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
            if not m:
                return self.fail(416, "bad range")
            a, b = m.group(1), m.group(2)
            if a:
                start = int(a)
                end = min(int(b), size - 1) if b else size - 1
            elif b:
                start = max(0, size - int(b))
            if start >= size or start > end:
                self.send_response(416)
                self.cors()
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status = 206
        length = end - start + 1
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", cache)
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(1 << 20, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)


def detect_encoders(ffmpeg):
    r = subprocess.run([ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True)
    names = set(re.findall(r"^\s*V\S*\s+(\S+)", r.stdout, re.M))
    enc = {n: n in names for n in ("libx264", "libx265", "h264_nvenc", "hevc_nvenc", "libsvtav1", "libvpx-vp9")}
    if enc["h264_nvenc"]:
        try:
            t = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                                "color=c=black:s=256x256:d=0.2:r=10", "-c:v", "h264_nvenc", "-f", "null", "-"],
                               capture_output=True, timeout=30)
            ok = t.returncode == 0
        except (subprocess.TimeoutExpired, OSError):
            ok = False
        enc["h264_nvenc"] = ok
        enc["hevc_nvenc"] = enc["hevc_nvenc"] and ok
    return enc


def load_token(args):
    if args.no_token:
        return None
    if args.token:
        return args.token
    if args.host in LOOPBACK:
        return None
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    f = CONFIG_DIR / "token"
    if f.exists() and f.read_text().strip():
        return f.read_text().strip()
    tok = secrets.token_urlsafe(18)
    f.write_text(tok)
    f.chmod(0o600)
    return tok


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1", help="bind address (0.0.0.0 for LAN access)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--root", action="append", help="directory the UI may read and write (repeatable). Default: home")
    ap.add_argument("--parallel", type=int, default=4, help="max ffmpeg jobs at once")
    ap.add_argument("--token", help="access token (auto-generated when host is not loopback)")
    ap.add_argument("--no-token", action="store_true", help="disable the token even on a non-loopback host")
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--ffprobe", default="ffprobe")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    global RUNNER
    CFG.roots = [Path(os.path.expanduser(r)).resolve() for r in (args.root or ["~"])]
    CFG.read_roots = CFG.roots + [CACHE_DIR.resolve()]
    CFG.parallel = max(1, args.parallel)
    CFG.ffmpeg, CFG.ffprobe, CFG.verbose = args.ffmpeg, args.ffprobe, args.verbose
    CFG.token = load_token(args)
    try:
        CFG.ffmpeg_version = subprocess.run([CFG.ffmpeg, "-version"], capture_output=True, text=True).stdout.split("\n")[0]
    except OSError:
        sys.exit(f"ffmpeg not found: {CFG.ffmpeg}")
    CFG.encoders = detect_encoders(CFG.ffmpeg)
    (CACHE_DIR / "frames").mkdir(parents=True, exist_ok=True)
    (CACHE_DIR / "proxy").mkdir(parents=True, exist_ok=True)
    RUNNER = JobRunner(CFG.parallel)

    ThreadingHTTPServer.allow_reuse_address = True
    ThreadingHTTPServer.daemon_threads = True
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    q = f"?token={CFG.token}" if CFG.token else ""
    print(f"videotools server {VERSION}")
    print(f"  {CFG.ffmpeg_version}")
    print(f"  encoders: " + ", ".join(k for k, v in CFG.encoders.items() if v))
    print(f"  roots:    " + ", ".join(str(r) for r in CFG.roots))
    print(f"  UI:       http://localhost:{args.port}/{q}")
    if args.host not in LOOPBACK:
        try:
            ip = socket.gethostbyname(socket.gethostname())
        except OSError:
            ip = args.host
        print(f"            http://{ip}:{args.port}/{q}")
        print(f"  token:    {CFG.token or '(none, open to everyone on the network!)'}")
    print(f"  pages:    https://jhkim.me/videotools/?server=http://localhost:{args.port}" + (f"&token={CFG.token}" if CFG.token else ""))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
