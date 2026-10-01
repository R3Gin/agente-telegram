#!/usr/bin/env bash
# Atualiza o agente-telegram para a versão mais nova do GitHub e reinicia.
# Uso (como root, na pasta do projeto):  bash scripts/atualizar.sh
#
# Se for pedir para o próprio bot novo se atualizar, o reinício acontece
# alguns segundos depois (systemd-run), para ele conseguir te responder antes.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

git pull --ff-only
npm ci --no-audit --no-fund --loglevel=error
echo "✔ código atualizado: $(git log -1 --format='%h %s')"

if [ "${1:-}" = "--agora" ]; then
  systemctl restart agente-telegram
  echo "✔ reiniciado"
else
  systemd-run --on-active=8 --unit="agente-telegram-restart-$(date +%s)" /bin/systemctl restart agente-telegram >/dev/null
  echo "✔ o bot reinicia em ~8 segundos"
fi
