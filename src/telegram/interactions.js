// Perguntas do Claude (AskUserQuestion), confirmações de ações perigosas e
// aprovação de plano — tudo com botões. Enquanto uma pergunta está aberta,
// qualquer texto ou áudio que você mandar vira a resposta dela.
import crypto from 'node:crypto';
import { escapeHtml, markdownToHtml, formatForTelegram } from './format.js';
import { btn, inline, truncateLabel } from './keyboards.js';
import { describeTool } from '../engine/activity.js';
import { logger } from '../log.js';

const log = logger('perguntas');

const newId = () => crypto.randomBytes(4).toString('hex');

export const DECIDE_ANSWER = 'Decida você o que achar melhor e siga em frente.';

export class Interactions {
  /**
   * @param {object} o
   * @param {import('./sender.js').Sender} o.sender
   * @param {number} o.chatId
   * @param {(key: string) => void} [o.allowAlways]  registra "permitir sempre"
   */
  constructor(o) {
    this.sender = o.sender;
    this.chatId = o.chatId;
    this.allowAlways = o.allowAlways || (() => {});
    this.pending = new Map(); // id → item
    this.awaitingText = null; // { id, kind }
  }

  get hasPending() {
    return this.pending.size > 0;
  }

  /** Cancela tudo que está esperando resposta (ex.: botão Parar). */
  cancelAll(reason = '⏹ Cancelado.') {
    for (const item of this.pending.values()) this.finishItem(item, { cancelled: true, note: reason });
    this.pending.clear();
    this.awaitingText = null;
  }

  async finishItem(item, { cancelled = false, note = '' } = {}) {
    this.pending.delete(item.id);
    if (this.awaitingText?.id === item.id) this.awaitingText = null;
    if (item.messageId) {
      const html = `${item.summaryHtml}${note ? `\n${note}` : ''}`;
      await this.sender.edit(this.chatId, item.messageId, html, { reply_markup: { inline_keyboard: [] } });
    }
    if (cancelled) item.reject?.(new Error('cancelado'));
  }

  bindAbort(item, signal) {
    if (!signal) return;
    if (signal.aborted) {
      this.finishItem(item, { cancelled: true, note: '⏹ Cancelado.' });
      return;
    }
    signal.addEventListener('abort', () => {
      if (this.pending.has(item.id)) this.finishItem(item, { cancelled: true, note: '⏹ Cancelado.' });
    });
  }

  // -------------------------------------------------------------------------
  // Perguntas (AskUserQuestion)
  // -------------------------------------------------------------------------

  /**
   * Faz as perguntas uma de cada vez e devolve { [pergunta]: resposta }.
   */
  async askQuestions(questions, { signal } = {}) {
    const answers = {};
    const list = (questions || []).slice(0, 4);
    for (let i = 0; i < list.length; i++) {
      answers[list[i].question] = await this.askOne(list[i], { index: i, total: list.length, signal });
    }
    return answers;
  }

  questionHtml(q, { index, total }) {
    const counter = total > 1 ? ` <i>(${index + 1}/${total})</i>` : '';
    const opts = (q.options || [])
      .map((o) => `▫️ <b>${escapeHtml(o.label)}</b>${o.description ? ` — ${escapeHtml(o.description)}` : ''}`)
      .join('\n');
    const previews = (q.options || [])
      .filter((o) => o.preview)
      .map((o) => `<b>${escapeHtml(o.label)}</b>\n${markdownToHtml(o.preview)}`)
      .join('\n\n');
    const hint = q.multiSelect ? '\n\n<i>Pode marcar mais de uma e depois tocar em Confirmar.</i>' : '';
    return `❓ <b>${escapeHtml(q.header || 'Pergunta')}</b>${counter}\n${escapeHtml(q.question)}\n\n${opts}${previews ? `\n\n${previews}` : ''}${hint}`;
  }

  questionMarkup(item) {
    const q = item.question;
    const rows = [];
    (q.options || []).forEach((o, n) => {
      if (q.multiSelect) {
        const on = item.selected.has(n);
        rows.push([btn(`${on ? '☑️' : '⬜'} ${o.label}`, `q:${item.id}:t:${n}`)]);
      } else {
        rows.push([btn(o.label, `q:${item.id}:${n}`, 'primary')]);
      }
    });
    if (q.multiSelect) rows.push([btn('✅ Confirmar', `q:${item.id}:k`, 'success')]);
    rows.push([btn('✍️ Outra resposta', `q:${item.id}:o`), btn('🤷 Você decide', `q:${item.id}:d`)]);
    return inline(rows);
  }

