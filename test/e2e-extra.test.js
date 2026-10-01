// Mais cenários de ponta a ponta: limite de etapas, avisos de demora, áudio,
// fallback sem rascunho nativo, recuperação após reinício e conversa nova automática.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startHarness, conversationState, toolResultText, USER } from './support/harness.js';

function responder(body) {
  if (!body.tools?.length) return { blocks: [{ type: 'text', text: 'ok' }] };
  const st = conversationState(body);
  const tr = st.toolResults.map(toolResultText).join(' | ');
  switch (st.tag) {
    case 'OI':
      return { blocks: [{ type: 'text', text: 'Olá pelo áudio!' }] };
    case 'LOOP':
      return { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: `echo volta-${st.step}`, description: `Repete ${st.step}` } }] };
    case 'LENTO':
      if (st.step === 0) return { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 20; echo fim', description: 'Espera bastante' } }] };
      return { blocks: [{ type: 'text', text: 'acabou o lento' }] };
    case 'DOIS_RM':
      if (st.step === 0) return { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf ./lixo-a', description: 'Apaga lixo' } }] };
      if (st.step === 1) return { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf ./lixo-a', description: 'Apaga lixo de novo' } }] };
      return { blocks: [{ type: 'text', text: `feito: ${tr.slice(0, 60)}` }] };
    case 'MULTI':
      if (st.step === 0)
        return {
          blocks: [
            {
              type: 'tool_use',
              name: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    question: 'Quais serviços reiniciar?',
                    header: 'Serviços',
                    multiSelect: true,
                    options: [
                      { label: 'nginx', description: 'proxy' },
                      { label: 'api', description: 'backend' },
                      { label: 'worker', description: 'filas' },
                    ],
                  },
                ],
              },
            },
          ],
        };
      return { blocks: [{ type: 'text', text: `Escolhas: ${tr}` }] };
    case 'ESFORCO':
      return { blocks: [{ type: 'text', text: `esforco=${JSON.stringify(body.output_config?.effort ?? null)}` }] };
    default:
      return { blocks: [{ type: 'text', text: `ok:${st.tag || ''}` }] };
  }
}

function makeFakeWhisper(dir) {
  const transcriptFile = path.join(dir, 'transcricao.txt');
  const cli = path.join(dir, 'whisper-cli');
  fs.writeFileSync(cli, `#!/bin/sh\necho "[00:00:00.000 --> 00:00:02.000]  $(cat ${transcriptFile})"\n`, { mode: 0o755 });
  const model = path.join(dir, 'ggml-tiny.bin');
  fs.writeFileSync(model, 'x');
  const ogg = path.join(dir, 'voz.ogg');
  execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', ogg]);
  return { cli, model, ogg, say: (t) => fs.writeFileSync(transcriptFile, t) };
}

