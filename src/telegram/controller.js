// Tudo o que acontece com um usuário: fila de pedidos, sessão do Claude,
// visualização ao vivo, perguntas, áudio, fotos, arquivos e painel.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InputFile } from 'grammy';
import { AgentSession } from '../engine/session.js';
import { TurnTracker } from '../engine/turn.js';
import { systemAppend, CONTINUE_PROMPT, THINK_MORE_PROMPT } from '../engine/prompt.js';
import { telegramToolsServer } from '../engine/telegram-tools.js';
import { formatDuration } from '../engine/activity.js';
import { RunView } from './run-view.js';
import { Interactions } from './interactions.js';
import { escapeHtml, singleShortCommand } from './format.js';
import { btn, copyBtn, inline, truncateLabel } from './keyboards.js';
import { panelView, handlePanelCallback } from './panel.js';
import { downloadTelegramFile, saveIncoming, humanSize } from '../media/files.js';
import { transcribe, whisperReady, voiceCommand } from '../media/transcribe.js';
import { logger } from '../log.js';

const log = logger('controle');
const newId = () => crypto.randomBytes(4).toString('hex');
const YES = /^(sim|s|pode|ok|okay|manda|vai|confirmo|confirma|permito|permitir|autorizo|aprovado|aprovo|executa|executar|bora|claro)\b/i;
const NO = /^(n[aã]o|nao|n|nega|negar|cancela|cancelar|para|pare|nem)\b/i;
const EFFORT_STEPS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function approvalKey(toolName, input = {}) {
  if (toolName === 'Bash') return `bash:${String(input.command || '').replace(/\s+/g, ' ').trim()}`;
  if (input.file_path) return `file:${toolName}:${input.file_path}`;
  return `tool:${toolName}`;
}

export class UserController {
  /**
   * @param {object} o
   * @param {number} o.userId
   * @param {object} o.config
   * @param {import('../store.js').Store} o.store
   * @param {object} o.api                 grammY Api
   * @param {import('./sender.js').Sender} o.sender
   * @param {Function} [o.queryFn]
   * @param {string[]} [o.protectedPaths]
   */
  constructor(o) {
    this.userId = o.userId;
    this.chatId = o.userId; // conversa privada: chat id = user id
    this.config = o.config;
    this.store = o.store;
    this.api = o.api;
    this.sender = o.sender;

    this.jobs = [];
    this.current = null;
    this.jobsById = new Map();
    this.suggestions = new Map();
    this.docs = new Map();
    this.albums = new Map();
    this.sessionAllow = new Set();
    this.longTextBuffer = null;
    this.lastFinal = null;

    this.interactions = new Interactions({
      sender: this.sender,
      chatId: this.chatId,
      allowAlways: (key) => this.sessionAllow.add(key),
    });

    const u = this.store.user(this.userId);
    this.session = new AgentSession({
      config: this.config,
      label: String(this.userId),
      getPrefs: () => this.prefs(),
      sessionId: u.sessionId,
      onSessionId: (id) => this.store.update(this.userId, (x) => (x.sessionId = id)),
      onToolRequest: (name, input, opts) => this.onToolRequest(name, input, opts),
      mcpServers: () => ({ telegram: telegramToolsServer({ cwd: this.config.cwd, sendFile: (f, c) => this.sendFile(f, c) }) }),
      systemAppend: systemAppend({ cwd: this.config.cwd }),
      protectedPaths: o.protectedPaths || [],
      onUnsolicited: (msg) => this.onUnsolicited(msg),
      onResumeFailed: () =>
        this.sender.html(this.chatId, 'ℹ️ <i>Não encontrei a conversa anterior (pode ter sido apagada). Comecei uma nova.</i>').catch(() => {}),
      queryFn: o.queryFn,
    });
  }

  prefs() {
    return {
      model: this.config.claude.defaultModel,
      effort: this.config.claude.defaultEffort,
      ...this.store.prefs(this.userId),
    };
  }

  // ---------------------------------------------------------------------------
  // Entrada de mensagens
  // ---------------------------------------------------------------------------

