#!/bin/bash
# ==============================================================================
# Oggy EC2 Instance Setup Script
# Run this ONCE on a fresh Ubuntu 22.04/24.04 LTS EC2 instance.
#
# Prerequisites:
#   - EC2 instance: t3.small or t3.medium
#   - Storage: 50-100GB gp3 EBS
#   - Security group: SSH (22) from your IP only
#   - Ubuntu 22.04 or 24.04 LTS AMI
#
# Usage: ssh into EC2, then:
#   curl -sSL https://raw.githubusercontent.com/<your-repo>/main/deploy/ec2-setup.sh | bash
#   OR: scp this file to EC2, then: chmod +x ec2-setup.sh && sudo ./ec2-setup.sh
# ==============================================================================

set -euo pipefail

echo "=========================================="
echo "  Oggy EC2 Setup"
echo "=========================================="

# Must run as root
if [ "$EUID" -ne 0 ]; then
    echo "Please run as root: sudo ./ec2-setup.sh"
    exit 1
fi

# --- System Updates ---
echo "[1/8] Updating system packages..."
apt-get update -y
apt-get upgrade -y
apt-get install -y \
    apt-transport-https \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    unzip \
    fail2ban \
    ufw \
    jq \
    htop

# --- Docker ---
echo "[2/8] Installing Docker..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
else
    echo "Docker already installed."
fi

# --- Docker Compose ---
echo "[3/8] Installing Docker Compose plugin..."
apt-get install -y docker-compose-plugin 2>/dev/null || true
docker compose version

# --- Create oggy user ---
echo "[4/8] Creating oggy user..."
if ! id "oggy" &>/dev/null; then
    useradd -m -s /bin/bash -G docker oggy
    echo "Created user 'oggy' with docker access."
else
    usermod -aG docker oggy
    echo "User 'oggy' already exists, added to docker group."
fi

# --- Firewall ---
echo "[5/8] Configuring UFW firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
# No need to open 3001 — Cloudflare Tunnel handles inbound traffic via localhost
ufw --force enable
echo "Firewall enabled. Only SSH (22) is open externally."

# --- Fail2Ban ---
echo "[6/8] Configuring Fail2Ban..."
systemctl enable fail2ban
systemctl start fail2ban

cat > /etc/fail2ban/jail.local <<'JAILEOF'
[sshd]
enabled = true
port = 22
filter = sshd
logpath = /var/log/auth.log
maxretry = 5
bantime = 3600
findtime = 600
JAILEOF

systemctl restart fail2ban
echo "Fail2Ban configured: 5 failed SSH attempts = 1hr ban."

# --- AWS CLI (for S3 backups) ---
echo "[7/8] Installing AWS CLI..."
if ! command -v aws &> /dev/null; then
    curl -sSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
    unzip -q /tmp/awscliv2.zip -d /tmp
    /tmp/aws/install
    rm -rf /tmp/awscliv2.zip /tmp/aws
else
    echo "AWS CLI already installed."
fi

# --- Cloudflared ---
echo "[8/8] Installing cloudflared..."
if ! command -v cloudflared &> /dev/null; then
    curl -sSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
    dpkg -i /tmp/cloudflared.deb
    rm /tmp/cloudflared.deb
else
    echo "cloudflared already installed."
fi

# --- Project Directory ---
echo ""
echo "Creating /opt/oggy directory..."
mkdir -p /opt/oggy
chown oggy:oggy /opt/oggy

# --- SSH hardening ---
echo "Hardening SSH..."
# Disable password auth (use key-based only)
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart ssh

# --- Swap file (helpful for t3.small with 2GB RAM) ---
echo "Setting up 2GB swap file..."
if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    # Optimize swap behavior
    echo 'vm.swappiness=10' >> /etc/sysctl.conf
    sysctl -p
    echo "2GB swap created."
else
    echo "Swap already exists."
fi

echo ""
echo "=========================================="
echo "  Setup Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "  1. Switch to oggy user:     sudo su - oggy"
echo "  2. Clone your repo:         cd /opt/oggy && git clone <your-repo-url> ."
echo "  3. Copy .env:               cp .env.example .env && nano .env"
echo "  4. Configure AWS creds:     aws configure  (for S3 backups)"
echo "  5. Setup tunnel:            sudo ./deploy/setup-tunnel.sh"
echo "  6. Deploy:                  ./deploy/deploy.sh"
echo ""
