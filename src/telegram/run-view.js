// Mostra um pedido em andamento no Telegram, ao vivo.
//
// Modo "draft": usa o rascunho nativo do Telegram (sendMessageDraft, Bot API
// 9.5+). Começa com o "Pensando…" animado do próprio app, mostra as etapas e o
// texto sendo escrito, e tem o botão nativo de parar. A resposta final chega
// como mensagem normal.
// Modo "edit": manda uma mensagem "⏳ Pensando…" e vai editando (fallback).
import { escapeHtml, renderPreview, htmlToPlain } from './format.js';
import { clock, formatDuration, modelLabel } from '../engine/activity.js';
import { btn, inline } from './keyboards.js';
import { isParseError, retryAfterMs } from './sender.js';
import { logger } from '../log.js';

const log = logger('ao-vivo');
const MAX_STEPS_LIVE = 6;
const MAX_STEPS_FINAL = 25;

const STATUS_ICON = { running: '⏳', preparing: '⏳', done: '✅', error: '❌', denied: '🚫' };

function draftId() {
  return 1 + Math.floor(Math.random() * 2_000_000_000);
}

function retryLabel(retry, now) {
  const wait = Math.max(0, Math.ceil((retry.at + retry.delayMs - now) / 1000));
  const what = {
    overloaded: 'A Anthropic está sobrecarregada',
    rate_limit: 'Limite de uso momentâneo',
    server_error: 'Erro no servidor da Anthropic',
    authentication_failed: 'Falha de login no Claude',
    billing_error: 'Problema de cobrança na conta',
  }[retry.error] || 'Falha de conexão com a Anthropic';
  return `${what}. Nova tentativa ${wait > 0 ? `em ${wait}s` : 'agora'} (${retry.attempt}/${retry.max}).`;
}

function timeOfDay(epochSec) {
  if (!epochSec) return '';
  const d = new Date(epochSec * 1000);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'America/Sao_Paulo' });
}

export function rateLimitLine(info) {
  if (!info) return '';
  const window = { five_hour: 'de 5 horas', seven_day: 'semanal', seven_day_opus: 'semanal do Opus', seven_day_sonnet: 'semanal do Sonnet' }[info.rateLimitType] || '';
  const reset = info.resetsAt ? ` Zera às ${timeOfDay(info.resetsAt)}.` : '';
  if (info.status === 'rejected') return `⛔ Limite ${window} da assinatura atingido.${reset}`;
  if (info.status === 'allowed_warning') {
    const pct = typeof info.utilization === 'number' ? ` ${Math.round(info.utilization * (info.utilization <= 1 ? 100 : 1))}%` : '';
    return `⚠️ Você já usou${pct} do limite ${window}.${reset}`;
  }
  return '';
}

/** Mensagem amigável para um erro do Claude Code. */
export function friendlyError({ result, assistantError, error, rateLimit } = {}) {
  const errors = (result?.errors || []).filter((e) => !/^\[ede_diagnostic\]/.test(e));
  const text = [error?.message, ...errors, result?.result].filter(Boolean).join(' | ');
  if (assistantError === 'authentication_failed' || /authenticat|\/login|invalid api key|oauth|401/i.test(text))
    return '🔑 O Claude Code da VPS está sem login. Entre na VPS, rode <code>claude</code> e faça o /login.';
  if (assistantError === 'rate_limit' || /hit your|reached your|usage limit|out of usage|out of extra usage/i.test(text))
    return rateLimitLine({ ...(rateLimit || {}), status: 'rejected' }) || '⛔ Limite de uso da assinatura atingido.';
  if (assistantError === 'overloaded' || /overloaded/i.test(text)) return 'A Anthropic está sobrecarregada no momento. Tente de novo em instantes.';
  if (assistantError === 'billing_error') return 'Problema de cobrança na conta da Anthropic.';
  if (error?.sessionEnded) return 'A sessão do Claude fechou de repente. Já vou reabrir na próxima mensagem.';
  if (!text) return 'Erro desconhecido.';
  return escapeHtml(text.slice(0, 300));
}