  /** Texto do usuário (digitado ou transcrito). */
  async onText(text, { replyTo, quote } = {}) {
    const clean = String(text ?? '').trim();
    if (!clean) return;
    if (this.interactions.handleText(clean)) return;
    if (this.interactions.hasPending && this.answerOpenApproval(clean)) return;

    // mensagens muito longas chegam quebradas em várias: junta as partes
    if (this.longTextBuffer) {
      this.longTextBuffer.parts.push(clean);
      clearTimeout(this.longTextBuffer.timer);
      this.longTextBuffer.timer = setTimeout(() => this.flushLongText(), 1500);
      return;
    }
    if (clean.length >= 3500) {
      this.longTextBuffer = { parts: [clean], replyTo, quote, timer: setTimeout(() => this.flushLongText(), 1500) };
      return;
    }
    this.enqueuePrompt(clean, { replyTo, quote });
  }

  flushLongText() {
    const b = this.longTextBuffer;
    this.longTextBuffer = null;
    if (b) this.enqueuePrompt(b.parts.join('\n'), { replyTo: b.replyTo, quote: b.quote });
  }

  answerOpenApproval(text) {
    for (const item of this.interactions.pending.values()) {
      if (item.type !== 'approval' && item.type !== 'plan') continue;
      // "sim"/"pode" curtos aprovam; frases maiores ("sim, mas antes…") viram explicação
      if (YES.test(text) && text.split(/\s+/).length <= 3) {
        const action = item.type === 'plan' ? `p:${item.id}:y` : `a:${item.id}:y`;
        this.interactions.handleCallback(action);
        return true;
      }
      if (NO.test(text) && text.split(/\s+/).length <= 2) {
        const action = item.type === 'plan' ? `p:${item.id}:n` : `a:${item.id}:n`;
        this.interactions.handleCallback(action);
        return true;
      }
      return this.interactions.handleTextForOpenApproval(text);
    }
    return false;
  }

  enqueuePrompt(text, { replyTo, quote, planMode = false } = {}) {
    let content = text;
    if (quote) content = `[Em resposta a: “${quote.slice(0, 1200)}”]\n\n${text}`;
    this.enqueue({ kind: 'prompt', content, label: text, replyTo, planMode });
  }

  // ---------------------------------------------------------------------------
  // Fila de pedidos
  // ---------------------------------------------------------------------------

  enqueue(job) {
    job.id ||= newId();
    this.jobsById.set(job.id, job);
    if (this.jobsById.size > 50) this.jobsById.delete(this.jobsById.keys().next().value);
    if (!this.current) {
      this.runJob(job);
      return;
    }
    this.jobs.push(job);
    this.sendQueueNotice(job);
  }

  async sendQueueNotice(job) {
    const pos = this.jobs.indexOf(job) + 1;
    if (pos <= 0) return;
    try {
      const msg = await this.sender.html(this.chatId, `📥 <b>Na fila</b> (posição ${pos}). Respondo assim que terminar o pedido atual.`, {
        ...(job.replyTo ? { reply_parameters: { message_id: job.replyTo, allow_sending_without_reply: true } } : {}),
        reply_markup: inline([[btn('⚡ Parar o atual e fazer este', `j:${job.id}:now`, 'primary')], [btn('🗑 Cancelar este', `j:${job.id}:x`)]]),
      });
      job.noticeId = msg.message_id;
      if (!this.jobs.includes(job)) this.sender.del(this.chatId, job.noticeId); // já saiu da fila
    } catch (err) {
      log.warn('aviso de fila falhou:', err.message);
    }
  }

  async runJob(job) {
    this.current = { job, view: null, tracker: null, stopRequested: false };
    try {
      await this.executeJob(job);
    } catch (err) {
      log.error('erro inesperado no pedido:', err);
      await this.sender.html(this.chatId, `⚠️ Erro interno: ${escapeHtml(err.message)}`).catch(() => {});
    } finally {
      this.store.update(this.userId, (u) => {
        u.inflight = null;
        u.lastActivityAt = Date.now();
      });
      this.current = null;
      const next = this.jobs.shift();
      if (next) this.runJob(next);
    }
  }

