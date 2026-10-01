// Servidor falso da Bot API do Telegram para os testes de ponta a ponta.
// Guarda tudo o que o bot envia e deixa o teste "ser o usuário"
// (mandar mensagens, tocar em botões, apertar o parar do rascunho).
import http from 'node:http';
import { validateTelegramHtml, visibleLength } from './telegram-html.js';

export async function startFakeTelegram({ token = '123:TESTE', botId = 999, draftSupported = true } = {}) {
  const calls = [];
  const updates = [];
  const pollers = [];
  const files = new Map(); // file_id → { path, buffer }
  let updateId = 1;
  let messageId = 1000;
  const listeners = new Set();

  function record(method, payload) {
    const call = { method, payload, at: Date.now() };
    calls.push(call);
    for (const l of [...listeners]) l(call);
    return call;
  }

  function flushPollers() {
    while (pollers.length && updates.length) {
      const p = pollers.shift();
      p();
    }
  }

  function message(chatId, payload, extra = {}) {
    return {
      message_id: ++messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(chatId), type: 'private', first_name: 'Usuário' },
      from: { id: botId, is_bot: true, first_name: 'Bot', username: 'agente_teste_bot' },
      ...extra,
    };
  }

  function checkText(text, payload) {
    if (payload.parse_mode === 'HTML') {
      const err = validateTelegramHtml(text);
      if (err) return `Bad Request: ${err}`;
      if (visibleLength(text) > 4096) return 'Bad Request: message is too long';
    } else if (String(text ?? '').length > 4096) return 'Bad Request: message is too long';
    if (!String(text ?? '').trim()) return 'Bad Request: message text is empty';
    return null;
  }

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const buf = Buffer.concat(chunks);
    const type = req.headers['content-type'] || '';
    if (type.includes('application/json')) return JSON.parse(buf.toString('utf8') || '{}');
    if (type.includes('multipart/form-data')) {
      // só o suficiente para os testes: campos de texto e nome dos arquivos
      const boundary = type.split('boundary=')[1].replace(/^"|"$/g, '');
      const out = { _files: [] };
      for (const part of buf.toString('latin1').split(`--${boundary}`)) {
        const sep = part.indexOf('\r\n\r\n');
        if (sep === -1) continue;
        const headers = part.slice(0, sep);
        const body = part.slice(sep + 4).replace(/\r\n$/, '');
        const name = (headers.match(/;\s*name="?([^";\r\n]*)"?/i) || [])[1];
        const filename = (headers.match(/filename="?([^";\r\n]*)"?/i) || [])[1];
        if (!name) continue;
        if (filename !== undefined) out._files.push({ field: name, filename: Buffer.from(filename, 'latin1').toString('utf8'), size: body.length });
        else out[name] = Buffer.from(body, 'latin1').toString('utf8');
      }
      return out;
    }
    return {};
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    // download de arquivos
    const fileMatch = url.pathname.match(/^\/file\/bot[^/]+\/(.+)$/);
    if (fileMatch) {
      const f = [...files.values()].find((x) => x.path === fileMatch[1]);
      if (!f) return send(404, { ok: false });
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(f.buffer);
    }
    const m = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
    if (!m) return send(404, { ok: false, error_code: 404, description: 'Not Found' });
    if (m[1] !== token) return send(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    const method = m[2];
    let p = {};
    try {
      p = await readBody(req);
    } catch {
      return send(400, { ok: false, error_code: 400, description: 'Bad Request: invalid body' });
    }
    const ok = (result) => send(200, { ok: true, result });
    const bad = (description, code = 400) => send(code, { ok: false, error_code: code, description });

    switch (method) {
      case 'getMe':
        return ok({ id: botId, is_bot: true, first_name: 'Bot', username: 'agente_teste_bot', can_join_groups: false });
      case 'deleteWebhook':
      case 'setMyCommands':
      case 'setChatMenuButton':
        record(method, p);
        return ok(true);
      case 'getUpdates': {
        const offset = Number(p.offset || 0);
        while (updates.length && updates[0].update_id < offset) updates.shift();
        if (updates.length) return ok(updates.splice(0, 100));
        const timeout = Math.min(Number(p.timeout || 0), 2) * 1000;
        if (!timeout) return ok([]);
        await new Promise((resolve) => {
          const t = setTimeout(resolve, timeout);
          pollers.push(() => {
            clearTimeout(t);
            resolve();
          });
        });
        while (updates.length && updates[0].update_id < offset) updates.shift();
        return ok(updates.splice(0, 100));
      }
      case 'sendMessage': {
        const err = checkText(p.text, p);
        record(method, { ...p, _error: err });
        if (err) return bad(err);
        const msg = message(p.chat_id, p, { text: p.text, reply_markup: p.reply_markup });
        calls[calls.length - 1].result = msg;
        return ok(msg);
      }
      case 'editMessageText': {
        const err = checkText(p.text, p);
        record(method, { ...p, _error: err });
        if (err) return bad(err);
        return ok(message(p.chat_id, p, { message_id: p.message_id, text: p.text }));
      }
      case 'sendMessageDraft': {
        if (!draftSupported) {
          record(method, { ...p, _error: 'not found' });
          return bad('Not Found: method not found', 404);
        }
        const err = p.text ? checkText(p.text, p) : null;
        record(method, { ...p, _error: err });
        if (err) return bad(err);
        return ok(true);
      }
      case 'editMessageReplyMarkup':
      case 'deleteMessage':
      case 'sendChatAction':
      case 'answerCallbackQuery':
        record(method, p);
        return ok(true);
      case 'getFile': {
        const f = files.get(p.file_id);
        record(method, p);
        if (!f) return bad('Bad Request: invalid file_id');
        return ok({ file_id: p.file_id, file_unique_id: p.file_id, file_size: f.buffer.length, file_path: f.path });
      }
      case 'sendDocument':
      case 'sendPhoto': {
        record(method, p);
        return ok(message(p.chat_id, p, { [method === 'sendPhoto' ? 'photo' : 'document']: {} }));
      }
      default:
        record(method, p);
        return ok(true);
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  function pushUpdate(u) {
    updates.push({ update_id: updateId++, ...u });
    flushPollers();
  }

  let userMsgId = 1;
  const api = {
    url: `http://127.0.0.1:${port}`,
    token,
    calls,
    files,
    setDraftSupported(v) {
      draftSupported = v;
    },
    addFile(fileId, path, buffer) {
      files.set(fileId, { path, buffer });
    },
    /** O usuário manda uma mensagem. */
    sendText(userId, text, extra = {}) {
      const msg = {
        message_id: userMsgId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: userId, type: 'private', first_name: 'Usuário' },
        from: { id: userId, is_bot: false, first_name: 'Usuário' },
        text,
        ...extra,
      };
      if (text.startsWith('/')) msg.entities = [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0].length }];
      pushUpdate({ message: msg });
      return msg;
    },
    sendMessage(userId, fields) {
      const msg = {
        message_id: userMsgId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: userId, type: 'private', first_name: 'Usuário' },
        from: { id: userId, is_bot: false, first_name: 'Usuário' },
        ...fields,
      };
      pushUpdate({ message: msg });
      return msg;
    },
    /** O usuário toca num botão. */
    tap(userId, messageId, data) {
      pushUpdate({
        callback_query: {
          id: String(Math.random()).slice(2),
          from: { id: userId, is_bot: false, first_name: 'Usuário' },
          chat_instance: '1',
          message: { message_id: messageId, date: 0, chat: { id: userId, type: 'private' }, text: '' },
          data,
        },
      });
    },
    /** O usuário aperta o "parar" nativo do rascunho. */
    stopDraft(userId, draftId) {
      pushUpdate({ stopped_message_generation: { chat: { id: userId, type: 'private', first_name: 'Usuário' }, draft_id: draftId } });
    },
    /** Espera até alguma chamada satisfazer o critério. */
    waitFor(pred, { timeout = 30_000, from = 0 } = {}) {
      const found = calls.slice(from).find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          listeners.delete(l);
          reject(new Error(`timeout esperando chamada ao Telegram. Últimas: ${calls.slice(-6).map((c) => c.method + ':' + String(c.payload.text ?? c.payload.data ?? '').slice(0, 80)).join(' | ')}`));
        }, timeout);
        const l = (call) => {
          if (pred(call)) {
            clearTimeout(t);
            listeners.delete(l);
            resolve(call);
          }
        };
        listeners.add(l);
      });
    },
    sent(method) {
      return calls.filter((c) => c.method === method);
    },
    texts() {
      return calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text);
    },
    buttons(call) {
      return (call?.payload?.reply_markup?.inline_keyboard || []).flat();
    },
    close: () =>
      new Promise((resolve) => {
        for (const p of pollers.splice(0)) p();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
  return api;
}
