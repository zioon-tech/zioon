#!/bin/sh
set -eu
command -v node >/dev/null 2>&1 || { echo "Install Node.js >=22.5 first: https://nodejs.org/" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required." >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<5))process.exit(1)' || { echo "Node.js >=22.5 is required." >&2; exit 1; }
zioon_prefix="${ZIOON_INSTALL_PREFIX:-$HOME/.local}"
npm install --global --prefix "$zioon_prefix" --ignore-scripts https://zioon.tech/downloads/zioon-cli-0.2.0.tgz
"$zioon_prefix/bin/zioon" --version
printf '\nInstalled Zioon CLI. Add %s/bin to PATH.\nNext: zioon auth login zioon-cloud\n' "$zioon_prefix"