  async executeJob(job) {
    const prefs = this.prefs();
    const u = this.store.user(this.userId);
    if (job.noticeId) this.sender.del(this.chatId, job.noticeId);

    // conversa nova automática depois de muito tempo parado (mais rápido e mais barato)
    const idle = u.lastActivityAt ? Date.now() - u.lastActivityAt : 0;
    if (job.kind === 'prompt' && prefs.autoNewHours > 0 && this.session.sessionId && idle > prefs.autoNewHours * 3_600_000) {
      const prev = this.session.sessionId;
      this.store.update(this.userId, (x) => {
        x.previousSessionId = prev;
        x.sessionId = null;
      });
      this.sessionAllow.clear();
      this.session.reset({ resume: null });
      await this.sender
        .html(this.chatId, `🆕 <i>Comecei uma conversa nova: a anterior estava parada há ${formatDuration(idle)}.</i>`, {
          reply_markup: inline([[btn('↩️ Voltar para a conversa anterior', 'n:prev')]]),
        })
        .catch(() => {});
    }

    this.store.update(this.userId, (x) => {
      x.inflight = {
        kind: job.kind,
        label: String(job.label || '').slice(0, 300),
        text: typeof job.content === 'string' && job.content.length <= 6000 ? job.content : null,
        startedAt: Date.now(),
      };
      x.lastActivityAt = Date.now();
    });

    if (!this.session.alive) this.session.start();
    if (job.planMode) await this.session.setPermissionMode('plan');
    if (job.effortBoost) await this.session.setEffort(job.effortBoost);

    const tracker = new TurnTracker({ onChange: () => view.update() });
    const view = new RunView({
      sender: this.sender,
      api: this.api,
      chatId: this.chatId,
      tracker,
      prefs,
      timing: this.config.timing,
      replyTo: job.replyTo,
      model: prefs.model,
      onLongTask: () => this.longTaskNotice(),
      onStall: () => this.stallNotice(),
      onDraftUnsupported: () => this.store.setPref(this.userId, 'streamMode', 'edit'),
    });
    const turnKey = newId();
    tracker.onSuggestion = (s) => this.onSuggestion(turnKey, s);
    this.current.view = view;
    this.current.tracker = tracker;
    await view.start();

    let result = null;
    let error = null;
    const t0 = Date.now();
    log.info(`[${this.userId}] pedido ${job.kind} começou${job.planMode ? ' (plano)' : ''}`);
    try {
      result = await this.session.runTurn(job.content, tracker);
    } catch (err) {
      error = err;
    }
    log.info(
      `[${this.userId}] pedido ${job.kind} terminou em ${formatDuration(Date.now() - t0)}: ${result?.subtype || (error ? `erro (${String(error.message).slice(0, 120)})` : '?')}, ${tracker.state.steps.length} etapa(s)`,
    );
    this.interactions.cancelAll();

    if (job.planMode) await this.session.setPermissionMode('default');
    if (job.effortBoost) await this.session.setEffort(prefs.effort);

    const interrupted = this.current.stopRequested || this.shuttingDown;
    let sent = [];
    try {
      if (error && !result && !interrupted) {
        sent = await view.fail(error, { markup: inline([[btn('🔁 Tentar de novo', `x:retry:${job.id}`, 'primary')]]) });
      } else {
        const markup = this.finalMarkup({ result, job, turnKey, interrupted, tracker });
        const note = this.shuttingDown ? '⏹ <b>Interrompido:</b> o bot está reiniciando. Toque em Continuar quando ele voltar.' : undefined;
        sent = await view.finish({ markup, interrupted, maxTurns: this.config.claude.maxTurns, note });
        this.lastFinal = { turnKey, messageId: sent[sent.length - 1]?.message_id, markup };
        const pending = this.suggestions.get(`pending:${turnKey}`);
        if (pending) this.onSuggestion(turnKey, pending);
      }
    } catch (err) {
      log.error('falha ao publicar a resposta:', err);
      await this.sender.text(this.chatId, `⚠️ Terminei, mas não consegui mostrar a resposta: ${err.message}`).catch(() => {});
    }

    const s = tracker.state;
    this.store.update(this.userId, (x) => {
      x.stats.messages = (x.stats.messages || 0) + 1;
      x.stats.lastDurationMs = Date.now() - s.startedAt;
      x.stats.lastSteps = s.steps.length;
      if (result?.total_cost_usd) x.stats.lastCostUsd = result.total_cost_usd;
    });
  }

