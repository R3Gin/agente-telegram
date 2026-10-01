// Monta o bot de verdade contra um Telegram falso e uma API da Anthropic falsa.
// O Claude Code que roda é o binário real (o mesmo do SDK), então os testes
// exercitam o protocolo de verdade: sessão contínua, perguntas, permissões,
// interrupção, novas tentativas etc.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeAnthropic, lastToolResults, toolResultText } from './fake-anthropic.js';
import { startFakeTelegram } from './fake-telegram.js';
import { loadConfig } from '../../src/config.js';
import { createApp } from '../../src/telegram/bot.js';
import { setLogLevel } from '../../src/log.js';

export const USER = 4242;

// O Claude Code dos testes não pode herdar variáveis do ambiente onde os testes rodam.
for (const k of Object.keys(process.env)) {
  if (/^(CLAUDE|CCR_|ANTHROPIC|CLAUDECODE)/.test(k)) delete process.env[k];
}

/** Última mensagem "humana" (com texto) e os resultados de ferramenta depois dela. */
export function conversationState(body) {
  // achata os blocos das mensagens do usuário, em ordem
  const flat = [];
  for (const m of body.messages || []) {
    if (m.role !== 'user') continue;
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    blocks.forEach((b) => flat.push({ b, msg: m }));
  }
  let idx = -1;
  for (let i = flat.length - 1; i >= 0; i--) {
    if (flat[i].b.type === 'text' && /#[A-Z_]+/.test(flat[i].b.text)) {
      idx = i;
      break;
    }
  }
  const human = idx >= 0 ? flat[idx] : null;
  const text = human ? (human.msg.content === human.b.text ? human.b.text : (Array.isArray(human.msg.content) ? human.msg.content : []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')) : '';
  const tag = human ? (human.b.text.match(/#([A-Z_]+)/) || [])[1] : null;
  const toolResults = flat.slice(idx + 1).filter((x) => x.b.type === 'tool_result').map((x) => x.b);
  const humanCount = flat.filter((x) => x.b.type === 'text' && /#[A-Z_]+/.test(x.b.text)).length;
  const hasImage = human ? (Array.isArray(human.msg.content) ? human.msg.content : []).some((b) => b.type === 'image') : false;
  return { tag, text, step: toolResults.length, toolResults, hasImage, humanCount };
}

export { lastToolResults, toolResultText };

export async function startHarness({ responder, env = {}, draftSupported = true, stateFile } = {}) {
  setLogLevel(process.env.TEST_LOG || 'error');
  const api = await startFakeAnthropic(responder);
  const tg = await startFakeTelegram({ draftSupported });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cwd-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-data-'));
  if (stateFile) fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify(stateFile));
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: tg.token,
    ALLOWED_TELEGRAM_IDS: String(USER),
    AGENT_CWD: cwd,
    DATA_DIR: data,
    TELEGRAM_API_ROOT: tg.url,
    MAX_TURNS: '20',
    DRAFT_INTERVAL_MS: '300',
    EDIT_INTERVAL_MS: '1000',
    HEARTBEAT_MS: '1000',
    CLAUDE_EXTRA_ENV: JSON.stringify({
      HOME: home,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: 'sk-ant-api03-teste-falso',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
    }),
    ...env,
  });
  const app = createApp(config);
  await app.start();
  const ctrl = app.ctrlFor(USER);

  const h = {
    api,
    tg,
    app,
    ctrl,
    config,
    cwd,
    data,
    mark: () => tg.calls.length,
    send: (text, extra) => tg.sendText(USER, text, extra),
    /** Espera a resposta final (mensagem com o rodapé "✅ 3s · …"). */
    waitFinal: (from, opts) =>
      tg.waitFor((c) => c.method === 'sendMessage' && /<i>(✅|•) \d/.test(c.payload.text || ''), { from, ...opts }),
    waitText: (from, re, opts) => tg.waitFor((c) => c.method === 'sendMessage' && re.test(c.payload.text || ''), { from, ...opts }),
    finalsSince: (from) => tg.calls.slice(from).filter((c) => c.method === 'sendMessage' && /<i>(✅|•) \d/.test(c.payload.text || '')),
    async idle(timeout = 20_000) {
      const t0 = Date.now();
      while (ctrl.current || ctrl.jobs.length) {
        if (Date.now() - t0 > timeout) throw new Error('o bot não ficou livre');
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    async close() {
      await app.shutdown();
      await tg.close();
      await api.close();
    },
  };
  return h;
}
