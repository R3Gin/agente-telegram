// Traduz cada ferramenta que o Claude usa para uma linha curta em português,
// do tipo "📖 Lendo bot.js" ou "💻 Rodando npm test".
import path from 'node:path';

function base(p) {
  if (!p) return '';
  const s = String(p);
  return path.basename(s) || s;
}

function short(s, n = 60) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return short(url, 40);
  }
}

/** @returns {{icon: string, text: string}} */
export function describeTool(name, input = {}) {
  const i = input || {};
  switch (name) {
    case 'Read':
      return { icon: '📖', text: `Lendo ${base(i.file_path) || 'arquivo'}` };
    case 'Write':
      return { icon: '📝', text: `Criando ${base(i.file_path) || 'arquivo'}` };
    case 'Edit':
    case 'MultiEdit':
      return { icon: '✏️', text: `Editando ${base(i.file_path) || 'arquivo'}` };
    case 'NotebookEdit':
      return { icon: '✏️', text: `Editando ${base(i.notebook_path) || 'notebook'}` };
    case 'Glob':
      return { icon: '🗂', text: i.pattern ? `Listando ${short(i.pattern, 40)}` : 'Listando arquivos' };
    case 'Grep':
      return { icon: '🔎', text: i.pattern ? `Procurando "${short(i.pattern, 40)}"${i.path ? ` em ${base(i.path)}` : ''}` : 'Procurando nos arquivos' };
    case 'LS':
      return { icon: '🗂', text: `Listando ${base(i.path) || 'pasta'}` };
    case 'Bash':
      if (i.description) return { icon: '💻', text: short(i.description, 70) };
      return { icon: '💻', text: i.command ? `Rodando ${short(i.command, 60)}` : 'Preparando um comando' };
    case 'BashOutput':
    case 'TaskOutput':
      return { icon: '💻', text: 'Lendo saída de um comando' };
    case 'KillShell':
    case 'TaskStop':
      return { icon: '🛑', text: 'Parando um comando em segundo plano' };
    case 'WebSearch':
      return { icon: '🌐', text: i.query ? `Pesquisando "${short(i.query, 50)}"` : 'Pesquisando na web' };
    case 'WebFetch':
      return { icon: '🌐', text: i.url ? `Abrindo ${host(i.url)}` : 'Abrindo uma página' };
    case 'Agent':
    case 'Task':
      return { icon: '🤖', text: `Subagente: ${short(i.description || i.subagent_type || 'tarefa', 50)}` };
    case 'TodoWrite': {
      const doing = (i.todos || []).find((t) => t.status === 'in_progress');
      return { icon: '📋', text: doing ? short(doing.activeForm || doing.content, 60) : 'Organizando as etapas' };
    }
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
      return { icon: '📋', text: 'Organizando as etapas' };
    case 'Skill':
      return { icon: '🧩', text: `Usando a habilidade ${short(i.skill || i.name || '', 30)}` };
    case 'ToolSearch':
      return { icon: '🧰', text: 'Carregando ferramentas' };
    case 'AskUserQuestion':
      return { icon: '❓', text: 'Te fazendo uma pergunta' };
    case 'ExitPlanMode':
      return { icon: '📝', text: 'Plano pronto para você aprovar' };
    case 'EnterPlanMode':
      return { icon: '📝', text: 'Entrando em modo de planejamento' };
    case 'mcp__telegram__enviar_arquivo':
      return { icon: '📎', text: `Enviando ${base(i.caminho) || 'arquivo'}` };
    default:
      if (name?.startsWith('mcp__')) {
        const [, server, ...rest] = name.split('__');
        return { icon: '🔌', text: `${server}: ${short(rest.join('__').replace(/[-_]/g, ' '), 40)}` };
      }
      return { icon: '🔧', text: short(name || 'ferramenta', 40) };
  }
}

/** Resumo curto do resultado de uma ferramenta (opcional, quando ajuda). */
export function describeResult(name, toolUseResult) {
  const r = toolUseResult;
  if (!r || typeof r !== 'object') return '';
  if (name === 'Grep') {
    if (typeof r.numFiles === 'number' && r.mode === 'files_with_matches') return `${r.numFiles} arquivo(s)`;
    if (typeof r.numMatches === 'number') return `${r.numMatches} ocorrência(s)`;
    if (typeof r.numLines === 'number') return `${r.numLines} linha(s)`;
    if (typeof r.numFiles === 'number') return `${r.numFiles} arquivo(s)`;
  }
  if (name === 'Glob' && typeof r.numFiles === 'number') return `${r.numFiles} arquivo(s)`;
  if (name === 'Bash' && r.interrupted) return 'interrompido';
  return '';
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m${String(r).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const MODEL_LABELS = {
  haiku: 'Haiku',
  sonnet: 'Sonnet',
  opus: 'Opus',
  fable: 'Fable',
};

export const EFFORT_LABELS = {
  low: 'Baixo',
  medium: 'Médio',
  high: 'Alto',
  xhigh: 'Muito alto',
  max: 'Máximo',
};

export function modelLabel(id) {
  if (!id) return '';
  if (MODEL_LABELS[id]) return MODEL_LABELS[id];
  const m = String(id).match(/(haiku|sonnet|opus|fable|mythos)/i);
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : id;
}
