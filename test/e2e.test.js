// Testes de ponta a ponta: bot real + Claude Code real (binário do SDK) +
// Telegram falso + API da Anthropic falsa.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startHarness, conversationState, toolResultText, USER } from './support/harness.js';

let overloads = 0;
const seenModels = [];

function responder(body) {
  // chamadas auxiliares (títulos etc.) chegam sem ferramentas
  if (!body.tools?.length) return { blocks: [{ type: 'text', text: 'ok' }] };
  const st = conversationState(body);
  const tr = st.toolResults.map(toolResultText).join(' | ');
  seenModels.push(body.model);
  switch (st.tag) {
    case 'OI':
      return { blocks: [{ type: 'text', text: 'Olá! **Tudo certo** por aqui.' }] };
    case 'FERRAMENTA':
      if (st.step === 0)
        return { blocks: [{ type: 'text', text: 'Vou listar.' }, { type: 'tool_use', name: 'Bash', input: { command: 'sleep 1; echo ola-e2e', description: 'Lista os arquivos' } }] };
      return { blocks: [{ type: 'text', text: `Pronto: ${tr}` }] };
    case 'PERGUNTA':
      if (st.step === 0)
        return {
          blocks: [
            {
              type: 'tool_use',
              name: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    question: 'Em qual ambiente?',
                    header: 'Ambiente',
                    multiSelect: false,
                    options: [
                      { label: 'Produção', description: 'servidor principal' },
                      { label: 'Teste', description: 'cópia de testes' },
                    ],
                  },
                ],
              },
            },
          ],
        };
      return { blocks: [{ type: 'text', text: `Resposta recebida: ${tr}` }] };
    case 'PERIGO':
      if (st.step === 0)
        return { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf ./pasta-e2e', description: 'Apaga a pasta de teste' } }] };
      return { blocks: [{ type: 'text', text: `Resultado do rm: ${tr.slice(0, 120)}` }] };
    case 'LENTO':
      if (st.step === 0) return { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 30; echo fim', description: 'Espera bastante' } }] };
      return { blocks: [{ type: 'text', text: 'acabou o lento' }] };
    case 'SOBRECARGA':
      if (overloads++ < 2) return { status: 529, error: { type: 'overloaded_error', message: 'Overloaded' } };
      return { blocks: [{ type: 'text', text: 'Passou depois da sobrecarga' }] };
    case 'LOOP':
      return { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo de-novo', description: 'Repete' } }] };
    case 'ARQUIVO':
      if (st.step === 0) return { blocks: [{ type: 'tool_use', name: 'Write', input: { file_path: 'relatorio.txt', content: 'linha 1\nlinha 2\n' } }] };
      if (st.step === 1) return { blocks: [{ type: 'tool_use', name: 'mcp__telegram__enviar_arquivo', input: { caminho: 'relatorio.txt', legenda: 'Seu relatório' } }] };
      return { blocks: [{ type: 'text', text: `Enviei: ${tr.slice(-80)}` }] };
    case 'PLANO': {
      // no modo de planejamento o Claude escreve o plano num arquivo e chama ExitPlanMode
      const planPath = (JSON.stringify(body).match(/(\/[^"\\\s]*\.claude\/plans\/[^"\\\s]+\.md)/) || [])[1];
      if (st.step === 0) return { blocks: [{ type: 'tool_use', name: 'Write', input: { file_path: planPath, content: '1. Fazer **A**\n2. Fazer B\n' } }] };
      if (st.step === 1) return { blocks: [{ type: 'tool_use', name: 'ExitPlanMode', input: {} }] };
      return { blocks: [{ type: 'text', text: `Executado após o plano: ${tr.slice(-60)}` }] };
    }
    case 'IMAGEM':
      return { blocks: [{ type: 'text', text: st.hasImage ? 'Vi uma imagem.' : 'Não veio imagem.' }] };
    case 'MODELO':
      return { blocks: [{ type: 'text', text: `modelo=${body.model}` }] };
    case 'LONGO':
      return { blocks: [{ type: 'text', text: Array.from({ length: 40 }, (_, i) => `## Seção ${i}\n\n${'Texto **importante** com `código` & <símbolos>. '.repeat(8)}`).join('\n\n') }] };
    case 'CONTEXTO':
      return { blocks: [{ type: 'text', text: `pedidos_na_conversa=${st.humanCount}` }] };
    case 'ARQUIVO_RECEBIDO':
      return { blocks: [{ type: 'text', text: `Recebi: ${st.text.includes('recebidos/') ? 'caminho ok' : 'sem caminho'}` }] };
    default:
      return { blocks: [{ type: 'text', text: 'ok' }] };
  }
}

let h;
before(async () => {
  h = await startHarness({ responder });
});
after(async () => {
  await h?.close();
});

test('resposta simples: "Pensando…" nativo e depois a resposta com botões', async () => {
  const from = h.mark();
  h.send('#OI oi');
  const final = await h.waitFinal(from);
  assert.match(final.payload.text, /Olá! <b>Tudo certo<\/b> por aqui\./);
  const drafts = h.tg.calls.slice(from).filter((c) => c.method === 'sendMessageDraft');
  assert.ok(drafts.length >= 1, 'deveria usar rascunho nativo');
  assert.equal(drafts[0].payload.text, '', 'primeiro rascunho vazio = "Pensando…" do Telegram');
  assert.equal(drafts[0].payload.can_stop, true);
  const labels = h.tg.buttons(final).map((b) => b.text);
  assert.ok(labels.includes('🧠 Pensar mais'));
  await h.idle();
});

test('ferramenta: mostra a etapa ao vivo e o resumo expansível no fim', async () => {
  const from = h.mark();
  h.send('#FERRAMENTA lista os arquivos');
  const final = await h.waitFinal(from);
  assert.match(final.payload.text, /Pronto: ola-e2e/);
  assert.match(final.payload.text, /<blockquote expandable>✅ Lista os arquivos/);
  const live = h.tg.calls.slice(from).filter((c) => c.method === 'sendMessageDraft' && /Lista os arquivos/.test(c.payload.text || ''));
  assert.ok(live.length >= 1, 'a etapa deveria aparecer no rascunho');
  await h.idle();
});

test('pergunta com botões: o toque vira a resposta e o Claude continua', async () => {
  const from = h.mark();
  h.send('#PERGUNTA faz o deploy');
  const q = await h.waitText(from, /❓ <b>Ambiente<\/b>/);
  const labels = h.tg.buttons(q).map((b) => b.text);
  assert.deepEqual(labels.slice(0, 2), ['Produção', 'Teste']);
  assert.ok(labels.includes('✍️ Outra resposta'));
  assert.ok(labels.includes('🤷 Você decide'));
  const teste = h.tg.buttons(q).find((b) => b.text === 'Teste');
  h.tg.tap(USER, q.result.message_id, teste.callback_data);
  const final = await h.waitFinal(from);
  assert.match(final.payload.text, /Resposta recebida: .*Em qual ambiente\?.*=.*Teste/);
  const edited = h.tg.calls.slice(from).find((c) => c.method === 'editMessageText' && c.payload.message_id === q.result.message_id);
  assert.match(edited.payload.text, /✅ <b>Teste<\/b>/);
  await h.idle();
});

test('pergunta respondida digitando (sem tocar no botão)', async () => {
  const from = h.mark();
  h.send('#PERGUNTA de novo');
  await h.waitText(from, /❓ <b>Ambiente<\/b>/);
  h.send('no servidor de homologação');
  const final = await h.waitFinal(from);
  assert.match(final.payload.text, /homologação/);
  await h.idle();
});

test('comando perigoso pede confirmação; "Negar" bloqueia', async () => {
  fs.mkdirSync(path.join(h.cwd, 'pasta-e2e'), { recursive: true });
  const from = h.mark();
  h.send('#PERIGO apaga a pasta');
  const ask = await h.waitText(from, /Posso continuar\?/);
  assert.match(ask.payload.text, /apagar arquivos/);
  assert.match(ask.payload.text, /<pre>rm -rf \.\/pasta-e2e<\/pre>/);
  const deny = h.tg.buttons(ask).find((b) => b.text === '❌ Negar');
  assert.equal(deny.style, 'danger');
  h.tg.tap(USER, ask.result.message_id, deny.callback_data);
  const final = await h.waitFinal(from);
  assert.match(final.payload.text, /negou/);
  assert.ok(fs.existsSync(path.join(h.cwd, 'pasta-e2e')), 'a pasta não pode ter sido apagada');
  await h.idle();
});

test('comando perigoso: "Permitir" executa', async () => {
  const from = h.mark();
  h.send('#PERIGO apaga a pasta agora');
  const ask = await h.waitText(from, /Posso continuar\?/);
  const allow = h.tg.buttons(ask).find((b) => b.text === '✅ Permitir');
  assert.equal(allow.style, 'success');
  h.tg.tap(USER, ask.result.message_id, allow.callback_data);
  await h.waitFinal(from);
  assert.ok(!fs.existsSync(path.join(h.cwd, 'pasta-e2e')), 'a pasta deveria ter sido apagada');
  await h.idle();
});

test('parar no meio de um comando demorado', async () => {
  const from = h.mark();
  h.send('#LENTO roda algo demorado');
  await h.tg.waitFor((c) => c.method === 'sendMessageDraft' && /Espera bastante/.test(c.payload.text || ''), { from });
  const t0 = Date.now();
  h.send('🛑 Parar');
  const final = await h.waitFinal(from);
  assert.ok(Date.now() - t0 < 8000, 'deveria parar rápido');
  assert.match(final.payload.text, /⏹ <b>Interrompido\.<\/b>/);
  assert.ok(h.tg.buttons(final).some((b) => b.text === '▶️ Continuar'));
  await h.idle();
});

test('botão nativo de parar do rascunho também interrompe', async () => {
  const from = h.mark();
  h.send('#LENTO outro demorado');
  const d = await h.tg.waitFor((c) => c.method === 'sendMessageDraft' && /Espera bastante/.test(c.payload.text || ''), { from });
  h.tg.stopDraft(USER, d.payload.draft_id);
  const final = await h.waitFinal(from);
  assert.match(final.payload.text, /Interrompido/);
  await h.idle();
});

test('fila: segunda mensagem recebe aviso na hora e é atendida depois', async () => {
  const from = h.mark();
  h.send('#FERRAMENTA primeira');
  await h.tg.waitFor((c) => c.method === 'sendMessageDraft', { from });
  h.send('#OI segunda');
  const notice = await h.waitText(from, /Na fila<\/b> \(posição 1\)/);
  assert.ok(h.tg.buttons(notice).some((b) => /Parar o atual/.test(b.text)));
  await h.waitFinal(from);
  const second = await h.tg.waitFor((c) => c.method === 'sendMessage' && /Olá!/.test(c.payload.text || ''), { from });
  assert.ok(second);
  assert.ok(h.tg.calls.slice(from).some((c) => c.method === 'deleteMessage' && c.payload.message_id === notice.result.message_id), 'aviso de fila deveria sumir');
  await h.idle();
});

test('API sobrecarregada: mostra a nova tentativa e depois responde', async () => {
  overloads = 0;
  const from = h.mark();
  h.send('#SOBRECARGA teste');
  const retry = await h.tg.waitFor((c) => c.method === 'sendMessageDraft' && /sobrecarregada/.test(c.payload.text || ''), { from });
  assert.match(retry.payload.text, /Nova tentativa/);
  const final = await h.waitFinal(from);
  assert.match(final.payload.text, /Passou depois da sobrecarga/);
  await h.idle();
});

test('Claude manda arquivo pelo Telegram', async () => {
  const from = h.mark();
  h.send('#ARQUIVO gera e me manda o relatório');
  await h.tg.waitFor((c) => c.method === 'sendDocument', { from });
  const doc = h.tg.calls.slice(from).find((c) => c.method === 'sendDocument');
  assert.equal(doc.payload._files[0].filename, 'relatorio.txt');
  assert.equal(doc.payload.caption, 'Seu relatório');
  const final = await h.waitFinal(from);
  assert.match(final.payload.text, /Enviei/);
  await h.idle();
});

test('/plano mostra o plano com botões e só executa depois do OK', async () => {
  const from = h.mark();
  h.send('/plano #PLANO organiza o servidor');
  const plan = await h.waitText(from, /📝 <b>Plano proposto<\/b>/);
  assert.match(plan.payload.text, /Fazer <b>A<\/b>/);
  const exec = h.tg.buttons(plan).find((b) => b.text === '✅ Executar');
  h.tg.tap(USER, plan.result.message_id, exec.callback_data);
  const final = await h.waitFinal(from);
  assert.match(final.payload.text, /Executado após o plano/);
  await h.idle();
});

test('foto vai direto para o Claude como imagem', async () => {
  const jpeg = Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
    'base64',
  );
  h.tg.addFile('foto1', 'photos/f1.jpg', jpeg);
  const from = h.mark();
  h.tg.sendMessage(USER, { photo: [{ file_id: 'foto1', file_unique_id: 'u1', width: 1, height: 1, file_size: jpeg.length }], caption: '#IMAGEM o que é isso?' });
  const final = await h.waitFinal(from);
  assert.match(final.payload.text, /Vi uma imagem/);
  await h.idle();
});

