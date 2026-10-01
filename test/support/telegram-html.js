// Validador do HTML no estilo do Telegram (o mesmo tipo de regra que faz a
// API devolver "can't parse entities"). Usado pelos testes e pelo Telegram falso.
const ALLOWED = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'a', 'code', 'pre', 'blockquote', 'tg-spoiler', 'span', 'tg-emoji']);
const NAMED_ENTITIES = new Set(['lt', 'gt', 'amp', 'quot']);

/** @returns {string|null} mensagem de erro ou null se estiver ok */
export function validateTelegramHtml(html) {
  const s = String(html);
  const stack = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '<') {
      const end = s.indexOf('>', i);
      if (end === -1) return `can't parse entities: unclosed start tag at byte offset ${i}`;
      const raw = s.slice(i + 1, end);
      const closing = raw.startsWith('/');
      const name = (closing ? raw.slice(1) : raw).trim().split(/\s+/)[0].toLowerCase();
      if (!name || !/^[a-z-]+$/.test(name)) return `can't parse entities: unsupported start tag "${raw}" at byte offset ${i}`;
      if (!ALLOWED.has(name)) return `can't parse entities: unsupported start tag "${name}" at byte offset ${i}`;
      if (closing) {
        const top = stack.pop();
        if (top !== name) return `can't parse entities: unmatched end tag at byte offset ${i}, expected "</${top}>", found "</${name}>"`;
      } else {
        if (name === 'blockquote' && stack.includes('blockquote')) return "can't parse entities: nested blockquote";
        if (name === 'pre' && stack.includes('blockquote')) return "can't parse entities: pre inside blockquote";
        stack.push(name);
      }
      i = end + 1;
      continue;
    }
    if (c === '&') {
      const m = s.slice(i).match(/^&(#\d+|#x[0-9a-f]+|[a-z]+);/i);
      if (!m) return `can't parse entities: character '&' at byte offset ${i}`;
      if (!m[1].startsWith('#') && !NAMED_ENTITIES.has(m[1])) return `can't parse entities: unsupported entity &${m[1]};`;
      i += m[0].length;
      continue;
    }
    if (c === '>') return `can't parse entities: character '>' at byte offset ${i}`;
    i++;
  }
  if (stack.length) return `can't parse entities: unclosed tag "${stack[stack.length - 1]}"`;
  return null;
}

export function visibleLength(html) {
  return String(html)
    .replace(/<[^>]+>/g, '')
    .replace(/&(lt|gt|amp|quot);/g, 'x')
    .replace(/&#x?[0-9a-f]+;/gi, 'x').length;
}
