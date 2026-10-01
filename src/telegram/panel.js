// Painel de controle (/menu ou botão "⚙️ Painel"): tudo por botões, editando
// a mesma mensagem.
import { btn, inline } from './keyboards.js';
import { escapeHtml } from './format.js';
import { MODEL_LABELS, EFFORT_LABELS, formatDuration } from '../engine/activity.js';
import { CHOICES } from '../config.js';

const CONFIRM_LABELS = {
  risky: 'só ações perigosas',
  writes: 'tudo que altera o servidor',
  off: 'nunca perguntar',
};

const MODEL_HINTS = {
  haiku: 'o mais rápido, para coisas simples',
  sonnet: 'rápido e capaz (recomendado)',
  opus: 'o mais caprichado, mais lento',
  fable: 'o mais forte (precisa de acesso)',
};

const EFFORT_HINTS = {
  low: 'responde mais rápido',
  medium: 'equilíbrio',
  high: 'pensa bem antes',
  xhigh: 'pensa bastante',
  max: 'o máximo de raciocínio',
};

function autoLabel(h) {
  return h > 0 ? `após ${h}h parado` : 'desligada';
}

function check(on) {
  return on ? '✅ ' : '';
}

export async function panelView(ctrl, page = 'main') {
  const p = ctrl.prefs();
  const u = ctrl.store.user(ctrl.userId);
  switch (page) {
    case 'model':
      return {
        html: `🧠 <b>Modelo</b>\n\n${CHOICES.MODELS.map((m) => `• <b>${MODEL_LABELS[m]}</b> — ${MODEL_HINTS[m]}`).join('\n')}`,
        markup: inline([
          CHOICES.MODELS.slice(0, 2).map((m) => btn(`${check(p.model === m)}${MODEL_LABELS[m]}`, `s:model:${m}`)),
          CHOICES.MODELS.slice(2).map((m) => btn(`${check(p.model === m)}${MODEL_LABELS[m]}`, `s:model:${m}`)),
          [btn('⬅️ Voltar', 'm:main')],
        ]),
      };
    case 'effort':
      return {
        html: `🎚 <b>Esforço</b> — quanto ele pensa antes de responder\n\n${CHOICES.EFFORTS.map((e) => `• <b>${EFFORT_LABELS[e]}</b> — ${EFFORT_HINTS[e]}`).join('\n')}`,
        markup: inline([
          CHOICES.EFFORTS.slice(0, 3).map((e) => btn(`${check(p.effort === e)}${EFFORT_LABELS[e]}`, `s:effort:${e}`)),
          CHOICES.EFFORTS.slice(3).map((e) => btn(`${check(p.effort === e)}${EFFORT_LABELS[e]}`, `s:effort:${e}`)),
          [btn('⬅️ Voltar', 'm:main')],
        ]),
      };
    case 'confirm':
      return {
        html:
          '🛡 <b>Quando pedir sua confirmação</b>\n\n' +
          '• <b>Só ações perigosas</b> — apagar arquivos, parar/reiniciar serviços, derrubar containers, git push, firewall.\n' +
          '• <b>Tudo que altera</b> — qualquer comando que mude algo e qualquer edição de arquivo.\n' +
          '• <b>Nunca</b> — faz tudo sozinho (cuidado: ele roda como root).',
        markup: inline([
          [btn(`${check(p.confirm === 'risky')}🛡 Só perigosas`, 's:confirm:risky')],
          [btn(`${check(p.confirm === 'writes')}🔒 Tudo que altera`, 's:confirm:writes')],
          [btn(`${check(p.confirm === 'off')}🔓 Nunca`, 's:confirm:off', p.confirm === 'off' ? undefined : 'danger')],
          [btn('⬅️ Voltar', 'm:main')],
        ]),
      };
    case 'auto':
      return {
        html: '🆕 <b>Conversa nova automática</b>\n\nDepois de um tempo parado, o próximo pedido começa uma conversa do zero. Conversas curtas respondem mais rápido. Sempre aparece um botão para voltar à anterior.',
        markup: inline([
          [2, 6, 12, 24].map((h) => btn(`${check(p.autoNewHours === h)}${h}h`, `s:auto:${h}`)),
          [btn(`${check(!p.autoNewHours)}Desligada`, 's:auto:0')],
          [btn('⬅️ Voltar', 'm:main')],
        ]),
      };
    case 'status': {
      const ctx = await ctrl.session.contextUsage();
      const s = ctrl.session;
      const lines = [
        '📊 <b>Status</b>',
        '',
        `🔌 Sessão do Claude: ${s.alive ? (s.busy ? '🟡 trabalhando' : '🟢 pronta') : '⚪ fechada (abre na próxima mensagem)'}`,
        s.sessionId ? `🆔 Conversa: <code>${escapeHtml(s.sessionId.slice(0, 8))}</code>` : '🆔 Conversa: nova',
        ctx ? `📚 Contexto usado: ${Math.round(ctx.percentage)}% (${Math.round(ctx.totalTokens / 1000)}k de ${Math.round(ctx.maxTokens / 1000)}k tokens)` : '',
        `💬 Pedidos atendidos: ${u.stats?.messages || 0}`,
        u.stats?.lastDurationMs ? `⏱ Último: ${formatDuration(u.stats.lastDurationMs)} · ${u.stats.lastSteps || 0} etapa(s)` : '',
        `📥 Na fila: ${ctrl.jobs.length}`,
        `🖥 Pasta de trabalho: <code>${escapeHtml(ctrl.config.cwd)}</code>`,
      ].filter((l) => l !== '');
      if (ctx && ctx.percentage >= 60) lines.push('', '💡 A conversa está grande: uma conversa nova deixa as respostas mais rápidas.');
      return {
        html: lines.join('\n'),
        markup: inline([
          [btn('🔄 Atualizar', 'm:status'), btn('🆕 Nova conversa', 't:new')],
          [btn('⬅️ Voltar', 'm:main')],
        ]),
      };
    }
    default: {
      const lines = [
        '⚙️ <b>Painel</b>',
        '',
        `🧠 Modelo: <b>${MODEL_LABELS[p.model] || escapeHtml(p.model)}</b> · 🎚 Esforço: <b>${EFFORT_LABELS[p.effort] || escapeHtml(p.effort)}</b>`,
        `🛡 Confirmações: <b>${CONFIRM_LABELS[p.confirm] || p.confirm}</b>`,
        `🆕 Conversa nova automática: <b>${autoLabel(p.autoNewHours)}</b>`,
        `📺 Ao vivo: <b>${p.streamMode === 'edit' ? 'editando mensagem' : 'rascunho nativo'}</b> · 💭 Raciocínio: <b>${p.showThinking ? 'visível' : 'oculto'}</b>`,
        `💬 Pedidos: <b>${u.stats?.messages || 0}</b>${u.stats?.lastDurationMs ? ` · último em <b>${formatDuration(u.stats.lastDurationMs)}</b>` : ''}`,
      ];
      const rows = [
        [btn('🧠 Modelo', 'm:model'), btn('🎚 Esforço', 'm:effort')],
        [btn('🛡 Confirmações', 'm:confirm'), btn('🆕 Automática', 'm:auto')],
        [btn(`📺 ${p.streamMode === 'edit' ? 'Edição' : 'Nativo'}`, 't:stream'), btn(`💭 Raciocínio: ${p.showThinking ? 'on' : 'off'}`, 't:thinking')],
        [btn('🆕 Nova conversa', 't:new'), ...(u.previousSessionId ? [btn('↩️ Anterior', 't:prev')] : [])],
        [btn('📊 Status', 'm:status'), btn('♻️ Reiniciar sessão', 't:restart')],
        [btn('✖️ Fechar', 'm:close')],
      ];
      return { html: lines.join('\n'), markup: inline(rows) };
    }
  }
}

