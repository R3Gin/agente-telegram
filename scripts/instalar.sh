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

# token do bot novo ------------------------------------------------------------
TG_API="${TG_API:-https://api.telegram.org}"
is_tty() { [ -t 0 ] || [ "${FORCE_TTY:-}" = 1 ]; }

# Tira o lixo da colagem: token colado duas vezes, espaços, códigos do terminal.
extract_token() {
  local raw="$1" t
  t=$(printf '%s' "$raw" | grep -oE '[0-9]{6,12}:[A-Za-z0-9_-]{35}' | head -n1 || true)
  [ -n "$t" ] || t=$(printf '%s' "$raw" | grep -oE '[0-9]{6,12}:[A-Za-z0-9_-]{30,}' | head -n1 || true)
  printf '%s' "$t"
}

# Pergunta ao Telegram se o token funciona e imprime o @usuario do bot.
# Retorno: 0 = ok, 1 = o Telegram recusou, 2 = sem resposta (rede).
check_token() {
  local resp
  resp=$(curl -sS --max-time 15 "$TG_API/bot$1/getMe" 2>/dev/null) || return 2
  [[ "$resp" == *'"ok":true'* ]] || return 1
  if [[ "$resp" =~ \"username\":\"([^\"]+)\" ]]; then printf '%s' "${BASH_REMATCH[1]}"; else printf 'bot'; fi
}

OLD_TOKEN=""
[ -f "$OLD_ENV" ] && OLD_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$OLD_ENV" | tail -n1 | cut -d= -f2- || true)

TOKEN="$(getenv TELEGRAM_BOT_TOKEN)"
BOTNAME=""
if [ -n "$TOKEN" ]; then
  clean=$(extract_token "$TOKEN")
  rc=1
  if [ -n "$clean" ]; then rc=0; BOTNAME=$(check_token "$clean") || rc=$?; fi
  if [ "$rc" = 0 ]; then
    if [ "$clean" != "$TOKEN" ]; then setenv TELEGRAM_BOT_TOKEN "$clean"; ok "token do .env corrigido (tinha sobra da colagem)"; fi
    TOKEN="$clean"
  elif [ "$rc" = 2 ]; then
    warn "não consegui falar com o Telegram agora; mantendo o token do .env sem conferir"
    [ "$clean" != "$TOKEN" ] && setenv TELEGRAM_BOT_TOKEN "$clean"
    TOKEN="$clean"
  else
    warn "o token que está no .env não funciona (provavelmente foi colado mais de uma vez)"
    TOKEN=""
    setenv TELEGRAM_BOT_TOKEN ""
  fi
fi
if [ -z "$TOKEN" ] && is_tty; then
  for _try in 1 2 3; do
    echo
    echo "Cole o token do bot NOVO (do @BotFather) UMA vez e tecle Enter."
    echo "Ele tem este formato: 123456789:AAH... (o texto vai aparecer na tela)"
    read -r -p "token: " raw || true
    clean=$(extract_token "$raw")
    if [ -z "$clean" ]; then
      warn "isso não parece um token"
      continue
    fi
    if [ -n "$OLD_TOKEN" ] && [ "$clean" = "$OLD_TOKEN" ]; then
      warn "esse é o token do bot ANTIGO; use o do bot novo"
      continue
    fi
    rc=0
    BOTNAME=$(check_token "$clean") || rc=$?
    if [ "$rc" = 0 ] || [ "$rc" = 2 ]; then
      [ "$rc" = 2 ] && warn "não consegui conferir com o Telegram agora; vou salvar assim mesmo"
      setenv TELEGRAM_BOT_TOKEN "$clean"
      TOKEN="$clean"
      break
    fi
    warn "o Telegram recusou esse token; confira no @BotFather (/mybots → seu bot → API Token)"
  done
fi
if [ -n "$TOKEN" ]; then
  [ -n "$OLD_TOKEN" ] && [ "$TOKEN" = "$OLD_TOKEN" ] && fail "o token é o mesmo do bot antigo; use o token do bot NOVO"
  if [ -n "$BOTNAME" ]; then ok "token válido: @$BOTNAME"; else BOTNAME="o bot novo"; fi
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
[ "${SKIP_SYSTEMD:-}" = 1 ] && { ok "(teste) parando antes do systemd"; exit 0; }
if [ -z "$TOKEN" ] || [ -z "$(getenv ALLOWED_TELEGRAM_IDS)" ]; then
  [ -z "$TOKEN" ] && warn "falta um token válido do bot novo em TELEGRAM_BOT_TOKEN ($DIR/.env)"
  [ -z "$(getenv ALLOWED_TELEGRAM_IDS)" ] && warn "falta o seu ID do Telegram em ALLOWED_TELEGRAM_IDS ($DIR/.env)"
  systemctl stop "$SERVICE" >/dev/null 2>&1 || true
  warn "rode de novo: bash scripts/instalar.sh"
  exit 1
fi

UNIT=/etc/systemd/system/$SERVICE.service
sed -e "s|/home/rmthost/agente-telegram|$DIR|g" -e "s|/usr/bin/node|$(command -v node)|g" deploy/$SERVICE.service > "$UNIT"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
START_TS=$(date '+%Y-%m-%d %H:%M:%S')
systemctl restart "$SERVICE"
sleep 8
started=0
if systemctl is-active --quiet "$SERVICE"; then
  case "$(getenv LOG_LEVEL)" in
    warn|error) started=1 ;;
    *) journalctl -u "$SERVICE" --since "$START_TS" --no-pager 2>/dev/null | grep -q "recebendo mensagens" && started=1 ;;
  esac
fi
if [ "$started" = 1 ]; then
  ok "serviço $SERVICE rodando"
  echo
  if [ "$BOTNAME" = "o bot novo" ]; then ok "pronto. Abra o bot novo no Telegram e mande /start"; else ok "pronto. Abra @$BOTNAME no Telegram e mande /start"; fi
else
  journalctl -u "$SERVICE" -n 20 --no-pager || true
  echo
  fail "o serviço não subiu direito; me mande as linhas acima"
fi