export class RunView {
  /**
   * @param {object} o
   * @param {import('./sender.js').Sender} o.sender
   * @param {object} o.api        grammY Api (para sendMessageDraft)
   * @param {number} o.chatId
   * @param {import('../engine/turn.js').TurnTracker} o.tracker
   * @param {object} o.prefs
   * @param {object} o.timing
   * @param {number} [o.replyTo]
   * @param {string} [o.model]
   * @param {(view: RunView) => void} [o.onLongTask]
   * @param {(view: RunView) => void} [o.onStall]
   * @param {() => void} [o.onDraftUnsupported]
   */
  constructor(o) {
    this.sender = o.sender;
    this.api = o.api;
    this.chatId = o.chatId;
    this.tracker = o.tracker;
    this.timing = o.timing;
    this.replyTo = o.replyTo;
    this.model = o.model;
    this.showThinking = Boolean(o.prefs?.showThinking);
    this.mode = o.prefs?.streamMode === 'edit' ? 'edit' : 'draft';
    this.onLongTask = o.onLongTask || (() => {});
    this.onStall = o.onStall || (() => {});
    this.onDraftUnsupported = o.onDraftUnsupported || (() => {});
    this.now = o.now || (() => Date.now());

    this.draftId = draftId();
    this.placeholderId = null;
    this.paused = false;
    this.finished = false;
    this.lastSent = null;
    this.lastRenderAt = 0;
    this.renderTimer = null;
    this.heartbeat = null;
    this.blockedUntil = 0;
    this.longNoticed = false;
    this.stallNoticedAt = 0;
    this.rendering = false;
    this.renderAgain = false;
    this.lastTypingAt = 0;
  }

  get interval() {
    return this.mode === 'draft' ? this.timing.draftIntervalMs : this.timing.editIntervalMs;
  }

  stopMarkup() {
    return inline([[btn('🛑 Parar', 'stop', 'danger')]]);
  }

  async start() {
    if (this.mode === 'draft') {
      const ok = await this.sendDraft('', { first: true });
      if (!ok) {
        log.warn('rascunho nativo indisponível; usando edição de mensagem');
        this.mode = 'edit';
        this.onDraftUnsupported();
      }
    }
    if (this.mode === 'edit') {
      try {
        const msg = await this.sender.html(this.chatId, '⏳ <i>Pensando…</i>', {
          reply_markup: this.stopMarkup(),
          ...(this.replyTo ? { reply_parameters: { message_id: this.replyTo, allow_sending_without_reply: true } } : {}),
        });
        this.placeholderId = msg.message_id;
      } catch (err) {
        log.error('não consegui mandar o "Pensando…":', err.description || err.message);
      }
      this.sender.action(this.chatId, 'typing');
      this.lastTypingAt = this.now();
    }
    this.heartbeat = setInterval(() => this.tick(), this.timing.heartbeatMs);
    this.heartbeat.unref?.();
  }

  tick() {
    if (this.finished) return;
    const now = this.now();
    const s = this.tracker.state;
    if (!this.longNoticed && now - s.startedAt >= this.timing.longTaskNoticeMs && !this.paused) {
      this.longNoticed = true;
      this.onLongTask(this);
    }
    if (!this.paused && now - s.lastEventAt >= this.timing.stallMs && now - this.stallNoticedAt >= this.timing.stallMs) {
      this.stallNoticedAt = now;
      this.onStall(this);
    }
    if (this.mode === 'edit' && !this.paused && now - this.lastTypingAt > 4500) {
      this.lastTypingAt = now;
      this.sender.action(this.chatId, 'typing');
    }
    this.render({ heartbeat: true });
  }

  /** Chamado a cada mudança no estado do pedido (com limite de frequência). */
  update() {
    if (this.finished || this.paused) return;
    const wait = this.lastRenderAt + this.interval - this.now();
    if (wait <= 0) {
      this.render();
      return;
    }
    if (!this.renderTimer) {
      this.renderTimer = setTimeout(() => {
        this.renderTimer = null;
        this.render();
      }, wait);
    }
  }

  stepLine(step, now) {
    let line = `${STATUS_ICON[step.status] || '•'} ${step.icon} ${escapeHtml(step.text)}`;
    if (step.children) line += ` <i>(${step.children} ações)</i>`;
    if (step.detail) line += ` <i>— ${escapeHtml(String(step.detail).slice(0, 80))}</i>`;
    if ((step.status === 'running' || step.status === 'preparing') && now - step.startedAt > 4000) line += ` <i>${clock(now - step.startedAt)}</i>`;
    return line;
  }

