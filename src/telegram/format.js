// Converte o Markdown que o Claude escreve para o HTML aceito pelo Telegram e
// divide respostas longas em mensagens de até ~3800 caracteres, sem deixar
// tags abertas.
import { marked } from 'marked';

export const TELEGRAM_LIMIT = 4096;
const CHUNK_LIMIT = 3800;
const TABLE_MAX_WIDTH = 42;

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function plainInline(tokens) {
  let out = '';
  for (const t of tokens || []) {
    if (t.tokens) out += plainInline(t.tokens);
    else if (t.type === 'br') out += '\n';
    else if (t.type === 'checkbox') out += t.checked ? '☑ ' : '☐ ';
    else out += t.text ?? '';
  }
  return out;
}

function inline(tokens) {
  let out = '';
  for (const t of tokens || []) {
    switch (t.type) {
      case 'text':
        out += t.tokens ? inline(t.tokens) : escapeHtml(t.text);
        break;
      case 'escape':
        out += escapeHtml(t.text);
        break;
      case 'strong':
        out += `<b>${inline(t.tokens)}</b>`;
        break;
      case 'em':
        out += `<i>${inline(t.tokens)}</i>`;
        break;
      case 'del':
        out += `<s>${inline(t.tokens)}</s>`;
        break;
      case 'codespan':
        out += `<code>${escapeHtml(t.text)}</code>`;
        break;
      case 'br':
        out += '\n';
        break;
      case 'link': {
        const label = inline(t.tokens) || escapeHtml(t.href);
        if (/^(https?:|tg:|mailto:)/i.test(t.href || '')) out += `<a href="${escapeAttr(t.href)}">${label}</a>`;
        else out += label;
        break;
      }
      case 'image':
        out += `🖼 ${escapeHtml(t.text || 'imagem')}${t.href ? ` (${escapeHtml(t.href)})` : ''}`;
        break;
      case 'checkbox':
        out += t.checked ? '☑️ ' : '⬜ ';
        break;
      case 'html':
      case 'tag':
        out += escapeHtml(t.text ?? t.raw ?? '');
        break;
      default:
        out += escapeHtml(t.text ?? t.raw ?? '');
    }
  }
  return out;
}

function renderCode(text, lang) {
  const body = escapeHtml(text);
  const safeLang = String(lang || '').trim().split(/\s+/)[0].replace(/[^\w+#.-]/g, '');
  return safeLang ? `<pre><code class="language-${safeLang}">${body}</code></pre>` : `<pre>${body}</pre>`;
}

function cellText(cell) {
  return plainInline(cell.tokens).replace(/\s+/g, ' ').trim();
}

function renderTable(t) {
  const header = t.header.map(cellText);
  const rows = t.rows.map((r) => r.map(cellText));
  const cols = header.length;
  const widths = header.map((h, i) => Math.min(24, Math.max(h.length, ...rows.map((r) => (r[i] || '').length))));
  const total = widths.reduce((a, b) => a + b, 0) + (cols - 1) * 3;
  if (total <= TABLE_MAX_WIDTH) {
    const cut = (s, w) => (s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w));
    const line = (cells) => cells.map((c, i) => cut(c || '', widths[i])).join(' │ ').trimEnd();
    const sep = widths.map((w) => '─'.repeat(w)).join('─┼─');
    return `<pre>${escapeHtml([line(header), sep, ...rows.map(line)].join('\n'))}</pre>`;
  }
  // tabela larga demais para o celular: vira uma lista de "cartões"
  return rows
    .map((r) => {
      const [first, ...rest] = r;
      const head = `▫️ <b>${escapeHtml(header[0])}:</b> ${escapeHtml(first || '')}`;
      const others = rest.map((v, i) => `   ${escapeHtml(header[i + 1])}: ${escapeHtml(v || '')}`);
      return [head, ...others].join('\n');
    })
    .join('\n');
}

function renderList(list, depth = 0) {
  const lines = [];
  let n = Number(list.start) || 1;
  const indent = '   '.repeat(depth);
  for (const item of list.items) {
    const bullet = list.ordered ? `${n++}.` : depth === 0 ? '•' : '◦';
    const parts = [];
    const sub = [];
    for (const tok of item.tokens || []) {
      if (tok.type === 'list') sub.push(renderList(tok, depth + 1));
      else if (tok.type === 'checkbox') parts.push(tok.checked ? '☑️' : '⬜');
      else if (tok.type === 'text' || tok.type === 'paragraph') parts.push(tok.tokens ? inline(tok.tokens) : escapeHtml(tok.text));
      else if (tok.type === 'code') sub.push(renderCode(tok.text, tok.lang));
      else if (tok.type === 'space') continue;
      else parts.push(renderBlock(tok, depth + 1));
    }
    lines.push(`${indent}${bullet} ${parts.join(' ').trim()}`);
    for (const s of sub) lines.push(s);
  }
  return lines.join('\n');
}

function renderBlock(t, depth = 0) {
  switch (t.type) {
    case 'heading':
      return `<b>${inline(t.tokens)}</b>`;
    case 'paragraph':
      return inline(t.tokens);
    case 'text':
      return t.tokens ? inline(t.tokens) : escapeHtml(t.text);
    case 'code':
      return renderCode(t.text, t.lang);
    case 'blockquote': {
      // o Telegram não aceita citação dentro de citação nem bloco <pre> dentro dela
      const inner = (t.tokens || [])
        .filter((x) => x.type !== 'space')
        .map((x) => {
          if (x.type === 'blockquote') return plainBlockquote(x);
          if (x.type === 'code') return `<code>${escapeHtml(x.text)}</code>`;
          if (x.type === 'table') return escapeHtml(x.raw ?? '');
          return renderBlock(x, depth);
        })
        .join('\n');
      return `<blockquote>${inner}</blockquote>`;
    }
    case 'list':
      return renderList(t, depth);
    case 'table':
      return renderTable(t);
    case 'hr':
      return '──────────';
    case 'html':
      return escapeHtml(t.text ?? t.raw ?? '').trim();
    case 'space':
    case 'def':
      return '';
    default:
      return escapeHtml(t.raw ?? t.text ?? '');
  }
}

function plainBlockquote(t) {
  return escapeHtml(t.text || '');
}

function lex(md) {
  return marked.lexer(String(md ?? ''), { gfm: true });
}

/** Renderiza o Markdown em blocos HTML independentes (cada um com tags fechadas). */
export function renderBlocks(md) {
  const blocks = [];
  for (const t of lex(md)) {
    const html = renderBlock(t);
    if (html && html.trim()) blocks.push({ html, token: t });
  }
  return blocks;
}

export function markdownToHtml(md) {
  return renderBlocks(md)
    .map((b) => b.html)
    .join('\n\n');
}

function splitPlain(text, limit) {
  const out = [];
  let rest = String(text);
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[\n ]/, '');
  }
  if (rest.length) out.push(rest);
  return out;
}

