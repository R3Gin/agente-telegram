import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml, formatForTelegram, renderPreview, singleShortCommand, escapeHtml, htmlToPlain } from '../src/telegram/format.js';
import { validateTelegramHtml } from './support/telegram-html.js';

test('negrito, itálico, código e link viram HTML do Telegram', () => {
  const html = markdownToHtml('Texto **forte** e *leve* com `x < y` e [site](https://exemplo.com) ~~velho~~');
  assert.equal(html, 'Texto <b>forte</b> e <i>leve</i> com <code>x &lt; y</code> e <a href="https://exemplo.com">site</a> <s>velho</s>');
  assert.equal(validateTelegramHtml(html), null);
});

test('escapa <, > e & em texto comum', () => {
  const html = markdownToHtml('a < b && c > d');
  assert.equal(html, 'a &lt; b &amp;&amp; c &gt; d');
});

test('títulos viram negrito e listas viram marcadores', () => {
  const html = markdownToHtml('# Título\n\n- um\n- **dois**\n  - sub\n\n1. a\n2. b');
  assert.match(html, /^<b>Título<\/b>/);
  assert.match(html, /• um\n• <b>dois<\/b>\n {3}◦ sub/);
  assert.match(html, /1\. a\n2\. b/);
  assert.equal(validateTelegramHtml(html), null);
});

test('bloco de código com linguagem', () => {
  const html = markdownToHtml('```bash\necho "oi" > /tmp/x && ls\n```');
  assert.equal(html, '<pre><code class="language-bash">echo "oi" &gt; /tmp/x &amp;&amp; ls</code></pre>');
});

test('tabela estreita vira bloco monoespaçado; larga vira cartões', () => {
  const narrow = markdownToHtml('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.match(narrow, /^<pre>a │ b\n─+┼─+\n1 │ 2<\/pre>$/);
  const wide = markdownToHtml('| Serviço | Status atual do container | Porta |\n|---|---|---|\n| nginx-proxy-principal | rodando há 3 dias sem parar | 443 |');
  assert.match(wide, /▫️ <b>Serviço:<\/b> nginx-proxy-principal/);
  assert.equal(validateTelegramHtml(wide), null);
});

test('citação com código dentro continua válida', () => {
  const html = markdownToHtml('> veja:\n>\n> ```\n> x < 1\n> ```');
  assert.equal(validateTelegramHtml(html), null);
  assert.match(html, /^<blockquote>/);
});

test('resposta longa é dividida em partes válidas e sem perder texto', () => {
  const para = 'Linha com **negrito** e `codigo` & símbolos <tag>. '.repeat(40);
  const md = Array.from({ length: 12 }, (_, i) => `## Parte ${i}\n\n${para}\n\n\`\`\`js\n${'console.log(1 < 2);\n'.repeat(30)}\`\`\``).join('\n\n');
  const chunks = formatForTelegram(md);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 3800, `parte com ${c.length} caracteres`);
    assert.equal(validateTelegramHtml(c), null);
  }
  const plain = chunks.map(htmlToPlain).join('\n');
  for (let i = 0; i < 12; i++) assert.ok(plain.includes(`Parte ${i}`));
});

test('bloco de código gigante é quebrado em vários blocos', () => {
  const code = Array.from({ length: 600 }, (_, i) => `linha ${i} <x>`).join('\n');
  const chunks = formatForTelegram('```\n' + code + '\n```');
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.match(c, /^<pre>[\s\S]*<\/pre>$/);
    assert.equal(validateTelegramHtml(c), null);
  }
  assert.ok(chunks.map(htmlToPlain).join('\n').includes('linha 599 <x>'));
});

test('prévia ao vivo fecha bloco de código aberto e mostra o fim do texto', () => {
  const md = 'Intro\n\n```js\n' + 'let a = 1;\n'.repeat(500);
  const html = renderPreview(md, { maxChars: 800 });
  assert.ok(html.startsWith('…\n'));
  assert.equal(validateTelegramHtml(html.slice(2)), null);
  assert.ok(html.length < 4096);
});

test('botão copiar só aparece com um único comando curto', () => {
  assert.equal(singleShortCommand('Rode:\n\n```bash\nsystemctl restart nginx\n```'), 'systemctl restart nginx');
  assert.equal(singleShortCommand('```\na\n```\n\n```\nb\n```'), null);
  assert.equal(singleShortCommand('sem código'), null);
});

test('escapeHtml básico', () => {
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href="x"&gt;&amp;&lt;/a&gt;');
});
