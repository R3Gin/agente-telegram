// Lê e valida a configuração do .env. Tudo que é opcional tem um padrão.
import path from 'node:path';
import fs from 'node:fs';

const MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CONFIRM_MODES = ['risky', 'writes', 'off'];
const STREAM_MODES = ['draft', 'edit'];

function int(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function oneOf(value, allowed, fallback) {
  const v = String(value ?? '').trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

export function loadConfig(env = process.env) {
  const errors = [];
  const token = (env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) errors.push('TELEGRAM_BOT_TOKEN não definido');

  const allowedIds = String(env.ALLOWED_TELEGRAM_IDS || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!allowedIds.length) errors.push('ALLOWED_TELEGRAM_IDS vazio: informe pelo menos um ID numérico do Telegram');

  const cwd = path.resolve(env.AGENT_CWD || path.join(process.cwd(), 'workspace'));
  const dataDir = path.resolve(env.DATA_DIR || path.join(process.cwd(), 'data'));

  if (errors.length) {
    const err = new Error(`Configuração inválida:\n- ${errors.join('\n- ')}`);
    err.configErrors = errors;
    throw err;
  }

  const whisperModel = env.WHISPER_MODEL ? path.resolve(env.WHISPER_MODEL) : '';

  return {
    token,
    allowedIds,
    cwd,
    dataDir,
    telegramApiRoot: env.TELEGRAM_API_ROOT || undefined, // usado nos testes
    claude: {
      bin: env.CLAUDE_BIN ? path.resolve(env.CLAUDE_BIN) : undefined,
      defaultModel: oneOf(env.DEFAULT_MODEL, MODELS, 'sonnet'),
      defaultEffort: oneOf(env.DEFAULT_EFFORT, EFFORTS, 'low'),
      maxTurns: Math.max(1, int(env.MAX_TURNS, 80)),
      extraEnv: env.CLAUDE_EXTRA_ENV ? JSON.parse(env.CLAUDE_EXTRA_ENV) : {},
      settingSources: env.CLAUDE_SETTING_SOURCES
        ? env.CLAUDE_SETTING_SOURCES.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined,
      promptSuggestions: String(env.PROMPT_SUGGESTIONS ?? 'true').toLowerCase() !== 'false',
    },
    defaults: {
      confirm: oneOf(env.CONFIRM_MODE, CONFIRM_MODES, 'risky'),
      streamMode: oneOf(env.STREAM_MODE, STREAM_MODES, 'draft'),
      autoNewHours: Math.max(0, int(env.AUTO_NEW_SESSION_HOURS, 6)),
      showThinking: String(env.SHOW_THINKING || '').toLowerCase() === 'true',
    },
    timing: {
      longTaskNoticeMs: Math.max(0.05, int(env.LONG_TASK_NOTICE_MIN, 5)) * 60_000,
      stallMs: Math.max(0.05, int(env.STALL_MIN, 10)) * 60_000,
      draftIntervalMs: Math.max(300, int(env.DRAFT_INTERVAL_MS, 900)),
      editIntervalMs: Math.max(1000, int(env.EDIT_INTERVAL_MS, 1600)),
      heartbeatMs: Math.max(1000, int(env.HEARTBEAT_MS, 4000)),
      pollStaleMs: Math.max(60_000, int(env.POLL_STALE_MS, 300_000)),
    },
    whisper: {
      cli: env.WHISPER_CLI || '',
      model: whisperModel,
      language: env.WHISPER_LANGUAGE || 'pt',
      threads: Math.max(1, int(env.WHISPER_THREADS, 2)),
      audioCtx: (env.WHISPER_AUDIO_CTX || 'auto').trim().toLowerCase(),
      ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
    },
    logLevel: oneOf(env.LOG_LEVEL, ['debug', 'info', 'warn', 'error'], 'info'),
  };
}

export function ensureDirs(config) {
  for (const dir of [config.cwd, config.dataDir]) fs.mkdirSync(dir, { recursive: true });
}

export const CHOICES = { MODELS, EFFORTS, CONFIRM_MODES, STREAM_MODES };