function splitOversized(block, limit) {
  const t = block.token;
  if (t.type === 'code') {
    const pieces = splitPlain(t.text, limit - 80);
    return pieces.map((p) => renderCode(p, t.lang));
  }
  // bloco gigante que não é código: perde a formatação, mas não some
  const raw = t.raw ?? t.text ?? '';
  return splitPlain(raw, limit - 50).map((p) => escapeHtml(p));
}

/** Divide a resposta em mensagens HTML prontas para o Telegram. */
export function formatForTelegram(md, { limit = CHUNK_LIMIT } = {}) {
  const blocks = renderBlocks(md);
  const chunks = [];
  let current = '';
  const push = (html) => {
    if (!current) current = html;
    else if (current.length + 2 + html.length <= limit) current += '\n\n' + html;
    else {
      chunks.push(current);
      current = html;
    }
  };
  for (const b of blocks) {
    if (b.html.length > limit) {
      for (const piece of splitOversized(b, limit)) push(piece);
    } else push(b.html);
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [''];
}

/** Texto puro para quando o Telegram recusa o HTML. */
export function plainChunks(text, limit = 4000) {
  return splitPlain(String(text ?? ''), limit);
}

/** Remove as tags para medir/mostrar a versão em texto puro de um HTML nosso. */
export function htmlToPlain(html) {
  return String(html)
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * Prévia do texto em andamento para o rascunho ao vivo: mostra o final do
 * texto (o que está sendo escrito agora) e fecha blocos de código abertos.
 */
export function renderPreview(md, { maxChars = 2800 } = {}) {
  let text = String(md ?? '');
  let truncated = false;
  if (text.length > maxChars) {
    let start = text.length - maxChars;
    const nl = text.indexOf('\n', start);
    if (nl !== -1 && nl - start < 200) start = nl + 1;
    const before = text.slice(0, start);
    text = text.slice(start);
    truncated = true;
    const fences = (before.match(/^\s*```/gm) || []).length;
    if (fences % 2 === 1) text = '```\n' + text;
  }
  let html;
  try {
    html = markdownToHtml(text);
  } catch {
    html = escapeHtml(text);
  }
  if (html.length > TELEGRAM_LIMIT - 400) html = escapeHtml(text.slice(-(maxChars - 400)));
  return (truncated ? '…\n' : '') + html;
}

/** Primeiro bloco de código curto da resposta (para o botão "copiar"). */
export function singleShortCommand(md, max = 256) {
  const codes = lex(md).filter((t) => t.type === 'code');
  if (codes.length !== 1) return null;
  const text = codes[0].text.trim();
  if (!text || text.length > max) return null;
  return text;
}
