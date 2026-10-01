import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnTracker } from '../src/engine/turn.js';
import { describeTool } from '../src/engine/activity.js';
import { audioCtxFor, voiceCommand } from '../src/media/transcribe.js';

const se = (event, parent = null) => ({ type: 'stream_event', event, parent_tool_use_id: parent, session_id: 's1' });

test('acompanha texto, ferramenta e resultado de um pedido', () => {
  let changes = 0;
  const t = new TurnTracker({ onChange: () => changes++ });
  t.handle({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', session_id: 's1' });
  t.handle(se({ type: 'message_start', message: {} }));
  t.handle(se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  t.handle(se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Vou ver ' } }));
  t.handle(se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'os logs.' } }));
  assert.equal(t.state.phase, 'writing');
  assert.equal(t.state.liveText, 'Vou ver os logs.');
  t.handle(se({ type: 'content_block_stop', index: 0 }));
  t.handle(se({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} } }));
  assert.equal(t.state.steps.length, 1);
  assert.equal(t.state.steps[0].status, 'preparing');
  t.handle({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'journalctl -n 20', description: 'Lê os logs' } }] },
  });
  assert.equal(t.state.steps[0].status, 'running');
  assert.equal(t.state.steps[0].text, 'Lê os logs');
  t.handle({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok', is_error: false }] },
  });
  assert.equal(t.state.steps[0].status, 'done');
  t.handle(se({ type: 'message_start', message: {} }));
  t.handle(se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  t.handle(se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Tudo certo.' } }));
  t.handle(se({ type: 'content_block_stop', index: 0 }));
  t.handle({ type: 'result', subtype: 'success', result: 'Tudo certo.', is_error: false, session_id: 's1', duration_ms: 1200 });
  assert.equal(t.state.phase, 'done');
  const { final, intermediates } = t.finalTexts();
  assert.equal(final, 'Tudo certo.');
  assert.deepEqual(intermediates, ['Vou ver os logs.']);
  assert.ok(changes > 5);
});

test('ação negada aparece como negada', () => {
  const t = new TurnTracker();
  t.handle({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'rm -rf a' } }] } });
  t.handle({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'O usuário negou esta ação pelo Telegram.', is_error: true }] },
  });
  assert.equal(t.state.steps[0].status, 'denied');
});

test('nova tentativa da API e limite de uso', () => {
  const t = new TurnTracker();
  t.handle({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 3000, error_status: 529, error: 'overloaded' });
  assert.equal(t.state.phase, 'retrying');
  assert.equal(t.state.retry.attempt, 2);
  t.handle({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 0.85, rateLimitType: 'five_hour' } });
  assert.equal(t.state.rateLimit.status, 'allowed_warning');
  t.handle({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
  assert.equal(t.state.rateLimit.status, 'allowed_warning', 'aviso continua até o fim do pedido');
});

test('subagente conta ações no passo do Agent', () => {
  const t = new TurnTracker();
  t.handle({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'ag', name: 'Agent', input: { description: 'Revisar código' } }] } });
  t.handle({ type: 'assistant', parent_tool_use_id: 'ag', message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/a/b.js' } }] } });
  t.handle({ type: 'assistant', parent_tool_use_id: 'ag', message: { content: [{ type: 'tool_use', id: 'r2', name: 'Grep', input: { pattern: 'x' } }] } });
  assert.equal(t.state.steps.length, 1);
  assert.equal(t.state.steps[0].children, 2);
  assert.match(t.state.steps[0].detail, /Procurando/);
});

test('descrições em português', () => {
  assert.equal(describeTool('Read', { file_path: '/srv/app/src/bot.js' }).text, 'Lendo bot.js');
  assert.equal(describeTool('Grep', { pattern: 'timeout', path: '/srv/app/src' }).text, 'Procurando "timeout" em src');
  assert.equal(describeTool('Bash', { command: 'npm test' }).text, 'Rodando npm test');
  assert.equal(describeTool('WebFetch', { url: 'https://www.exemplo.com/a' }).text, 'Abrindo exemplo.com');
  assert.equal(describeTool('mcp__railway__list-services', {}).text, 'railway: list services');
  assert.equal(describeTool('TodoWrite', { todos: [{ status: 'in_progress', activeForm: 'Rodando os testes', content: 'x' }] }).text, 'Rodando os testes');
});

test('contexto de áudio automático', () => {
  assert.equal(audioCtxFor(5), 384);
  assert.equal(audioCtxFor(15), 878);
  assert.equal(audioCtxFor(29), 0);
  assert.equal(audioCtxFor(15, '0'), 0);
  assert.equal(audioCtxFor(15, '512'), 512);
});

test('comandos de voz', () => {
  assert.equal(voiceCommand('Para.'), 'stop');
  assert.equal(voiceCommand('para tudo'), 'stop');
  assert.equal(voiceCommand('Nova conversa!'), 'new');
  assert.equal(voiceCommand('Painel'), 'panel');
  assert.equal(voiceCommand('continua'), 'continue');
  assert.equal(voiceCommand('para de usar o docker e usa o podman'), null);
  assert.equal(voiceCommand('lista os containers'), null);
});