  finalMarkup({ result, job, turnKey, interrupted, tracker }) {
    const rows = [];
    const sub = result?.subtype;
    if (sub === 'error_max_turns' || interrupted || /^aborted/.test(result?.terminal_reason || '')) {
      rows.push([btn('▶️ Continuar', 'x:cont', 'primary')]);
    } else if (sub && sub !== 'success') {
      rows.push([btn('🔁 Tentar de novo', `x:retry:${job.id}`, 'primary')]);
    } else {
      const row = [btn('🧠 Pensar mais', `x:more:${turnKey}`)];
      const cmd = singleShortCommand(tracker.finalTexts().final);
      if (cmd) row.push(copyBtn('📋 Copiar comando', cmd));
      rows.push(row);
    }
    return inline(rows);
  }

  onSuggestion(turnKey, text) {
    const suggestion = String(text || '').trim();
    if (!suggestion) return;
    if (!this.lastFinal || this.lastFinal.turnKey !== turnKey || !this.lastFinal.messageId) {
      this.suggestions.set(`pending:${turnKey}`, suggestion); // a resposta ainda não foi publicada
      return;
    }
    this.suggestions.delete(`pending:${turnKey}`);
    const id = newId();
    this.suggestions.set(id, suggestion);
    if (this.suggestions.size > 40) this.suggestions.delete(this.suggestions.keys().next().value);
    const markup = this.lastFinal.markup || inline([]);
    const rows = [...(markup.inline_keyboard || []), [btn(`💡 ${truncateLabel(suggestion, 44)}`, `sg:${id}`)]];
    this.lastFinal.markup = { inline_keyboard: rows };
    this.sender.markup(this.chatId, this.lastFinal.messageId, this.lastFinal.markup);
  }

  onUnsolicited() {
    if (this.current) return null;
    // O Claude voltou a falar sozinho (ex.: um comando em segundo plano terminou).
    const job = { id: newId(), kind: 'background', label: 'continuação automática', content: null };
    this.current = { job, view: null, tracker: null, stopRequested: false };
    const prefs = this.prefs();
    const tracker = new TurnTracker({ onChange: () => view.update() });
    const view = new RunView({
      sender: this.sender,
      api: this.api,
      chatId: this.chatId,
      tracker,
      prefs,
      timing: this.config.timing,
      model: prefs.model,
      onLongTask: () => this.longTaskNotice(),
      onStall: () => this.stallNotice(),
    });
    this.current.view = view;
    this.current.tracker = tracker;
    view.start();
    return {
      handle: (msg) => {
        tracker.handle(msg);
        if (msg.type === 'result') {
          const turnKey = newId();
          view
            .finish({ markup: this.finalMarkup({ result: msg, job, turnKey, interrupted: false, tracker }) })
            .catch((err) => log.error(err))
            .finally(() => {
              this.current = null;
              const next = this.jobs.shift();
              if (next) this.runJob(next);
            });
        }
      },
      onSuggestion: () => {},
    };
  }

  // ---------------------------------------------------------------------------
  // Pedidos de permissão e perguntas vindos do Claude
  // ---------------------------------------------------------------------------

  async onToolRequest(toolName, input, opts = {}) {
    const view = this.current?.view;
    try {
      if (toolName === 'AskUserQuestion') {
        await view?.pause();
        const answers = await this.interactions.askQuestions(input.questions, { signal: opts.signal });
        view?.resume();
        return { behavior: 'allow', updatedInput: { questions: input.questions, answers } };
      }
      if (toolName === 'ExitPlanMode') {
        await view?.pause();
        const plan = typeof input.plan === 'string' ? input.plan : JSON.stringify(input, null, 2);
        const res = await this.interactions.approvePlan(plan, { signal: opts.signal, input });
        view?.resume();
        if (res.behavior === 'allow') setTimeout(() => this.session.setPermissionMode('default'), 100);
        else if (res.interrupt) setTimeout(() => this.stop({ quiet: true }), 100);
        return res;
      }
      const key = approvalKey(toolName, input);
      if (this.sessionAllow.has(key)) return { behavior: 'allow', updatedInput: input };
      await view?.pause();
      const res = await this.interactions.askApproval(toolName, input, {
        reason: opts.decisionReason,
        signal: opts.signal,
        alwaysKey: key,
      });
      view?.resume();
      return res;
    } catch (err) {
      view?.resume();
      return { behavior: 'deny', message: 'O usuário cancelou.' };
    }
  }

