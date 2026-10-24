#!/usr/bin/env bash
#
# Prepares a Debian or Ubuntu VPS to run Jinx.
#
# Installs the system packages the capture pipeline needs, then checks that
# Node is new enough. Run it once, as a user with sudo:
#
#   bash scripts/setup-vps.sh
#
# It does not start anything and does not touch your tokens.

set -euo pipefail

# The video streaming library declares engines >=22.4.0. Older Node installs
# still work but warn on every install, so ask for it outright.
MIN_NODE_MAJOR=22

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*"; }

if [[ $EUID -eq 0 ]]; then
  SUDO=""
else
  SUDO="sudo"
fi

echo "== Jinx setup =="
echo

echo "-- system packages"
# ffmpeg/ffprobe  capture and remux
# xvfb            the virtual display Chromium renders into
# pulseaudio      the null sink that gives the capture an audio device
# libnss3 & co    Chromium's shared library dependencies
$SUDO apt-get update -qq
$SUDO apt-get install -y --no-install-recommends \
  ca-certificates curl git \
  ffmpeg \
  xvfb \
  pulseaudio pulseaudio-utils alsa-utils \
  fonts-dejavu-core \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2

echo
echo "-- node"
if ! command -v node >/dev/null 2>&1; then
  red "node is not installed. Install Node ${MIN_NODE_MAJOR} or newer:"
  echo "    curl -fsSL https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x | sudo -E bash -"
  echo "    sudo apt-get install -y nodejs"
  exit 1
fi

NODE_VERSION=$(node -p 'process.versions.node')
NODE_MAJOR=${NODE_VERSION%%.*}
echo "   found node ${NODE_VERSION}"
if (( NODE_MAJOR < MIN_NODE_MAJOR )); then
  warn "   that is older than ${MIN_NODE_MAJOR}. The streaming library wants >=22.4.0."
  warn "   Install it with:"
  echo "     curl -fsSL https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x | sudo -E bash -"
  echo "     sudo apt-get install -y nodejs"
fi

echo
echo "-- chromium for playwright"
# Playwright downloads its own Chromium, but it needs the system libraries
# installed above to be present first, which is why this runs after apt.
npx --yes playwright install chromium || warn "   playwright chromium install failed; run it again by hand"

echo
echo "-- npm dependencies"
npm install

echo
echo "-- .env"
if [[ -f .env ]]; then
  green "   .env already exists, leaving it alone"
else
  cp .env.example .env
  warn "   created .env from .env.example. Edit it and put your tokens in."
fi

echo
echo "== done =="
echo
echo "Next steps:"
echo "  1. edit .env and fill in DISCORD_USER_TOKEN and DISCORD_BOT_TOKEN"
echo "  2. node scripts/diagnose.js      to check the pipeline"
echo "  3. node run.js check             to check both bots can reach Discord"
echo "  4. node run.js                   to start both"
