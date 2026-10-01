// Liga o Telegram (grammY) aos controladores de cada usuário.
import path from 'node:path';
import { Bot } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { Store } from '../store.js';
import { Sender } from './sender.js';
import { UserController } from './controller.js';
import { REPLY, isReplyButton, replyKeyboard } from './keyboards.js';
import { logger } from '../log.js';

const log = logger('bot');

const COMMANDS = [
  { command: 'menu', description: 'Painel: modelo, esforço, confirmações' },
  { command: 'nova', description: 'Começar uma conversa nova' },
  { command: 'parar', description: 'Parar o que está rodando' },
  { command: 'continuar', description: 'Continuar de onde parou' },
  { command: 'plano', description: 'Planejar antes de executar: /plano <tarefa>' },
  { command: 'status', description: 'Sessão, contexto e fila' },
  { command: 'ajuda', description: 'Como usar' },
];

const HELP = `🤖 <b>Assistente com Claude Code</b>

Escreva, mande <b>áudio</b>, <b>foto</b> ou <b>arquivo</b>. Eu respondo ao vivo e mostro cada etapa (lendo, procurando, rodando comandos).

<b>Botões fixos aqui embaixo</b>
🛑 <b>Parar</b> — interrompe na hora (também tem o botão nativo no rascunho)
🆕 <b>Nova conversa</b> — começa do zero (responde mais rápido)
⚙️ <b>Painel</b> — modelo, esforço, confirmações, status

<b>Perguntas e confirmações</b>
Quando houver dúvida, eu pergunto com botões. Ações perigosas (apagar, parar serviço, push…) pedem sua confirmação.

<b>Comandos</b>
/plano &lt;tarefa&gt; — mostro o plano antes de mexer em algo
/continuar — sigo de onde parei
/status — sessão, contexto e fila

<b>Áudio</b>: diga “para”, “nova conversa” ou “painel” para comandos rápidos.`;