  phaseLabel(s) {
    switch (s.phase) {
      case 'thinking':
        return this.showThinking && s.thinkingSince ? '💭 raciocinando…' : '💭 pensando…';
      case 'writing':
        return '✍️ escrevendo…';
      case 'tool':
        return '🔧 trabalhando…';
      case 'waiting_user':
        return '❓ esperando você';
      case 'retrying':
        return '⚠️ esperando a API';
      case 'compacting':
        return '🗜 compactando a conversa…';
      default:
        return '💭 pensando…';
    }
  }

  /** Monta o HTML do rascunho/mensagem ao vivo. '' = "Pensando…" nativo. */
  compose() {
    const s = this.tracker.state;
    const now = this.now();
    const elapsed = now - s.startedAt;
    const hasContent = s.steps.length || s.liveText.trim() || s.retry || s.rateLimit || s.phase === 'compacting';
    if (this.mode === 'draft' && !hasContent && elapsed < 8000) return '';

    const parts = [];
    const model = modelLabel(s.model || this.model);
    parts.push(`⏳ <b>${clock(elapsed)}</b>${model ? ` · ${escapeHtml(model)}` : ''} · ${this.phaseLabel(s)}`);

    if (s.steps.length) {
      const shown = s.steps.slice(-MAX_STEPS_LIVE);
      const hidden = s.steps.length - shown.length;
      const lines = shown.map((st) => this.stepLine(st, now));
      if (hidden > 0) lines.unshift(`<i>… +${hidden} etapa(s) antes</i>`);
      parts.push(lines.join('\n'));
    }
    if (s.phase === 'retrying' && s.retry) parts.push(`⚠️ ${escapeHtml(retryLabel(s.retry, now))}`);
    const rl = rateLimitLine(s.rateLimit);
    if (rl) parts.push(escapeHtml(rl));
    if (s.liveText.trim() && (s.phase === 'writing' || !s.steps.length || s.steps.every((x) => x.status !== 'running'))) {
      parts.push((s.steps.length ? '──────────\n' : '') + renderPreview(s.liveText, { maxChars: 2600 }));
    }
    let html = parts.join('\n\n');
    if (html.length > 4000) html = html.slice(0, 3990) + '…';
    return html;
  }

  async render({ heartbeat = false } = {}) {
    if (this.finished || this.paused) return;
    if (this.rendering) {
      this.renderAgain = true;
      return;
    }
    this.rendering = true;
    try {
      const html = this.compose();
      this.lastRenderAt = this.now();
      if (this.mode === 'draft') {
        // o rascunho some sozinho depois de ~30s sem atualização: o heartbeat reenvia
        if (html !== this.lastSent || heartbeat) await this.sendDraft(html);
      } else if (this.placeholderId && html && html !== this.lastSent) {
        const ok = await this.sender.edit(this.chatId, this.placeholderId, html, { reply_markup: this.stopMarkup() });
        if (ok) this.lastSent = html;
      }
    } finally {
      this.rendering = false;
    }
    if (this.renderAgain) {
      this.renderAgain = false;
      this.update();
    }
  }

  async sendDraft(html, { first = false } = {}) {
    if (this.now() < this.blockedUntil) return true;
    try {
      await this.api.sendMessageDraft(this.chatId, this.draftId, html, {
        ...(html ? { parse_mode: 'HTML' } : {}),
        can_stop: true,
      });
      this.lastSent = html;
      return true;
    } catch (err) {
      const wait = retryAfterMs(err);
      if (wait) {
        this.blockedUntil = this.now() + wait;
        return true;
      }
      if (html && isParseError(err)) {
        try {
          await this.api.sendMessageDraft(this.chatId, this.draftId, htmlToPlain(html).slice(0, 4000), { can_stop: true });
          this.lastSent = html;
          return true;
        } catch {
          return true;
        }
      }
      if (first) {
        log.warn('sendMessageDraft falhou:', err.description || err.message);
        return false;
      }
      log.debug('rascunho falhou:', err.description || err.message);
      return true;
    }
  }

  /** Pausa a exibição enquanto esperamos você responder uma pergunta. */
  async pause() {
    this.paused = true;
    clearTimeout(this.renderTimer);
    this.renderTimer = null;
    if (this.mode === 'edit' && this.placeholderId) {
      await this.sender.edit(this.chatId, this.placeholderId, '❓ <i>Esperando sua resposta…</i>', { reply_markup: this.stopMarkup() });
    }
  }

