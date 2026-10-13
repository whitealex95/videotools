# videotools

Small ffmpeg helpers for research videos, as a static web page plus an optional local job server.

Live page: https://jhkim.me/videotools/

| Tool | What it does |
|---|---|
| **Convert** | Batch re-encode to web-safe MP4 (H.264 + AAC) for Notion, Slack, GitHub. Rename with patterns, resize, HDR → SDR, NVENC. |
| **Crop** | Draw a box on a frame, optional time trim. |
| **Side by side** | Crop, resize and place two videos on one canvas, with start offsets and labels. |
| **Sync** | Play two recordings together and tune the offset frame by frame. Sends the result to Side by side. |

Each tool can produce the result in three ways:

1. **Export in browser.** Decodes and encodes inside the browser with WebCodecs (through the [mediabunny](https://mediabunny.dev) library) and downloads the file. No server, no ffmpeg. Works for local files and for server files. Limits: the browser must be able to decode the input (Chrome on Linux cannot decode 10-bit HDR HEVC from iPhones, for example), audio is AAC where the browser has an encoder and Opus otherwise, and HDR to SDR colors are the browser's. Chrome asks once for permission to download several files when you export a batch.
2. **Run on server.** With the job server running on the machine that holds the videos, the page sends the ffmpeg command there and shows progress. Handles every format and uses NVENC.
3. **Copy command.** Every tool always shows the ffmpeg command, which you can run yourself.

## Job server

Needs only Python 3.8+ and ffmpeg. No pip packages.

```bash
git clone https://github.com/whitealex95/videotools ~/Projects/videotools
python3 ~/Projects/videotools/server/videotools_server.py --root ~/Downloads --root ~/Projects
```

Then open https://jhkim.me/videotools/ (it connects to `localhost:8765` by itself) or http://localhost:8765/ (the server serves the same UI).

Options: `--root DIR` (repeatable, which folders the UI may read and write, default: home), `--port`, `--parallel N` (ffmpeg jobs at once, default 4), `--host 0.0.0.0` (see below), `-v` (log every request and command).

### Run it as a background service (systemd user unit)

```bash
bash ~/Projects/videotools/server/install_service.sh
```

This installs `~/.config/systemd/user/videotools.service`, starts it, and enables it at boot (with `loginctl enable-linger` so it does not need a login session). Logs: `journalctl --user -u videotools -f`.

### Use it from another machine

Browsers block a page on `https://jhkim.me` from talking to a plain `http://` server unless that server is `localhost`. Two ways around it:

1. **ssh tunnel (recommended).** On your laptop: `ssh -N -L 8765:localhost:8765 cc-thunderbluff`. Now `localhost:8765` on the laptop is the remote server, and the page works unchanged. No open port, no token.
2. **Direct.** Start the server with `--host 0.0.0.0`. It prints a token and a URL like `http://130.207.121.197:8765/?token=...`. Open that URL (the server serves the UI itself, so there is no mixed-content problem). The port must be open in the firewall: `sudo ufw allow 8765/tcp`. The token is stored in `~/.config/videotools/token`.

If Chrome asks for permission to access the local network, allow it.

### Security notes

- The server only reads and writes under the `--root` folders. Paths in job arguments are checked against them.
- It only ever runs `ffmpeg` (and `ffprobe`); the page sends ffmpeg arguments, not shell commands.
- With `--host 0.0.0.0` a token is required for every request. Do not disable it on a shared network.

## Development

Plain HTML + ES modules, no build step. Push to `main` and GitHub Pages deploys it. For local work, the server serves the repo root at http://localhost:8765/ with `Cache-Control: no-cache`, so a reload picks up edits.

```
index.html            landing page
assets/common.js      server client, file picker, jobs drawer, command panel
assets/encode.js      encoder options + ffmpeg argument builder
assets/browserexport.js  WebCodecs export (mediabunny): single-file convert/crop and canvas compositing
assets/scrubber.js    frame preview with time slider
assets/cropbox.js     draggable crop rectangle
convert/ crop/ sidebyside/ sync/   one folder per tool
server/videotools_server.py        the job server
```