  // ---------------------------------------------------------------------------
  // Controles
  // ---------------------------------------------------------------------------

  /** Para o pedido atual e cancela a fila. */
  async stop({ quiet = false } = {}) {
    const dropped = this.jobs.splice(0);
    for (const j of dropped) {
      if (j.noticeId) this.sender.edit(this.chatId, j.noticeId, '🗑 <i>Cancelado.</i>', { reply_markup: { inline_keyboard: [] } });
    }
    const hadPending = this.interactions.hasPending;
    this.interactions.cancelAll('⏹ Cancelado.');
    const running = this.current;
    if (running) {
      running.stopRequested = true;
      await this.session.interrupt();
      // segurança: se o Claude não responder ao "parar", reabre a sessão
      setTimeout(() => {
        if (this.current === running) {
          log.warn('o Claude não respondeu ao parar; reabrindo a sessão');
          this.session.reset({ resume: this.session.sessionId });
        }
      }, 15_000).unref?.();
    }
    if (!quiet && !running && !hadPending) {
      await this.sender.html(this.chatId, dropped.length ? `🗑 Cancelei ${dropped.length} pedido(s) da fila.` : '✋ Não tem nada rodando agora.').catch(() => {});
    }
    return { running: Boolean(running), dropped: dropped.length };
  }

  async newConversation({ announce = true } = {}) {
    if (this.current || this.jobs.length) await this.stop({ quiet: true });
    const prev = this.session.sessionId;
    this.store.update(this.userId, (u) => {
      if (prev) u.previousSessionId = prev;
      u.sessionId = null;
    });
    this.sessionAllow.clear();
    this.session.reset({ resume: null });
    if (announce) {
      await this.sender
        .html(this.chatId, '🆕 <b>Conversa nova.</b> Comecei do zero — o Claude não lembra do que falamos antes.', {
          reply_markup: prev ? inline([[btn('↩️ Voltar para a conversa anterior', 'n:prev')]]) : undefined,
        })
        .catch(() => {});
    }
  }

  async resumePrevious() {
    const u = this.store.user(this.userId);
    const prev = u.previousSessionId;
    if (!prev) return 'Não encontrei uma conversa anterior.';
    if (this.current || this.jobs.length) await this.stop({ quiet: true });
    const now = this.session.sessionId;
    this.store.update(this.userId, (x) => {
      x.previousSessionId = now || null;
      x.sessionId = prev;
    });
    this.sessionAllow.clear();
    this.session.reset({ resume: prev });
    await this.sender.html(this.chatId, '↩️ <b>Voltei para a conversa anterior.</b> Pode continuar de onde parou.').catch(() => {});
    return null;
  }

  async restartSession() {
    if (this.current || this.jobs.length) await this.stop({ quiet: true });
    this.session.reset({ resume: this.session.sessionId });
    await this.sender.html(this.chatId, '♻️ <b>Sessão reiniciada.</b> A conversa foi mantida.').catch(() => {});
  }

  continueTask() {
    this.enqueue({ kind: 'continue', content: CONTINUE_PROMPT, label: '▶️ Continuar' });
  }

  thinkMore() {
    const current = this.prefs().effort;
    const idx = EFFORT_STEPS.indexOf(current);
    const boost = EFFORT_STEPS[Math.min(EFFORT_STEPS.length - 1, Math.max(idx + 2, 2))];
    this.enqueue({ kind: 'thinkmore', content: THINK_MORE_PROMPT, label: '🧠 Pensar mais', effortBoost: boost });
  }

  async longTaskNotice() {
    const step = this.current?.tracker?.state.steps.filter((s) => s.status === 'running').pop();
    const min = Math.round(this.config.timing.longTaskNoticeMs / 60000);
    await this.sender
      .html(this.chatId, `⏳ <b>Ainda trabalhando</b> (${min} min)${step ? `: ${escapeHtml(step.text)}` : ''}. Pode continuar usando o Telegram; eu aviso quando terminar.`, {
        reply_markup: inline([[btn('🛑 Parar', 'stop', 'danger')]]),
      })
      .catch(() => {});
  }