export function createApp(config, { queryFn } = {}) {
  const bot = new Bot(config.token, {
    client: { ...(config.telegramApiRoot ? { apiRoot: config.telegramApiRoot } : {}), timeoutSeconds: 75 },
  });

  // Reenvia sozinho quando o Telegram pede para esperar (erro 429) ou cai.
  // Rascunhos e "digitando" não valem a espera.
  const retry = autoRetry({ maxRetryAttempts: 4, maxDelaySeconds: 30 });
  let lastPollOk = Date.now();
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (method === 'getUpdates') {
      const res = await prev(method, payload, signal);
      if (res?.ok) lastPollOk = Date.now();
      return res;
    }
    if (method === 'sendMessageDraft' || method === 'sendChatAction') return prev(method, payload, signal);
    return retry(prev, method, payload, signal);
  });

  const store = new Store(path.join(config.dataDir, 'state.json'), {
    confirm: config.defaults.confirm,
    streamMode: config.defaults.streamMode,
    autoNewHours: config.defaults.autoNewHours,
    showThinking: config.defaults.showThinking,
  });
  const sender = new Sender(bot.api);
  const controllers = new Map();
  const protectedPaths = [process.cwd(), config.dataDir];

  function ctrlFor(userId) {
    let c = controllers.get(userId);
    if (!c) {
      c = new UserController({ userId, config, store, api: bot.api, sender, queryFn, protectedPaths });
      controllers.set(userId, c);
    }
    return c;
  }

  const userIdOf = (ctx) => ctx.from?.id ?? ctx.chat?.id;

  // só conversas privadas de quem está na lista
  bot.use(async (ctx, next) => {
    const id = userIdOf(ctx);
    if (ctx.chat && ctx.chat.type !== 'private') return;
    if (id && config.allowedIds.includes(id)) return next();
    if (ctx.callbackQuery) return ctx.answerCallbackQuery({ text: '⛔ Bot privado.' }).catch(() => {});
    if (ctx.message) {
      log.warn(`acesso negado para o id ${id}`);
      return ctx.reply('⛔ Este bot é privado.').catch(() => {});
    }
  });

  // nunca deixa um handler travar a fila de atualizações do grammY
  const fire = (p) => Promise.resolve(p).catch((err) => log.error('erro no handler:', err));

  bot.command(['start', 'ajuda', 'help'], (ctx) => fire(ctx.reply(HELP, { parse_mode: 'HTML', reply_markup: replyKeyboard() })));
  bot.command(['menu', 'painel', 'config'], (ctx) => fire(ctrlFor(ctx.from.id).showPanel()));
  bot.command('status', (ctx) => fire(ctrlFor(ctx.from.id).showPanel('status')));
  bot.command(['nova', 'new'], (ctx) => fire(ctrlFor(ctx.from.id).newConversation()));
  bot.command(['parar', 'stop', 'cancelar'], (ctx) => fire(ctrlFor(ctx.from.id).stop()));
  bot.command(['continuar', 'continue'], (ctx) => fire(ctrlFor(ctx.from.id).continueTask()));
  bot.command(['plano', 'plan'], (ctx) => {
    const c = ctrlFor(ctx.from.id);
    const text = String(ctx.match || '').trim();
    if (!text) return fire(ctx.reply('📝 Use assim: /plano <o que você quer fazer>\nEu investigo, mostro o plano e só executo depois do seu OK.'));
    return fire(c.enqueuePrompt(text, { replyTo: ctx.message.message_id, planMode: true }));
  });

  bot.on('message:text', (ctx) => {
    const c = ctrlFor(ctx.from.id);
    const text = ctx.message.text;
    if (isReplyButton(text)) {
      if (text === REPLY.stop) return fire(c.stop());
      if (text === REPLY.newChat) return fire(c.newConversation());
      if (text === REPLY.panel) return fire(c.showPanel());
    }
    if (text.startsWith('/')) return fire(ctx.reply('Não conheço esse comando. Veja /ajuda.'));
    // respondendo a uma mensagem: o trecho citado vai junto para o Claude saber do que se trata
    const reply = ctx.message.reply_to_message;
    let quote = ctx.message.quote?.text || null;
    if (!quote && reply) {
      const t = reply.text || reply.caption || '';
      if (t) quote = reply.from?.is_bot ? t.slice(0, 300) : t;
    }
    return fire(c.onText(text, { replyTo: ctx.message.message_id, quote }));
  });

  bot.on(['message:voice', 'message:audio', 'message:video_note'], (ctx) => fire(ctrlFor(ctx.from.id).onVoice(ctx.message)));
  bot.on('message:photo', (ctx) => fire(ctrlFor(ctx.from.id).onPhoto(ctx.message)));
  bot.on('message:document', (ctx) => fire(ctrlFor(ctx.from.id).onDocument(ctx.message)));
  bot.on('message', (ctx) => fire(ctx.reply('Ainda não sei lidar com esse tipo de mensagem. Mande texto, áudio, foto ou arquivo.')));

  bot.on('callback_query:data', (ctx) =>
    fire(
      (async () => {
        let toast;
        try {
          toast = await ctrlFor(ctx.from.id).handleCallback(ctx.callbackQuery.data, ctx);
        } catch (err) {
          log.error('erro no botão:', err);
          toast = 'Deu erro processando isso.';
        }
        await ctx.answerCallbackQuery(toast ? { text: toast } : undefined).catch(() => {});
      })(),
    ),
  );

  bot.on('stopped_message_generation', (ctx) => {
    const ev = ctx.update.stopped_message_generation;
    const id = ev?.chat?.id;
    if (id && config.allowedIds.includes(id)) return fire(ctrlFor(id).onDraftStopped(ev.draft_id));
  });

  bot.catch((err) => log.error('erro no grammY:', err.error || err));

  let watchdog = null;
  let stopping = false;

  async function start() {
    await bot.init();
    log.info(`bot @${bot.botInfo.username} iniciado; usuários liberados: ${config.allowedIds.join(', ')}`);
    await bot.api.setMyCommands(COMMANDS).catch((err) => log.warn('setMyCommands falhou:', err.message));

    for (const id of config.allowedIds) {
      const c = ctrlFor(id);
      // abre o Claude já, para a primeira mensagem não esperar a partida
      try {
        c.session.start();
      } catch (err) {
        log.error('não consegui abrir a sessão do Claude:', err.message);
      }
      await c.announceRecovery();
    }

    watchdog = setInterval(() => {
      const stale = Date.now() - lastPollOk;
      if (stale > config.timing.pollStaleMs) {
        const busy = [...controllers.values()].some((c) => c.current);
        log.error(`sem contato com o Telegram há ${Math.round(stale / 1000)}s${busy ? ' (aguardando pedido em andamento)' : '; reiniciando'}`);
        if (!busy) process.exit(1); // o systemd sobe de novo
      }
    }, 60_000);
    watchdog.unref?.();

    bot.start({
      allowed_updates: ['message', 'callback_query', 'stopped_message_generation'],
      onStart: () => log.info('recebendo mensagens (long polling)'),
    }).catch((err) => {
      if (stopping) return; // parada pedida por nós
      log.error('o long polling parou:', err);
      process.exit(1);
    });
  }

  async function shutdown() {
    stopping = true;
    clearInterval(watchdog);
    log.info('desligando…');
    await Promise.allSettled([...controllers.values()].map((c) => c.shutdown()));
    store.flush();
    await bot.stop().catch(() => {});
  }

  return { bot, store, controllers, ctrlFor, start, shutdown };
}
