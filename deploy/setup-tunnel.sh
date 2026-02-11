#!/bin/bash
# ==============================================================================
# Cloudflare Tunnel Setup for EC2
# Installs cloudflared as a systemd service that starts on boot.
#
# Prerequisites:
#   - cloudflared installed (done by ec2-setup.sh)
#   - CLOUDFLARE_TUNNEL_TOKEN in /opt/oggy/.env
#
# Usage: sudo ./deploy/setup-tunnel.sh
# ==============================================================================

set -euo pipefail

OGGY_DIR="/opt/oggy"
ENV_FILE="$OGGY_DIR/.env"

# Must run as root
if [ "$EUID" -ne 0 ]; then
    echo "Please run as root: sudo ./deploy/setup-tunnel.sh"
    exit 1
fi

# Load tunnel token from .env
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found. Copy .env.example and fill in values first."
    exit 1
fi

TUNNEL_TOKEN=$(grep -E '^CLOUDFLARE_TUNNEL_TOKEN=' "$ENV_FILE" | cut -d'=' -f2-)

if [ -z "$TUNNEL_TOKEN" ]; then
    echo "ERROR: CLOUDFLARE_TUNNEL_TOKEN not found in $ENV_FILE"
    exit 1
fi

echo "Setting up Cloudflare Tunnel as systemd service..."

# Create systemd service
cat > /etc/systemd/system/cloudflared-tunnel.service <<SVCEOF
[Unit]
Description=Cloudflare Tunnel for Oggy
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=/usr/bin/cloudflared tunnel run --token ${TUNNEL_TOKEN}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

# Add hosts entry so cloudflared can resolve application-service to localhost
if ! grep -q "application-service" /etc/hosts; then
    echo "127.0.0.1 application-service" >> /etc/hosts
    echo "Added hosts entry: 127.0.0.1 application-service"
fi

# Enable and start
systemctl daemon-reload
systemctl enable cloudflared-tunnel.service
systemctl start cloudflared-tunnel.service

echo ""
echo "Cloudflare Tunnel service installed and started!"
echo ""
echo "Commands:"
echo "  Status:   sudo systemctl status cloudflared-tunnel"
echo "  Logs:     sudo journalctl -u cloudflared-tunnel -f"
echo "  Restart:  sudo systemctl restart cloudflared-tunnel"
echo "  Stop:     sudo systemctl stop cloudflared-tunnel"
echo ""