  async stallNotice() {
    const step = this.current?.tracker?.state.steps.filter((s) => s.status === 'running').pop();
    const min = Math.round(this.config.timing.stallMs / 60000);
    await this.sender
      .html(this.chatId, `🤔 Faz ${min} min que o Claude não dá sinal${step ? ` (etapa: ${escapeHtml(step.text)})` : ''}. Pode ser um comando demorado.`, {
        reply_markup: inline([
          [btn('⏳ Esperar mais', 'w:wait'), btn('🛑 Parar', 'stop', 'danger')],
          [btn('♻️ Reiniciar a sessão', 'w:restart')],
        ]),
      })
      .catch(() => {});
  }

  /** Botão nativo de parar do rascunho. */
  onDraftStopped(draftId) {
    const view = this.current?.view;
    if (view && (view.draftId === draftId || !draftId)) this.stop({ quiet: true });
  }

  // ---------------------------------------------------------------------------
  // Áudio, fotos, documentos
  // ---------------------------------------------------------------------------

  async onVoice(msg) {
    const media = msg.voice || msg.audio || msg.video_note;
    const duration = media?.duration || 0;
    if (!whisperReady(this.config.whisper)) {
      await this.sender.html(this.chatId, '🎤 A transcrição de áudio não está configurada na VPS (WHISPER_CLI e WHISPER_MODEL no .env).').catch(() => {});
      return;
    }
    let note;
    try {
      note = await this.sender.html(this.chatId, `🎤 <i>Transcrevendo ${duration ? `${duration}s de áudio` : 'o áudio'}…</i>`, {
        reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
      });
    } catch {
      /* segue mesmo sem o aviso */
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agente-voz-'));
    try {
      const { buffer } = await downloadTelegramFile(this.api, this.config.token, media.file_id, { apiRoot: this.config.telegramApiRoot });
      const file = path.join(dir, 'entrada');
      fs.writeFileSync(file, buffer);
      const { text, ms } = await transcribe(file, { durationSec: duration, cfg: this.config.whisper });
      if (!text) {
        if (note) await this.sender.edit(this.chatId, note.message_id, '🎤 Não consegui entender o áudio. Pode repetir ou escrever?');
        return;
      }
      if (note) await this.sender.edit(this.chatId, note.message_id, `🎤 <i>“${escapeHtml(text)}”</i> <i>(${formatDuration(ms)})</i>`);
      const cmd = voiceCommand(text);
      if (cmd === 'stop') {
        await this.stop();
        return;
      }
      if (cmd && !this.interactions.hasPending) {
        if (cmd === 'new') await this.newConversation();
        else if (cmd === 'panel') await this.showPanel();
        else if (cmd === 'continue') this.continueTask();
        return;
      }
      await this.onText(text, { replyTo: msg.message_id });
    } catch (err) {
      log.error('erro no áudio:', err.message);
      const t = `🎤 Erro na transcrição: ${escapeHtml(err.message)}`;
      if (note) await this.sender.edit(this.chatId, note.message_id, t);
      else await this.sender.html(this.chatId, t).catch(() => {});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  onPhoto(msg) {
    if (msg.media_group_id) {
      const key = msg.media_group_id;
      let album = this.albums.get(key);
      if (!album) {
        album = { msgs: [], timer: null };
        this.albums.set(key, album);
      }
      album.msgs.push(msg);
      clearTimeout(album.timer);
      album.timer = setTimeout(() => {
        this.albums.delete(key);
        this.processPhotos(album.msgs);
      }, 1200);
      return;
    }
    this.processPhotos([msg]);
  }

  async processPhotos(msgs) {
    const caption = msgs.map((m) => m.caption).filter(Boolean).join('\n');
    try {
      const blocks = [];
      for (const m of msgs.slice(0, 10)) {
        const best = [...m.photo].sort((a, b) => (b.file_size || b.width * b.height) - (a.file_size || a.width * a.height))[0];
        const { buffer } = await downloadTelegramFile(this.api, this.config.token, best.file_id, { apiRoot: this.config.telegramApiRoot });
        blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buffer.toString('base64') } });
      }
      const n = blocks.length;
      blocks.push({ type: 'text', text: caption || (n > 1 ? 'Veja estas imagens e me diga o que você vê.' : 'Veja esta imagem e me diga o que você vê.') });
      if (this.interactions.awaitingText && caption) {
        // foto com legenda enquanto uma pergunta está aberta: a legenda responde
        if (this.interactions.handleText(caption)) return;
      }
      this.enqueue({ kind: 'prompt', content: blocks, label: `🖼 ${caption || (n > 1 ? `${n} imagens` : 'imagem')}`, replyTo: msgs[0].message_id });
    } catch (err) {
      await this.sender.html(this.chatId, `🖼 Não consegui baixar a imagem: ${escapeHtml(err.message)}`).catch(() => {});
    }
  }

