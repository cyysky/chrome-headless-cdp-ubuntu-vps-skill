#!/usr/bin/env bash
# Install cdp-manage on the browser host. Run as root.
#
#   sudo bash deploy.sh [source-dir]
#
# Idempotent: keeps an existing token, refreshes the code, rewrites the unit to
# the install path, restarts the service and prints the token for the caller.
#
# Overrides:
#   CDP_MANAGE_DEST  install directory (default: this script's directory)
#   CDP_MANAGE_USER  service account (default: server)
set -euo pipefail

SRC_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
DEST="${CDP_MANAGE_DEST:-$SRC_DIR}"
RUN_USER="${CDP_MANAGE_USER:-server}"
ENV_DIR=/etc/cdp-manage
ENV_FILE="$ENV_DIR/env"

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "node not found on PATH; install Node.js >= 22 first" >&2
  exit 1
fi

install -d -m 755 "$DEST" "$DEST/public"
if [[ "$SRC_DIR" != "$DEST" ]]; then
  install -m 644 "$SRC_DIR/server.mjs" "$DEST/server.mjs"
  install -m 644 "$SRC_DIR/public/index.html" "$DEST/public/index.html"
fi
install -m 644 "$SRC_DIR/cdp-manage.service" /etc/systemd/system/cdp-manage.service
chown -R "$RUN_USER:$RUN_USER" "$DEST"

sed -i -e "s|^User=.*|User=$RUN_USER|" \
       -e "s|^Group=.*|Group=$RUN_USER|" \
       -e "s|^WorkingDirectory=.*|WorkingDirectory=$DEST|" \
       -e "s|^ExecStart=.*|ExecStart=$NODE $DEST/server.mjs|" \
       /etc/systemd/system/cdp-manage.service

install -d -m 750 "$ENV_DIR"
if [[ -f "$ENV_FILE" ]] && grep -q '^MGMT_TOKEN=' "$ENV_FILE"; then
  TOKEN="$(sed -n 's/^MGMT_TOKEN=//p' "$ENV_FILE" | head -1)"
else
  TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | cut -c1-32)"
fi

cat > "$ENV_FILE" <<ENVEOF
MGMT_BIND=${MGMT_BIND:-0.0.0.0}
MGMT_PORT=${MGMT_PORT:-9300}
MGMT_TOKEN=$TOKEN
CDP_HTTP=${CDP_HTTP:-http://127.0.0.1:9222}
MGMT_MAX_TABS=${MGMT_MAX_TABS:-10}
ENVEOF
chmod 600 "$ENV_FILE"

systemctl daemon-reload
systemctl enable cdp-manage.service >/dev/null
systemctl restart cdp-manage.service
sleep 1

systemctl --no-pager --lines=8 status cdp-manage.service || true
echo
echo "TOKEN=$TOKEN"