describe('limites, avisos e áudio', () => {
  let h;
  let voice;
  before(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-voz-'));
    voice = makeFakeWhisper(dir);
    h = await startHarness({
      responder,
      env: { MAX_TURNS: '3', LONG_TASK_NOTICE_MIN: '0.05', STALL_MIN: '0.15', WHISPER_CLI: voice.cli, WHISPER_MODEL: voice.model },
    });
    h.tg.addFile('voz1', 'voice/v1.oga', fs.readFileSync(voice.ogg));
  });
  after(async () => h?.close());

  test('limite de etapas: avisa e oferece Continuar, que segue a conversa', async () => {
    const from = h.mark();
    h.send('#LOOP faz em loop');
    const final = await h.waitFinal(from);
    assert.match(final.payload.text, /Parei no limite de 3 etapas/);
    const cont = h.tg.buttons(final).find((b) => b.text === '▶️ Continuar');
    assert.ok(cont, 'deveria ter o botão Continuar');
    await h.idle();
    const from2 = h.mark();
    h.tg.tap(USER, final.result.message_id, cont.callback_data);
    const final2 = await h.waitFinal(from2);
    assert.ok(final2, 'continuar deveria gerar uma nova resposta');
    assert.ok(h.ctrl.session.sessionId, 'a conversa não pode ter sido apagada');
    await h.idle();
  });

  test('tarefa longa: aviso "ainda trabalhando" e aviso de silêncio com opções', async () => {
    const from = h.mark();
    h.send('#LENTO demora');
    const notice = await h.waitText(from, /Ainda trabalhando/, { timeout: 15_000 });
    assert.ok(h.tg.buttons(notice).some((b) => b.text === '🛑 Parar'));
    const stall = await h.waitText(from, /não dá sinal/, { timeout: 20_000 });
    const labels = h.tg.buttons(stall).map((b) => b.text);
    assert.ok(labels.includes('⏳ Esperar mais'));
    assert.ok(labels.includes('♻️ Reiniciar a sessão'));
    h.send('🛑 Parar');
    await h.waitFinal(from);
    await h.idle();
  });

  test('áudio com "para" interrompe na hora, mesmo com tarefa rodando', async () => {
    const from = h.mark();
    h.send('#LENTO outra demorada');
    await h.tg.waitFor((c) => c.method === 'sendMessageDraft' && /Espera bastante/.test(c.payload.text || ''), { from });
    voice.say('Para.');
    h.tg.sendMessage(USER, { voice: { file_id: 'voz1', file_unique_id: 'v1', duration: 1, mime_type: 'audio/ogg' } });
    const note = await h.tg.waitFor((c) => c.method === 'editMessageText' && /🎤 <i>“Para\.”<\/i>/.test(c.payload.text || ''), { from });
    assert.ok(note);
    const final = await h.waitFinal(from);
    assert.match(final.payload.text, /Interrompido/);
    await h.idle();
  });

  test('áudio comum vira pedido e mostra a transcrição', async () => {
    const from = h.mark();
    voice.say('#OI fala comigo');
    h.tg.sendMessage(USER, { voice: { file_id: 'voz1', file_unique_id: 'v1', duration: 1, mime_type: 'audio/ogg' } });
    const final = await h.waitFinal(from);
    assert.match(final.payload.text, /Olá pelo áudio!/);
    await h.idle();
  });

  test('"Permitir sempre nesta conversa" libera o mesmo comando depois', async () => {
    fs.mkdirSync(path.join(h.cwd, 'lixo-a'), { recursive: true });
    const from = h.mark();
    h.send('#DOIS_RM limpa');
    const ask = await h.waitText(from, /Posso continuar\?/);
    const always = h.tg.buttons(ask).find((b) => /sempre/.test(b.text));
    h.tg.tap(USER, ask.result.message_id, always.callback_data);
    const final = await h.waitFinal(from);
    const asks = h.tg.calls.slice(from).filter((c) => c.method === 'sendMessage' && /Posso continuar\?/.test(c.payload.text || ''));
    assert.equal(asks.length, 1, 'o segundo rm igual não deveria perguntar de novo');
    assert.match(final.payload.text, /feito/);
    await h.idle();
  });

  test('confirmação respondida digitando "pode"', async () => {
    fs.mkdirSync(path.join(h.cwd, 'lixo-a'), { recursive: true });
    await h.app.ctrlFor(USER).newConversation({ announce: false }); // zera o "sempre"
    const from = h.mark();
    h.send('#DOIS_RM limpa de novo');
    await h.waitText(from, /Posso continuar\?/);
    h.send('pode');
    const second = await h.tg.waitFor((c) => c.method === 'sendMessage' && /Posso continuar\?/.test(c.payload.text || ''), { from: from + 3 });
    h.send('não');
    const final = await h.waitFinal(from);
    assert.ok(second);
    assert.match(final.payload.text, /feito/);
    await h.idle();
  });

  test('pergunta de múltipla escolha com Confirmar', async () => {
    const from = h.mark();
    h.send('#MULTI quais?');
    const q = await h.waitText(from, /❓ <b>Serviços<\/b>/);
    const [nginx, , worker] = h.tg.buttons(q);
    h.tg.tap(USER, q.result.message_id, nginx.callback_data);
    h.tg.tap(USER, q.result.message_id, worker.callback_data);
    await h.tg.waitFor((c) => c.method === 'editMessageReplyMarkup' && JSON.stringify(c.payload.reply_markup).includes('☑️ worker'), { from });
    const confirm = h.tg.buttons(q).find((b) => b.text === '✅ Confirmar');
    h.tg.tap(USER, q.result.message_id, confirm.callback_data);
    const final = await h.waitFinal(from);
    assert.match(final.payload.text, /nginx, worker/);
    await h.idle();
  });

  test('"Pensar mais" aumenta o esforço só naquele pedido', async () => {
    let from = h.mark();
    h.send('#ESFORCO qual?');
    let final = await h.waitFinal(from);
    assert.match(final.payload.text, /esforco="low"/);
    await h.idle();
    from = h.mark();
    const more = h.tg.buttons(final).find((b) => b.text === '🧠 Pensar mais');
    h.tg.tap(USER, final.result.message_id, more.callback_data);
    final = await h.waitFinal(from);
    assert.match(final.payload.text, /esforco="high"/);
    await h.idle();
    from = h.mark();
    h.send('#ESFORCO e agora?');
    final = await h.waitFinal(from);
    assert.match(final.payload.text, /esforco="low"/, 'o esforço volta ao normal');
    await h.idle();
  });

  test('sugestão de próxima pergunta vira botão 💡', async () => {
    const from = h.mark();
    h.send('#OI mais uma');
    const final = await h.waitFinal(from);
    const withSuggestion = await h.tg.waitFor(
      (c) => c.method === 'editMessageReplyMarkup' && c.payload.message_id === final.result.message_id && JSON.stringify(c.payload.reply_markup).includes('💡'),
      { from, timeout: 10_000 },
    );
    assert.ok(withSuggestion);
    await h.idle();
  });

  test('"Parar o atual e fazer este" na fila', async () => {
    const from = h.mark();
    h.send('#LENTO longo');
    await h.tg.waitFor((c) => c.method === 'sendMessageDraft' && /Espera bastante/.test(c.payload.text || ''), { from });
    h.send('#OI urgente');
    const notice = await h.waitText(from, /Na fila/);
    const now = h.tg.buttons(notice).find((b) => /Parar o atual/.test(b.text));
    h.tg.tap(USER, notice.result.message_id, now.callback_data);
    const urgent = await h.tg.waitFor((c) => c.method === 'sendMessage' && /Olá pelo áudio!/.test(c.payload.text || ''), { from, timeout: 15_000 });
    assert.ok(urgent);
    const interrupted = h.tg.calls.slice(from).find((c) => c.method === 'sendMessage' && /Interrompido/.test(c.payload.text || ''));
    assert.ok(interrupted, 'o pedido longo deveria aparecer como interrompido');
    await h.idle();
  });

  test('se o processo do Claude morrer, avisa e a próxima mensagem funciona', async () => {
    const from = h.mark();
    h.send('#LENTO vai morrer');
    await h.tg.waitFor((c) => c.method === 'sendMessageDraft' && /Espera bastante/.test(c.payload.text || ''), { from });
    // mata o processo do Claude Code desta sessão
    const pids = execFileSync('pgrep', ['-f', 'claude-agent-sdk-linux-x64/claude']).toString().trim().split('\n');
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        /* já morreu */
      }
    }
    const err = await h.waitText(from, /Algo deu errado/, { timeout: 15_000 });
    assert.ok(h.tg.buttons(err).some((b) => b.text === '🔁 Tentar de novo'));
    await h.idle();
    const from2 = h.mark();
    h.send('#OI voltou?');
    const final = await h.waitFinal(from2, { timeout: 20_000 });
    assert.match(final.payload.text, /Olá/);
    await h.idle();
  });
});