  async onDocument(msg) {
    const doc = msg.document;
    try {
      const { buffer, size } = await downloadTelegramFile(this.api, this.config.token, doc.file_id, { apiRoot: this.config.telegramApiRoot });
      const file = saveIncoming(this.config.cwd, doc.file_name || 'arquivo', buffer);
      const rel = path.relative(this.config.cwd, file);
      const info = `[Arquivo enviado pelo usuário: ${file} (${humanSize(size)})]`;
      if (msg.caption) {
        this.enqueue({ kind: 'prompt', content: `${msg.caption}\n\n${info}`, label: `📎 ${msg.caption}`, replyTo: msg.message_id });
        return;
      }
      const id = newId();
      this.docs.set(id, { file, info, name: doc.file_name, replyTo: msg.message_id });
      await this.sender.html(this.chatId, `📎 Guardei <code>${escapeHtml(rel)}</code> (${humanSize(size)}). O que eu faço com ele?`, {
        reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
        reply_markup: inline([
          [btn('🔍 Analisar', `d:${id}:a`, 'primary'), btn('📝 Resumir', `d:${id}:r`)],
          [btn('✖️ Só guardar', `d:${id}:n`)],
        ]),
      });
    } catch (err) {
      await this.sender.html(this.chatId, `📎 Não consegui receber o arquivo: ${escapeHtml(err.message)}`).catch(() => {});
    }
  }

