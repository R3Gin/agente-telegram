// Áudio → texto com o whisper.cpp local.
// - Roda fora da fila do Claude: o comando de voz "para" funciona na hora.
// - Um áudio por vez (a CPU da VPS é modesta).
// - "audio_ctx" automático: em áudios curtos o whisper processa só a parte
//   útil da janela de 30s, o que deixa a transcrição bem mais rápida.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../log.js';

const log = logger('audio');
let chain = Promise.resolve();

function run(cmd, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${path.basename(cmd)} passou de ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(cmd)} saiu com código ${code}: ${err.slice(-400)}`));
    });
  });
}

export function audioCtxFor(durationSec, setting = 'auto') {
  if (setting === '0' || setting === 'off' || setting === '') return 0;
  if (/^\d+$/.test(setting)) return Number(setting);
  const d = Number(durationSec) || 0;
  if (d <= 0 || d >= 28) return 0; // 0 = janela inteira
  return Math.min(1500, Math.max(384, Math.ceil((d / 30) * 1500) + 128));
}

export function whisperReady(cfg) {
  return Boolean(cfg.cli && cfg.model && fs.existsSync(cfg.cli) && fs.existsSync(cfg.model));
}

/**
 * Transcreve um arquivo de áudio (ogg/opus do Telegram, mp3, m4a…).
 * @returns {Promise<{text: string, ms: number}>}
 */
export function transcribe(inputFile, { durationSec, cfg }) {
  const job = chain.then(() => doTranscribe(inputFile, { durationSec, cfg }));
  chain = job.catch(() => {});
  return job;
}

async function doTranscribe(inputFile, { durationSec, cfg }) {
  const started = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agente-audio-'));
  const wav = path.join(dir, 'audio.wav');
  try {
    await run(cfg.ffmpeg, ['-nostdin', '-loglevel', 'error', '-y', '-i', inputFile, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], {
      timeoutMs: 60_000,
    });
    const args = ['-m', cfg.model, '-f', wav, '-l', cfg.language, '-t', String(cfg.threads), '-bs', '1', '-bo', '1', '-np', '-nt'];
    const ctx = audioCtxFor(durationSec, cfg.audioCtx);
    if (ctx) args.push('-ac', String(ctx));
    const timeoutMs = Math.max(60_000, (Number(durationSec) || 30) * 10_000);
    const out = await run(cfg.cli, args, { timeoutMs });
    const text = out
      .split('\n')
      .map((l) => l.replace(/^\s*\[[^\]]*\]\s*/, '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const ms = Date.now() - started;
    log.info(`transcrição: ${Math.round(durationSec || 0)}s de áudio em ${(ms / 1000).toFixed(1)}s (ctx=${ctx || 'cheio'})`);
    return { text, ms };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Comandos curtos de voz que agem na hora, sem passar pelo Claude. */
export function voiceCommand(text) {
  const t = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.split(' ').length > 5) return null;
  if (/^(para|parar|pare|stop|cancela|cancelar|chega)( (tudo|ai|isso|agora))?$/.test(t)) return 'stop';
  if (/^(nova conversa|novo chat|nova sessao|limpar|zerar|recomecar|comecar de novo)$/.test(t)) return 'new';
  if (/^(menu|painel|configuracoes|config)$/.test(t)) return 'panel';
  if (/^(continua|continuar|continue|pode continuar|segue|seguir)$/.test(t)) return 'continue';
  return null;
}