test('documento sem legenda: pergunta o que fazer, e o caminho chega ao Claude', async () => {
  h.tg.addFile('doc1', 'documents/d1.csv', Buffer.from('a,b\n1,2\n'));
  const from = h.mark();
  h.tg.sendMessage(USER, { document: { file_id: 'doc1', file_unique_id: 'd1', file_name: 'vendas.csv', file_size: 8 } });
  const ask = await h.waitText(from, /Guardei <code>recebidos\/.*vendas\.csv<\/code>/);
  const files = fs.readdirSync(path.join(h.cwd, 'recebidos'));
  assert.ok(files.some((f) => f.endsWith('vendas.csv')));
  const resumir = h.tg.buttons(ask).find((b) => b.text === '📝 Resumir');
  const reqsBefore = h.api.requests.length;
  h.tg.tap(USER, ask.result.message_id, resumir.callback_data);
  await h.waitFinal(from);
  const sentToClaude = h.api.requests.slice(reqsBefore).map((r) => JSON.stringify(r.body.messages || [])).join(' ');
  assert.match(sentToClaude, /Faça um resumo curto deste arquivo/);
  assert.match(sentToClaude, /recebidos\/[^"]*vendas\.csv/);
  await h.idle();
});

test('painel: trocar o modelo vale na hora para a próxima mensagem', async () => {
  const from = h.mark();
  h.send('⚙️ Painel');
  const panel = await h.waitText(from, /⚙️ <b>Painel<\/b>/);
  const modelBtn = h.tg.buttons(panel).find((b) => b.text === '🧠 Modelo');
  h.tg.tap(USER, panel.result.message_id, modelBtn.callback_data);
  await h.tg.waitFor((c) => c.method === 'editMessageText' && /🧠 <b>Modelo<\/b>/.test(c.payload.text), { from });
  h.tg.tap(USER, panel.result.message_id, 's:model:opus');
  await h.tg.waitFor((c) => c.method === 'answerCallbackQuery' && /Opus/.test(c.payload.text || ''), { from });
  const f2 = h.mark();
  h.send('#MODELO qual modelo?');
  const final = await h.waitFinal(f2);
  assert.match(final.payload.text, /modelo=.*opus/i);
  h.tg.tap(USER, panel.result.message_id, 's:model:sonnet');
  await h.tg.waitFor((c) => c.method === 'answerCallbackQuery' && /Sonnet/.test(c.payload.text || ''), { from: f2 });
  await h.idle();
});

test('nova conversa zera o contexto e oferece voltar', async () => {
  let from = h.mark();
  h.send('#CONTEXTO um');
  let final = await h.waitFinal(from);
  const before = Number(final.payload.text.match(/pedidos_na_conversa=(\d+)/)[1]);
  assert.ok(before >= 1);
  await h.idle();
  from = h.mark();
  h.send('🆕 Nova conversa');
  const note = await h.waitText(from, /Conversa nova/);
  assert.ok(h.tg.buttons(note).some((b) => /Voltar para a conversa anterior/.test(b.text)));
  from = h.mark();
  h.send('#CONTEXTO dois');
  final = await h.waitFinal(from);
  assert.match(final.payload.text, /pedidos_na_conversa=1\b/);
  await h.idle();
});

test('resposta longa é dividida em várias mensagens válidas', async () => {
  const from = h.mark();
  h.send('#LONGO escreve muito');
  await h.waitFinal(from);
  const msgs = h.tg.calls.slice(from).filter((c) => c.method === 'sendMessage');
  assert.ok(msgs.length >= 2, `esperava várias mensagens, veio ${msgs.length}`);
  assert.ok(msgs.every((m) => !m.payload._error), 'nenhuma parte pode ser recusada pelo Telegram');
  await h.idle();
});

test('usuário fora da lista é recusado', async () => {
  const from = h.mark();
  h.tg.sendText(777, 'oi');
  const r = await h.tg.waitFor((c) => c.method === 'sendMessage' && c.payload.chat_id === 777, { from });
  assert.match(r.payload.text, /privado/);
});

test('mensagem de tipo desconhecido recebe resposta (nunca fica no vácuo)', async () => {
  const from = h.mark();
  h.tg.sendMessage(USER, { location: { latitude: 1, longitude: 2 } });
  const r = await h.waitText(from, /Ainda não sei lidar/);
  assert.ok(r);
});