  /** Usado pela ferramenta enviar_arquivo do Claude. */
  async sendFile(file, caption) {
    const ext = path.extname(file).toLowerCase();
    const size = fs.statSync(file).size;
    const opts = caption ? { caption: caption.slice(0, 1000) } : {};
    if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext) && size <= 10 * 1024 * 1024) {
      try {
        await this.api.sendPhoto(this.chatId, new InputFile(file), opts);
        return;
      } catch {
        /* cai para documento */
      }
    }
    await this.api.sendDocument(this.chatId, new InputFile(file), opts);
  }

  // ---------------------------------------------------------------------------
  // Botões
  // ---------------------------------------------------------------------------

  /** @returns {Promise<string|undefined>} texto curto para o "toast" do botão */
  async handleCallback(data, ctx) {
    const r = await this.interactions.handleCallback(data);
    if (r.handled) return r.toast;

    const [kind, a, b] = String(data).split(':');
    switch (kind) {
      case 'stop': {
        const res = await this.stop({ quiet: true });
        return res.running ? 'Parando…' : res.dropped ? `Cancelei ${res.dropped} da fila` : 'Nada rodando agora';
      }
      case 'j': {
        const job = this.jobs.find((j) => j.id === a);
        if (!job) return 'Esse pedido já saiu da fila.';
        if (b === 'x') {
          this.jobs = this.jobs.filter((j) => j !== job);
          if (job.noticeId) await this.sender.edit(this.chatId, job.noticeId, '🗑 <i>Cancelado.</i>', { reply_markup: { inline_keyboard: [] } });
          return 'Cancelado';
        }
        if (b === 'now') {
          this.jobs = [job, ...this.jobs.filter((j) => j !== job)];
          if (this.current) {
            this.current.stopRequested = true;
            this.interactions.cancelAll('⏹ Cancelado.');
            await this.session.interrupt();
          }
          return 'Parando o atual…';
        }
        return undefined;
      }
      case 'x': {
        if (a === 'cont') {
          this.continueTask();
          return 'Continuando…';
        }
        if (a === 'more') {
          this.thinkMore();
          return 'Pensando com mais calma…';
        }
        if (a === 'retry') {
          const job = this.jobsById.get(b);
          if (!job) return 'Não achei mais esse pedido.';
          this.enqueue({ ...job, id: newId(), noticeId: null });
          return 'Tentando de novo…';
        }
        return undefined;
      }
      case 'sg': {
        const text = this.suggestions.get(a);
        if (!text) return 'Sugestão expirada.';
        await this.sender.html(this.chatId, `💡 <i>${escapeHtml(text)}</i>`).catch(() => {});
        this.enqueuePrompt(text);
        return 'Enviado';
      }
      case 'r': {
        const u = this.store.user(this.userId);
        const inflight = u.recovered;
        this.store.update(this.userId, (x) => (x.recovered = null));
        if (ctx?.callbackQuery?.message) await this.sender.markup(this.chatId, ctx.callbackQuery.message.message_id, { inline_keyboard: [] });
        if (a === 'retry' && inflight?.text) {
          this.enqueue({ kind: 'prompt', content: inflight.text, label: inflight.label });
          return 'Tentando de novo…';
        }
        if (a === 'cont') {
          this.continueTask();
          return 'Continuando…';
        }
        return 'Ok';
      }
      case 'd': {
        const doc = this.docs.get(a);
        if (!doc) return 'Arquivo expirado.';
        this.docs.delete(a);
        if (ctx?.callbackQuery?.message) await this.sender.markup(this.chatId, ctx.callbackQuery.message.message_id, { inline_keyboard: [] });
        if (b === 'a') this.enqueue({ kind: 'prompt', content: `Analise este arquivo e me diga o que ele é e o que tem de importante.\n\n${doc.info}`, label: `🔍 ${doc.name}`, replyTo: doc.replyTo });
        else if (b === 'r') this.enqueue({ kind: 'prompt', content: `Faça um resumo curto deste arquivo.\n\n${doc.info}`, label: `📝 ${doc.name}`, replyTo: doc.replyTo });
        return b === 'n' ? 'Guardado' : 'Ok';
      }
      case 'n':
        if (a === 'prev') return (await this.resumePrevious()) || 'Voltei';
        return undefined;
      case 'w':
        if (a === 'restart') {
          await this.restartSession();
          return 'Reiniciando…';
        }
        if (ctx?.callbackQuery?.message) await this.sender.markup(this.chatId, ctx.callbackQuery.message.message_id, { inline_keyboard: [] });
        return 'Ok, esperando';
      case 'm':
      case 's':
      case 't':
        return handlePanelCallback(this, data, ctx);
      default:
        return undefined;
    }
  }

  async showPanel(page = 'main') {
    const { html, markup } = await panelView(this, page);
    await this.sender.html(this.chatId, html, { reply_markup: markup }).catch((err) => log.error('painel:', err.message));
  }

  /** Recado depois de um reinício do bot no meio de um pedido. */
  async announceRecovery() {
    const u = this.store.user(this.userId);
    const inflight = u.inflight;
    if (!inflight) return;
    this.store.update(this.userId, (x) => {
      x.recovered = inflight;
      x.inflight = null;
    });
    const label = inflight.label ? `: “${escapeHtml(truncateLabel(inflight.label, 160))}”` : '';
    const rows = [];
    if (inflight.text) rows.push(btn('🔁 Tentar de novo', 'r:retry', 'primary'));
    rows.push(btn('▶️ Continuar de onde parou', 'r:cont'));
    await this.sender
      .html(this.chatId, `⚠️ <b>Fui reiniciado no meio do seu pedido</b>${label}.\nO que você quer fazer?`, {
        reply_markup: inline([rows, [btn('✖️ Deixar pra lá', 'r:drop')]]),
      })
      .catch((err) => log.warn('aviso de reinício falhou:', err.message));
  }

  /** Desligamento: interrompe com calma para a conversa ficar registrada. */
  async shutdown() {
    this.shuttingDown = true;
    this.jobs.splice(0);
    this.interactions.cancelAll('⏹ Cancelado (o bot está reiniciando).');
    if (this.current) {
      try {
        await Promise.race([this.session.interrupt(), new Promise((r) => setTimeout(r, 3000))]);
      } catch {
        /* ignora */
      }
      // espera a mensagem "Interrompido" sair (no máximo 6s)
      for (let i = 0; i < 30 && this.current; i++) await new Promise((r) => setTimeout(r, 200));
    }
    this.session.close();
  }
}

