#!/bin/bash
# Installs the job server as a systemd user service that starts at boot.
#   bash install_service.sh [extra server args...]
# Example: bash install_service.sh --root ~/Downloads --root ~/Projects --parallel 4
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PYTHON="$(command -v python3)"
ARGS="${*:---root $HOME/Downloads --root $HOME/Projects}"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/videotools.service" <<EOF
[Unit]
Description=videotools job server
After=network.target

[Service]
ExecStart=$PYTHON -u $HERE/videotools_server.py $ARGS
Restart=on-failure
RestartSec=3
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now videotools.service
loginctl enable-linger "$USER" 2>/dev/null || echo "note: 'loginctl enable-linger' failed; the service stops when you log out"
sleep 1
systemctl --user --no-pager status videotools.service | head -5
echo
echo "logs: journalctl --user -u videotools -f"
