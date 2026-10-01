// Envio "à prova de falhas" para o Telegram: se o HTML for recusado, manda em
// texto puro; respostas longas viram várias mensagens; edições repetidas são
// ignoradas sem erro.
import { formatForTelegram, htmlToPlain, plainChunks } from './format.js';
import { logger } from '../log.js';

const log = logger('envio');

export function isParseError(err) {
  const d = String(err?.description || err?.message || '');
  return /can't parse entities|unsupported start tag|unclosed|can't find end|entity/i.test(d) && err?.error_code === 400;
}

export function isNotModified(err) {
  return /message is not modified/i.test(String(err?.description || err?.message || ''));
}

export function isMessageGone(err) {
  return /message to edit not found|message to delete not found|message can't be (edited|deleted)|MESSAGE_ID_INVALID/i.test(
    String(err?.description || err?.message || ''),
  );
}

export function retryAfterMs(err) {
  const s = err?.parameters?.retry_after;
  return typeof s === 'number' ? s * 1000 : 0;
}

export class Sender {
  constructor(api) {
    this.api = api;
  }

  async html(chatId, html, extra = {}) {
    try {
      return await this.api.sendMessage(chatId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
    } catch (err) {
      if (!isParseError(err)) throw err;
      log.warn('HTML recusado, enviando como texto puro:', err.description);
      const { parse_mode, ...rest } = { ...extra };
      return this.api.sendMessage(chatId, htmlToPlain(html).slice(0, 4096), { link_preview_options: { is_disabled: true }, ...rest });
    }
  }

  async text(chatId, text, extra = {}) {
    return this.api.sendMessage(chatId, String(text).slice(0, 4096), { link_preview_options: { is_disabled: true }, ...extra });
  }

  /**
   * Envia um Markdown longo em quantas mensagens forem necessárias.
   * `markup` vai na última; `prefixHtml`/`suffixHtml` entram na primeira/última.
   */
  async markdown(chatId, md, { markup, replyTo, prefixHtml = '', suffixHtml = '' } = {}) {
    let chunks = formatForTelegram(md);
    if (prefixHtml) chunks[0] = chunks[0] ? `${prefixHtml}\n\n${chunks[0]}` : prefixHtml;
    if (suffixHtml) {
      const last = chunks.length - 1;
      if ((chunks[last] + suffixHtml).length < 4000) chunks[last] = chunks[last] ? `${chunks[last]}\n\n${suffixHtml}` : suffixHtml;
      else chunks.push(suffixHtml);
    }
    chunks = chunks.filter((c) => c && c.trim());
    if (!chunks.length) chunks = ['(sem texto)'];
    const sent = [];
    for (let i = 0; i < chunks.length; i++) {
      const extra = {};
      if (i === 0 && replyTo) extra.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
      if (i === chunks.length - 1 && markup) extra.reply_markup = markup;
      try {
        sent.push(await this.html(chatId, chunks[i], extra));
      } catch (err) {
        // último recurso: texto puro em pedaços
        log.error('falha ao enviar parte da resposta:', err.description || err.message);
        for (const piece of plainChunks(htmlToPlain(chunks[i]))) {
          sent.push(await this.api.sendMessage(chatId, piece, i === chunks.length - 1 && markup ? { reply_markup: markup } : {}));
        }
      }
    }
    return sent;
  }

  async edit(chatId, messageId, html, extra = {}) {
    try {
      await this.api.editMessageText(chatId, messageId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
      return true;
    } catch (err) {
      if (isNotModified(err)) return true;
      if (isParseError(err)) {
        try {
          await this.api.editMessageText(chatId, messageId, htmlToPlain(html).slice(0, 4096), { ...extra, parse_mode: undefined });
          return true;
        } catch (e2) {
          if (isNotModified(e2)) return true;
          return false;
        }
      }
      if (!isMessageGone(err)) log.warn('edição falhou:', err.description || err.message);
      return false;
    }
  }

  async markup(chatId, messageId, replyMarkup) {
    try {
      await this.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: replyMarkup });
      return true;
    } catch (err) {
      if (!isNotModified(err) && !isMessageGone(err)) log.warn('troca de botões falhou:', err.description || err.message);
      return false;
    }
  }

  async del(chatId, messageId) {
    try {
      await this.api.deleteMessage(chatId, messageId);
      return true;
    } catch {
      return false;
    }
  }

  async action(chatId, action = 'typing') {
    try {
      await this.api.sendChatAction(chatId, action);
    } catch {
      /* indicador é opcional */
    }
  }
}