  askOne(question, { index, total, signal }) {
    return new Promise(async (resolve, reject) => {
      const item = {
        id: newId(),
        type: 'question',
        question,
        selected: new Set(),
        resolve,
        reject,
        summaryHtml: `❓ <b>${escapeHtml(question.header || 'Pergunta')}</b>: ${escapeHtml(question.question)}`,
      };
      this.pending.set(item.id, item);
      // texto livre enviado enquanto a pergunta está aberta vira resposta
      this.awaitingText = { id: item.id, kind: 'question-implicit' };
      try {
        const msg = await this.sender.html(this.chatId, this.questionHtml(question, { index, total }), { reply_markup: this.questionMarkup(item) });
        item.messageId = msg.message_id;
      } catch (err) {
        log.error('não consegui mostrar a pergunta:', err.description || err.message);
        this.pending.delete(item.id);
        reject(err);
        return;
      }
      this.bindAbort(item, signal);
    });
  }

  answerQuestion(item, value, label) {
    this.finishItem(item, { note: `✅ <b>${escapeHtml(truncateLabel(label ?? value, 200))}</b>` });
    item.resolve(value);
  }

  // -------------------------------------------------------------------------
  // Confirmação de ação perigosa
  // -------------------------------------------------------------------------

  approvalHtml(toolName, input, reason) {
    const d = describeTool(toolName, input);
    const head = `⚠️ <b>Posso continuar?</b>${reason ? ` Isso vai <b>${escapeHtml(reason)}</b>.` : ''}`;
    let body = '';
    if (toolName === 'Bash') {
      body = `<pre>${escapeHtml(String(input.command || '').slice(0, 1500))}</pre>`;
      if (input.description) body += `\n<i>${escapeHtml(input.description)}</i>`;
    } else if (toolName === 'Write') {
      body = `📝 Criar/sobrescrever <code>${escapeHtml(input.file_path)}</code>\n<pre>${escapeHtml(String(input.content || '').slice(0, 700))}</pre>`;
    } else if (toolName === 'Edit' || toolName === 'MultiEdit') {
      const oldS = String(input.old_string || '').slice(0, 400);
      const newS = String(input.new_string || '').slice(0, 400);
      body = `✏️ Editar <code>${escapeHtml(input.file_path)}</code>\n<pre>- ${escapeHtml(oldS)}\n+ ${escapeHtml(newS)}</pre>`;
    } else {
      body = `${d.icon} ${escapeHtml(d.text)}\n<pre>${escapeHtml(JSON.stringify(input, null, 1).slice(0, 900))}</pre>`;
    }
    return `${head}\n\n${body}`;
  }

  askApproval(toolName, input, { reason, signal, alwaysKey } = {}) {
    return new Promise(async (resolve, reject) => {
      const d = describeTool(toolName, input);
      const item = {
        id: newId(),
        type: 'approval',
        toolName,
        input,
        alwaysKey,
        resolve,
        reject,
        summaryHtml: `⚠️ ${escapeHtml(toolName === 'Bash' ? String(input.command || '').slice(0, 200) : d.text)}`,
      };
      this.pending.set(item.id, item);
      const rows = [[btn('✅ Permitir', `a:${item.id}:y`, 'success'), btn('❌ Negar', `a:${item.id}:n`, 'danger')]];
      if (alwaysKey) rows.push([btn('✅ Permitir sempre nesta conversa', `a:${item.id}:s`)]);
      rows.push([btn('✍️ Negar e explicar', `a:${item.id}:e`)]);
      try {
        const msg = await this.sender.html(this.chatId, this.approvalHtml(toolName, input, reason), { reply_markup: inline(rows) });
        item.messageId = msg.message_id;
      } catch (err) {
        this.pending.delete(item.id);
        reject(err);
        return;
      }
      this.bindAbort(item, signal);
    });
  }

  // -------------------------------------------------------------------------
  // Aprovação de plano (ExitPlanMode)
  // -------------------------------------------------------------------------

  approvePlan(plan, { signal, input = {} } = {}) {
    return new Promise(async (resolve, reject) => {
      const item = { id: newId(), type: 'plan', input, resolve, reject, summaryHtml: '📝 <b>Plano</b>' };
      this.pending.set(item.id, item);
      const chunks = formatForTelegram(String(plan || '(plano vazio)'), { limit: 3500 });
      const markup = inline([
        [btn('✅ Executar', `p:${item.id}:y`, 'success')],
        [btn('✏️ Ajustar', `p:${item.id}:e`), btn('❌ Cancelar', `p:${item.id}:n`, 'danger')],
      ]);
      try {
        let last;
        for (let i = 0; i < chunks.length; i++) {
          const html = (i === 0 ? '📝 <b>Plano proposto</b>\n\n' : '') + chunks[i];
          last = await this.sender.html(this.chatId, html, i === chunks.length - 1 ? { reply_markup: markup } : {});
        }
        item.messageId = last.message_id;
        item.summaryHtml = chunks.length === 1 ? `📝 <b>Plano proposto</b>\n\n${chunks[0]}` : '📝 <b>Plano</b> (acima)';
      } catch (err) {
        this.pending.delete(item.id);
        reject(err);
        return;
      }
      this.bindAbort(item, signal);
    });
  }

  // -------------------------------------------------------------------------
  // Botões e texto livre
  // -------------------------------------------------------------------------