describe('sem rascunho nativo (Telegram antigo)', () => {
  let h;
  before(async () => {
    h = await startHarness({ responder, draftSupported: false });
  });
  after(async () => h?.close());

  test('usa mensagem editada com botão Parar e depois apaga', async () => {
    const from = h.mark();
    h.send('#OI oi');
    const final = await h.waitFinal(from);
    const placeholder = h.tg.calls.slice(from).find((c) => c.method === 'sendMessage' && /Pensando…/.test(c.payload.text || ''));
    assert.ok(placeholder, 'deveria mandar "Pensando…"');
    assert.ok(h.tg.buttons(placeholder).some((b) => b.text === '🛑 Parar'));
    assert.ok(final);
    await h.tg.waitFor((c) => c.method === 'deleteMessage' && c.payload.message_id === placeholder.result.message_id, { from, timeout: 5000 });
    assert.equal(h.ctrl.prefs().streamMode, 'edit', 'deveria lembrar de usar edição');
    await h.idle();
  });
});

describe('conversa salva que sumiu', () => {
  let h;
  before(async () => {
    h = await startHarness({
      responder,
      stateFile: {
        users: {
          [USER]: {
            sessionId: '99999999-8888-7777-6666-555555555555',
            lastActivityAt: Date.now() - 60_000,
            prefs: {},
            stats: { messages: 1 },
            inflight: null,
          },
        },
      },
    });
  });
  after(async () => h?.close());

  test('começa uma conversa nova sozinho e responde o pedido (sem erro)', async () => {
    const from = h.mark();
    h.send('#OI tudo bem?');
    const final = await h.waitFinal(from, { timeout: 20_000 });
    assert.match(final.payload.text, /Olá/);
    assert.ok(!h.tg.calls.slice(from).some((c) => c.method === 'sendMessage' && /Algo deu errado|Não consegui terminar/.test(c.payload.text || '')));
    assert.notEqual(h.ctrl.session.sessionId, '99999999-8888-7777-6666-555555555555');
    assert.ok(h.ctrl.session.sessionId, 'deveria ter uma conversa nova');
    await h.idle();
  });
});

describe('reinício e conversa nova automática', () => {
  let h;
  before(async () => {
    const old = Date.now() - 10 * 3600_000;
    h = await startHarness({
      responder,
      stateFile: {
        users: {
          [USER]: {
            sessionId: '11111111-2222-3333-4444-555555555555',
            previousSessionId: null,
            lastActivityAt: old,
            prefs: {},
            stats: { messages: 3 },
            inflight: { kind: 'prompt', label: 'organiza os logs', text: '#OI organiza os logs', startedAt: old },
          },
        },
      },
    });
  });
  after(async () => h?.close());

  test('avisa que reiniciou no meio do pedido e permite tentar de novo', async () => {
    const msg = await h.waitText(0, /Fui reiniciado no meio do seu pedido/);
    assert.match(msg.payload.text, /organiza os logs/);
    const retry = h.tg.buttons(msg).find((b) => b.text === '🔁 Tentar de novo');
    const from = h.mark();
    h.tg.tap(USER, msg.result.message_id, retry.callback_data);
    const note = await h.waitText(from, /Comecei uma conversa nova/);
    assert.ok(h.tg.buttons(note).some((b) => /Voltar para a conversa anterior/.test(b.text)));
    const final = await h.waitFinal(from);
    assert.match(final.payload.text, /Olá/);
    await h.idle();
  });
});