  resume() {
    if (this.finished) return;
    this.paused = false;
    this.draftId = draftId(); // novo rascunho, sem animar a partir do antigo
    this.lastSent = null;
    this.tracker.touch();
    this.render();
  }

  cleanup() {
    this.finished = true;
    clearTimeout(this.renderTimer);
    this.renderTimer = null;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  async removePlaceholder() {
    if (this.mode === 'edit' && this.placeholderId) {
      await this.sender.del(this.chatId, this.placeholderId);
      this.placeholderId = null;
    }
  }

  stepsBlock() {
    const s = this.tracker.state;
    if (!s.steps.length) return '';
    const now = this.now();
    const lines = s.steps.slice(-MAX_STEPS_FINAL).map((st) => {
      let l = `${STATUS_ICON[st.status] || '•'} ${escapeHtml(st.text)}`;
      if (st.children) l += ` (${st.children} ações)`;
      if (st.detail && st.status !== 'running') l += ` — ${escapeHtml(String(st.detail).slice(0, 60))}`;
      const dur = (st.endedAt || now) - st.startedAt;
      if (dur > 5000) l += ` · ${formatDuration(dur)}`;
      return l;
    });
    const hidden = s.steps.length - MAX_STEPS_FINAL;
    if (hidden > 0) lines.unshift(`… +${hidden} etapa(s)`);
    return `<blockquote expandable>${lines.join('\n')}</blockquote>`;
  }

  /**
   * Publica a resposta final.
   * @returns {Promise<object[]>} mensagens enviadas
   */
  async finish({ markup, interrupted = false, maxTurns, note } = {}) {
    this.cleanup();
    const s = this.tracker.state;
    const r = s.result;
    const { final, intermediates } = this.tracker.finalTexts();
    const durationMs = (r?.duration_ms ?? this.now() - s.startedAt) || this.now() - s.startedAt;

    const longIntermediates = intermediates.filter((t) => t.length > 400);
    let md = [...longIntermediates, final].filter((t) => t && t.trim()).join('\n\n');

    let prefix = '';
    if (r?.subtype === 'error_max_turns') prefix = `⏸ <b>Parei no limite de ${maxTurns || ''} etapas.</b> Toque em Continuar para seguir.`;
    else if (interrupted || /^aborted/.test(r?.terminal_reason || '')) prefix = note || '⏹ <b>Interrompido.</b>';
    else if (r && r.subtype !== 'success') prefix = `⚠️ <b>Não consegui terminar.</b> ${friendlyError({ result: r, assistantError: s.assistantError, rateLimit: s.rateLimit })}`;
    else if (r?.subtype === 'success' && s.assistantError) prefix = `⚠️ ${friendlyError({ result: r, assistantError: s.assistantError, rateLimit: s.rateLimit })}`;

    if (!md.trim()) md = prefix ? '' : s.steps.length ? '✅ Pronto.' : '(resposta vazia)';

    const footerParts = [];
    const steps = this.stepsBlock();
    const model = modelLabel(s.model || this.model);
    const statusIcon = r?.subtype === 'success' && !interrupted ? '✅' : '•';
    footerParts.push(
      `<i>${statusIcon} ${formatDuration(durationMs)}${s.steps.length ? ` · ${s.steps.length} etapa(s)` : ''}${model ? ` · ${escapeHtml(model)}` : ''}${s.compacted ? ' · conversa compactada' : ''}</i>`,
    );
    if (steps) footerParts.push(steps);
    const rl = rateLimitLine(s.rateLimit);
    if (rl) footerParts.push(escapeHtml(rl));

    const sent = await this.sender.markdown(this.chatId, md, {
      markup,
      prefixHtml: prefix,
      suffixHtml: footerParts.join('\n'),
      replyTo: this.replyTo,
    });
    await this.removePlaceholder();
    return sent;
  }

  async fail(error, { markup } = {}) {
    this.cleanup();
    const s = this.tracker.state;
    const partial = this.tracker.finalTexts().final;
    const html = [`⚠️ <b>Algo deu errado.</b> ${friendlyError({ error, assistantError: s.assistantError, rateLimit: s.rateLimit })}`, this.stepsBlock()]
      .filter(Boolean)
      .join('\n\n');
    const sent = await this.sender.markdown(this.chatId, partial || '', { markup, prefixHtml: html, replyTo: this.replyTo });
    await this.removePlaceholder();
    return sent;
  }
}