  /** @returns {Promise<{handled: boolean, toast?: string}>} */
  async handleCallback(data) {
    const [kind, id, action, extra] = String(data).split(':');
    if (!['q', 'a', 'p'].includes(kind)) return { handled: false };
    const item = this.pending.get(id);
    if (!item) return { handled: true, toast: 'Essa pergunta já foi respondida ou cancelada.' };

    if (kind === 'q') {
      const q = item.question;
      if (action === 't') {
        const n = Number(extra);
        if (item.selected.has(n)) item.selected.delete(n);
        else item.selected.add(n);
        await this.sender.markup(this.chatId, item.messageId, this.questionMarkup(item));
        return { handled: true };
      }
      if (action === 'k') {
        const labels = [...item.selected].sort().map((n) => q.options[n]?.label).filter(Boolean);
        if (!labels.length) return { handled: true, toast: 'Marque pelo menos uma opção.' };
        this.answerQuestion(item, labels.join(', '));
        return { handled: true };
      }
      if (action === 'o') {
        this.awaitingText = { id: item.id, kind: 'question' };
        await this.sender.html(this.chatId, '✍️ Escreva (ou grave) a sua resposta:', { reply_markup: { force_reply: true, input_field_placeholder: 'Sua resposta…' } });
        return { handled: true };
      }
      if (action === 'd') {
        this.answerQuestion(item, DECIDE_ANSWER, '🤷 Você decide');
        return { handled: true };
      }
      const opt = q.options?.[Number(action)];
      if (!opt) return { handled: true, toast: 'Opção inválida.' };
      this.answerQuestion(item, opt.label);
      return { handled: true };
    }

    if (kind === 'a') {
      if (action === 'y') {
        this.finishItem(item, { note: '✅ Permitido.' });
        item.resolve({ behavior: 'allow', updatedInput: item.input });
      } else if (action === 's') {
        if (item.alwaysKey) this.allowAlways(item.alwaysKey);
        this.finishItem(item, { note: '✅ Permitido (e liberado nesta conversa).' });
        item.resolve({ behavior: 'allow', updatedInput: item.input });
      } else if (action === 'n') {
        this.finishItem(item, { note: '❌ Negado.' });
        item.resolve({ behavior: 'deny', message: 'O usuário negou esta ação pelo Telegram. Não tente contornar; pergunte como ele prefere seguir.' });
      } else if (action === 'e') {
        this.awaitingText = { id: item.id, kind: 'approval' };
        await this.sender.html(this.chatId, '✍️ O que eu devo fazer em vez disso?', { reply_markup: { force_reply: true, input_field_placeholder: 'Explique…' } });
      }
      return { handled: true };
    }

    if (kind === 'p') {
      if (action === 'y') {
        this.finishItem(item, { note: '✅ Aprovado. Executando…' });
        item.resolve({ behavior: 'allow', updatedInput: item.input || {} });
      } else if (action === 'n') {
        this.finishItem(item, { note: '❌ Plano cancelado.' });
        item.resolve({ behavior: 'deny', message: 'O usuário cancelou o plano. Não execute nada; pergunte o que ele quer.', interrupt: true });
      } else if (action === 'e') {
        this.awaitingText = { id: item.id, kind: 'plan' };
        await this.sender.html(this.chatId, '✍️ O que você quer mudar no plano?', { reply_markup: { force_reply: true, input_field_placeholder: 'Ajustes…' } });
      }
      return { handled: true };
    }
    return { handled: false };
  }

  /** Usa um texto como resposta, se houver algo esperando. @returns {boolean} */
  handleText(text) {
    const wait = this.awaitingText;
    if (!wait) return false;
    const item = this.pending.get(wait.id);
    if (!item) {
      this.awaitingText = null;
      return false;
    }
    const t = String(text).trim();
    if (!t) return false;
    if (item.type === 'question') {
      this.answerQuestion(item, t);
      return true;
    }
    if (item.type === 'approval') {
      this.finishItem(item, { note: `❌ Negado: “${escapeHtml(truncateLabel(t, 200))}”` });
      item.resolve({ behavior: 'deny', message: `O usuário negou esta ação e disse: ${t}` });
      return true;
    }
    if (item.type === 'plan') {
      this.finishItem(item, { note: `✏️ Ajustes pedidos: “${escapeHtml(truncateLabel(t, 200))}”` });
      item.resolve({ behavior: 'deny', message: `O usuário quer ajustes no plano antes de executar: ${t}. Revise o plano e apresente de novo.` });
      return true;
    }
    return false;
  }

  /** Texto enviado enquanto há aprovação/plano aberto (sem ter tocado em "explicar"). */
  handleTextForOpenApproval(text) {
    for (const item of this.pending.values()) {
      if (item.type === 'approval') {
        this.awaitingText = { id: item.id, kind: 'approval' };
        return this.handleText(text);
      }
      if (item.type === 'plan') {
        this.awaitingText = { id: item.id, kind: 'plan' };
        return this.handleText(text);
      }
    }
    return false;
  }
}
