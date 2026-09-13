#!/usr/bin/env bash
# Dependency setup only by default. --start explicitly starts the stored-wallet bot.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"
command -v node >/dev/null || { printf '%s\n' 'Install Node.js >=22.22.0 first.'; exit 1; }
node -e "const [a,b]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&b<22))process.exit(1)" || { printf '%s\n' 'Node.js >=22.22.0 required.'; exit 1; }
npm ci
printf '%s\n' 'Dependencies installed. Configure .env from .env.example; see README for npm run connect or npm start.'
if [[ "${1:-}" == '--start' ]]; then
  [[ -f .env ]] || { printf '%s\n' 'Create .env first.'; exit 1; }
  command -v pm2 >/dev/null || { printf '%s\n' 'Install PM2 explicitly, or use npm start.'; exit 1; }
  npm run bootstrap
  if pm2 describe hip-4-telegram-bot >/dev/null 2>&1; then
    printf '%s\n' 'Existing PM2 process found; refusing automatic restart. Inspect and restart explicitly.'
    exit 1
  fi
  pm2 start ecosystem.config.cjs
fi
