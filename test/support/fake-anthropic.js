// Servidor falso da API de Mensagens da Anthropic, para testar o bot com o
// Claude Code de verdade sem gastar nada e sem precisar de login.
//
// O Claude Code é apontado para cá com ANTHROPIC_BASE_URL. Cada requisição a
// /v1/messages chama `responder(body, info)`, que devolve um "roteiro":
//   { blocks: [ {type:'text', text}, {type:'tool_use', name, input}, {type:'thinking', thinking} ],
//     stop_reason?: 'end_turn' | 'tool_use', delayMs?: number }
// ou { status: 529, error: {...} } para simular falha (o CLI emite api_retry).
import http from 'node:http';

let toolCounter = 0;

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// O Claude Code coloca mensagens com role "system" no fim da lista; elas são
// ignoradas aqui para achar a última mensagem real.
function lastNonSystem(body) {
  const msgs = body?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role !== 'system') return msgs[i];
  return null;
}

export function lastUserText(body) {
  const msgs = (body?.messages || []).filter((m) => m.role !== 'system');
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    const texts = (m.content || []).filter((b) => b.type === 'text').map((b) => b.text);
    if (texts.length) return texts.join('\n');
    return null; // última mensagem do usuário é tool_result
  }
  return null;
}

export function lastToolResults(body) {
  const last = lastNonSystem(body);
  if (!last || last.role !== 'user' || typeof last.content === 'string') return [];
  return last.content.filter((b) => b.type === 'tool_result');
}

export function toolResultText(r) {
  if (typeof r.content === 'string') return r.content;
  return (r.content || []).map((c) => c.text || '').join(' ');
}

/** Primeiro texto de usuário "real" da conversa inteira (ignora lembretes de sistema). */
export function allUserTexts(body) {
  const out = [];
  for (const m of body?.messages || []) {
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') out.push(m.content);
    else for (const b of m.content || []) if (b.type === 'text') out.push(b.text);
  }
  return out;
}

export async function startFakeAnthropic(responder) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    const url = req.url || '';
    requests.push({ method: req.method, url, body });

    if (url.startsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 1000 }));
      return;
    }
    if (!url.startsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'fake' } }));
      return;
    }

    let script;
    try {
      script = (await responder(body, { requests })) || { blocks: [{ type: 'text', text: 'ok' }] };
    } catch (err) {
      script = { blocks: [{ type: 'text', text: `erro no roteiro: ${err.message}` }] };
    }

    if (script.status) {
      res.writeHead(script.status, { 'content-type': 'application/json', ...(script.headers || {}) });
      res.end(
        JSON.stringify({
          type: 'error',
          error: script.error || { type: 'overloaded_error', message: 'Overloaded' },
        }),
      );
      return;
    }

    const model = body.model || 'claude-sonnet-fake';
    const blocks = script.blocks || [];
    const hasTool = blocks.some((b) => b.type === 'tool_use');
    const stopReason = script.stop_reason || (hasTool ? 'tool_use' : 'end_turn');
    const delay = script.delayMs ?? 5;

    if (body.stream === false) {
      // resposta sem streaming (o CLI usa isso em chamadas auxiliares)
      const content = blocks.map((b) => {
        if (b.type === 'tool_use') return { type: 'tool_use', id: `toolu_fake_${++toolCounter}`, name: b.name, input: b.input };
        if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking, signature: 'sig' };
        return { type: 'text', text: b.text };
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `msg_fake_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          model,
          content,
          stop_reason: stopReason,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
      );
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'request-id': `req_fake_${Date.now()}`,
    });
    sse(res, 'message_start', {
      type: 'message_start',
      message: {
        id: `msg_fake_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });

    let index = 0;
    for (const b of blocks) {
      if (res.destroyed) return;
      if (b.type === 'text') {
        sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        const parts = String(b.text).match(/[\s\S]{1,12}/g) || [''];
        for (const p of parts) {
          await sleep(b.chunkDelayMs ?? delay);
          if (res.destroyed) return;
          sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: p } });
        }
        sse(res, 'content_block_stop', { type: 'content_block_stop', index });
      } else if (b.type === 'thinking') {
        sse(res, 'content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        });
        await sleep(b.durationMs ?? delay);
        sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } });
        sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'fakesig' } });
        sse(res, 'content_block_stop', { type: 'content_block_stop', index });
      } else if (b.type === 'tool_use') {
        const id = b.id || `toolu_fake_${++toolCounter}`;
        sse(res, 'content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id, name: b.name, input: {} },
        });
        await sleep(delay);
        sse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input || {}) },
        });
        sse(res, 'content_block_stop', { type: 'content_block_stop', index });
      }
      index++;
    }
    if (script.hangMs) await sleep(script.hangMs);
    sse(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 20 },
    });
    sse(res, 'message_stop', { type: 'message_stop' });
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
