#!/usr/bin/env bash
# Compara velocidade e qualidade dos modelos de áudio nesta VPS.
# Uso: bash scripts/comparar-audio.sh <arquivo de áudio> [modelo1.bin modelo2.bin ...]
# Sem modelos, compara o tiny (do bot novo) com o base (do bot antigo).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUDIO="${1:?informe um arquivo de áudio (ex.: um .ogg do Telegram)}"; shift || true
CLI=$(grep -E '^WHISPER_CLI=' "$DIR/.env" 2>/dev/null | cut -d= -f2- || true)
CLI=${CLI:-/home/rmthost/whisper.cpp/build/bin/whisper-cli}
MODELS=("$@")
[ ${#MODELS[@]} -gt 0 ] || MODELS=("$DIR/models/ggml-tiny-q5_1.bin" /home/rmthost/whisper.cpp/models/ggml-base-q5_1.bin)

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
ffmpeg -nostdin -loglevel error -y -i "$AUDIO" -ar 16000 -ac 1 -c:a pcm_s16le "$TMP/a.wav"
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$TMP/a.wav" | cut -d. -f1)
CTX=0
if [ "${DUR:-0}" -lt 28 ]; then CTX=$(( (DUR * 1500 + 29) / 30 + 128 )); [ $CTX -lt 384 ] && CTX=384; fi
echo "áudio: ${DUR}s"
for m in "${MODELS[@]}"; do
  [ -f "$m" ] || { echo "-- $m não existe"; continue; }
  for ctx in 0 $CTX; do
    [ "$ctx" = 0 ] && label="janela cheia" || label="audio_ctx=$ctx"
    args=(-m "$m" -f "$TMP/a.wav" -l pt -t 2 -bs 1 -bo 1 -np -nt)
    [ "$ctx" != 0 ] && args+=(-ac "$ctx")
    start=$(date +%s.%N)
    out=$("$CLI" "${args[@]}" 2>/dev/null | tr '\n' ' ')
    end=$(date +%s.%N)
    printf '\n== %s (%s): %.1fs\n%s\n' "$(basename "$m")" "$label" "$(echo "$end - $start" | bc)" "$out"
    [ "$CTX" = 0 ] && break
  done
done
