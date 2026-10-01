#!/usr/bin/env bash
# Instala (ou reinstala) o agente-telegram como serviço systemd.
# Uso (como root, dentro da pasta do projeto):  bash scripts/instalar.sh
# Pode rodar quantas vezes quiser: não apaga nada e não mexe no bot antigo.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
SERVICE=agente-telegram
OLD_ENV=${OLD_ENV:-/home/rmthost/claude-telegram-bridge/.env}

ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
fail() { printf '\033[31m✖\033[0m %s\n' "$*"; exit 1; }

[ "$(id -u)" = 0 ] || fail "rode como root (o login do Claude Code está no root)"

# --- Node -------------------------------------------------------------------
command -v node >/dev/null || fail "node não encontrado"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || fail "precisa de Node 20 ou mais novo (achei $(node -v))"
ok "Node $(node -v)"

# --- Dependências -----------------------------------------------------------
if [ "${SKIP_NPM:-}" != 1 ]; then
  npm ci --no-audit --no-fund --loglevel=error
  ok "dependências instaladas"
fi

# --- .env -------------------------------------------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  ok ".env criado a partir do .env.example"
fi
chmod 600 .env

getenv() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- || true; }
setenv() {
  local key="$1" value="$2"
  if grep -qE "^$key=" .env; then
    local esc
    esc=$(printf '%s' "$value" | sed -e 's/[\/&|]/\\&/g')
    sed -i "s|^$key=.*|$key=$esc|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

# aproveita valores do bot antigo (só leitura)
if [ -f "$OLD_ENV" ]; then
  if [ -z "$(getenv ALLOWED_TELEGRAM_IDS)" ]; then
    ids=$(grep -E '^ALLOWED_TELEGRAM_IDS=' "$OLD_ENV" | tail -n1 | cut -d= -f2- || true)
    [ -n "$ids" ] && setenv ALLOWED_TELEGRAM_IDS "$ids" && ok "ALLOWED_TELEGRAM_IDS copiado do bot antigo"
  fi
  old_whisper=$(grep -E '^WHISPER_CLI_PATH=' "$OLD_ENV" | tail -n1 | cut -d= -f2- || true)
  if [ -n "$old_whisper" ] && [ ! -x "$(getenv WHISPER_CLI)" ] && [ -x "$old_whisper" ]; then
    setenv WHISPER_CLI "$old_whisper" && ok "WHISPER_CLI copiado do bot antigo ($old_whisper)"
  fi
fi

# token do bot novo
if [ -z "$(getenv TELEGRAM_BOT_TOKEN)" ]; then
  if [ -t 0 ]; then
    read -r -s -p "Cole o token do bot NOVO (do @BotFather) e tecle Enter: " tok; echo
    [ -n "$tok" ] && setenv TELEGRAM_BOT_TOKEN "$tok" && ok "token salvo no .env"
  fi
fi
if [ -n "$(getenv TELEGRAM_BOT_TOKEN)" ] && [ -f "$OLD_ENV" ]; then
  old_tok=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$OLD_ENV" | tail -n1 | cut -d= -f2- || true)
  [ "$old_tok" = "$(getenv TELEGRAM_BOT_TOKEN)" ] && fail "o token é o mesmo do bot antigo; use o token do bot NOVO"
fi

# pastas
CWD_DIR=$(getenv AGENT_CWD); CWD_DIR=${CWD_DIR:-/home/rmthost/agente}
mkdir -p "$CWD_DIR" data models
ok "pasta de trabalho: $CWD_DIR"

# --- Claude Code ------------------------------------------------------------
BUNDLED="$DIR/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"
CLAUDE="$(getenv CLAUDE_BIN)"
if [ -z "$CLAUDE" ]; then
  if "$BUNDLED" --version >/dev/null 2>&1; then
    ok "claude do SDK funciona: $("$BUNDLED" --version 2>/dev/null | head -n1)"
    CLAUDE="$BUNDLED"
  elif [ -x /root/.local/bin/claude ]; then
    warn "o claude do SDK não rodou nesta CPU; usando o instalado (/root/.local/bin/claude)"
    setenv CLAUDE_BIN /root/.local/bin/claude
    CLAUDE=/root/.local/bin/claude
  else
    fail "não achei um claude que funcione"
  fi
fi
if HOME=/root "$CLAUDE" auth status >/dev/null 2>&1; then
  ok "Claude Code logado"
else
  warn "o Claude Code parece deslogado: rode 'claude' como root e faça /login"
fi

# --- Whisper ----------------------------------------------------------------
WMODEL=$(getenv WHISPER_MODEL)
if [ -n "$WMODEL" ] && [ ! -s "$WMODEL" ]; then
  name=$(basename "$WMODEL" .bin); name=${name#ggml-}
  url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$name.bin"
  echo "baixando modelo de áudio $name…"
  mkdir -p "$(dirname "$WMODEL")"
  if curl -fL --retry 3 -o "$WMODEL.tmp" "$url"; then
    mv "$WMODEL.tmp" "$WMODEL" && ok "modelo de áudio salvo em $WMODEL"
  else
    rm -f "$WMODEL.tmp"; warn "não consegui baixar o modelo de áudio ($url); o resto funciona"
  fi
fi
[ -x "$(getenv WHISPER_CLI)" ] || warn "WHISPER_CLI não encontrado: áudio fica desativado até ajustar o .env"

# --- systemd ----------------------------------------------------------------
if [ -z "$(getenv TELEGRAM_BOT_TOKEN)" ] || [ -z "$(getenv ALLOWED_TELEGRAM_IDS)" ]; then
  warn "falta TELEGRAM_BOT_TOKEN ou ALLOWED_TELEGRAM_IDS no $DIR/.env"
  warn "preencha e rode de novo: bash scripts/instalar.sh"
  exit 0
fi

UNIT=/etc/systemd/system/$SERVICE.service
sed -e "s|/home/rmthost/agente-telegram|$DIR|g" -e "s|/usr/bin/node|$(command -v node)|g" deploy/$SERVICE.service > "$UNIT"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"
sleep 6
if systemctl is-active --quiet "$SERVICE"; then
  ok "serviço $SERVICE rodando"
else
  warn "o serviço não subiu; veja: journalctl -u $SERVICE -n 50 --no-pager"
fi
journalctl -u "$SERVICE" -n 15 --no-pager || true
echo
ok "pronto. Abra o bot novo no Telegram e mande /start"