async function rerender(ctrl, ctx, page) {
  const msg = ctx?.callbackQuery?.message;
  if (!msg) return ctrl.showPanel(page);
  const { html, markup } = await panelView(ctrl, page);
  await ctrl.sender.edit(ctrl.chatId, msg.message_id, html, { reply_markup: markup });
}

export async function handlePanelCallback(ctrl, data, ctx) {
  const [kind, a, b] = String(data).split(':');
  if (kind === 'm') {
    if (a === 'close') {
      const msg = ctx?.callbackQuery?.message;
      if (msg) await ctrl.sender.del(ctrl.chatId, msg.message_id);
      return undefined;
    }
    await rerender(ctrl, ctx, a);
    return undefined;
  }
  if (kind === 's') {
    if (a === 'model' && CHOICES.MODELS.includes(b)) {
      ctrl.store.setPref(ctrl.userId, 'model', b);
      await ctrl.session.setModel(b);
      await rerender(ctrl, ctx, 'main');
      return `Modelo: ${MODEL_LABELS[b]}`;
    }
    if (a === 'effort' && CHOICES.EFFORTS.includes(b)) {
      ctrl.store.setPref(ctrl.userId, 'effort', b);
      await ctrl.session.setEffort(b);
      await rerender(ctrl, ctx, 'main');
      return `Esforço: ${EFFORT_LABELS[b]}`;
    }
    if (a === 'confirm' && CHOICES.CONFIRM_MODES.includes(b)) {
      ctrl.store.setPref(ctrl.userId, 'confirm', b);
      await rerender(ctrl, ctx, 'main');
      return `Confirmações: ${CONFIRM_LABELS[b]}`;
    }
    if (a === 'auto') {
      const h = Math.max(0, Number(b) || 0);
      ctrl.store.setPref(ctrl.userId, 'autoNewHours', h);
      await rerender(ctrl, ctx, 'main');
      return `Conversa nova automática: ${autoLabel(h)}`;
    }
    return undefined;
  }
  if (kind === 't') {
    const p = ctrl.prefs();
    if (a === 'stream') {
      ctrl.store.setPref(ctrl.userId, 'streamMode', p.streamMode === 'edit' ? 'draft' : 'edit');
      await rerender(ctrl, ctx, 'main');
      return undefined;
    }
    if (a === 'thinking') {
      ctrl.store.setPref(ctrl.userId, 'showThinking', !p.showThinking);
      await rerender(ctrl, ctx, 'main');
      return undefined;
    }
    if (a === 'new') {
      await ctrl.newConversation();
      return 'Conversa nova';
    }
    if (a === 'prev') return (await ctrl.resumePrevious()) || 'Voltei para a anterior';
    if (a === 'restart') {
      await ctrl.restartSession();
      return 'Sessão reiniciada';
    }
  }
  return undefined;
}
