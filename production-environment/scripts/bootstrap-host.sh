#!/usr/bin/env bash
# Bootstrap a fresh Ubuntu VPS for Sillage: Docker, Caddy, ubuntu deploy user.
# Run as root via: ssh hetzner 'bash -s' < bootstrap-host.sh
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

echo "==> apt update + base packages"
apt-get update -y
apt-get install -y ca-certificates curl gnupg ufw fail2ban apache2-utils rsync unzip python3

if ! id -u ubuntu >/dev/null 2>&1; then
  echo "==> create ubuntu user"
  adduser --disabled-password --gecos "" ubuntu
  usermod -aG sudo ubuntu
  echo "ubuntu ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/ubuntu
  chmod 440 /etc/sudoers.d/ubuntu
  mkdir -p /home/ubuntu/.ssh
  if [[ -f /root/.ssh/authorized_keys ]]; then
    cp /root/.ssh/authorized_keys /home/ubuntu/.ssh/authorized_keys
  fi
  chown -R ubuntu:ubuntu /home/ubuntu/.ssh
  chmod 700 /home/ubuntu/.ssh
  chmod 600 /home/ubuntu/.ssh/authorized_keys 2>/dev/null || true
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "==> install Docker Engine"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  # Docker's Ubuntu repo lags new development releases (e.g. 26.04 resolute).
  DOCKER_SUITE="${VERSION_CODENAME}"
  if ! curl -fsI "https://download.docker.com/linux/ubuntu/dists/${DOCKER_SUITE}/Release" >/dev/null 2>&1; then
    echo "NOTE: no Docker repo for ${DOCKER_SUITE}; using noble (24.04) packages"
    DOCKER_SUITE=noble
  fi
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${DOCKER_SUITE} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
usermod -aG docker ubuntu
systemctl enable --now docker

if ! command -v caddy >/dev/null 2>&1; then
  echo "==> install Caddy"
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    >/etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi
systemctl enable --now caddy

# A full vendor sync peaks around 2 GB of Bun heap. On a 4 GB box running two shops that
# is enough for the kernel to OOM-kill whatever it likes — including Apache and MariaDB,
# which takes the storefront down mid-sync. Swap absorbs the peak instead.
if ! swapon --show | grep -q '^/swapfile'; then
  echo "==> 4G swapfile"
  fallocate -l 4G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=4096
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo "/swapfile none swap sw 0 0" >>/etc/fstab
  mkdir -p /etc/sysctl.d
  echo "vm.swappiness=10" >/etc/sysctl.d/99-sillage-swap.conf
  sysctl -p /etc/sysctl.d/99-sillage-swap.conf >/dev/null
fi

echo "==> firewall"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> docker networks"
docker network create ecom_network 2>/dev/null || true
docker network create redis_network 2>/dev/null || true

echo "BOOTSTRAP_HOST_DONE"
docker --version
caddy version
id ubuntu
