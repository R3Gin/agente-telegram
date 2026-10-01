// Botões e teclados. As cores (style) existem no Telegram desde a Bot API 9.4:
// "success" = verde, "danger" = vermelho, "primary" = azul.

export const REPLY = {
  stop: '🛑 Parar',
  newChat: '🆕 Nova conversa',
  panel: '⚙️ Painel',
};

export function btn(text, data, style) {
  const b = { text: truncateLabel(text), callback_data: data };
  if (style) b.style = style;
  return b;
}

export function copyBtn(text, value) {
  return { text, copy_text: { text: String(value).slice(0, 256) } };
}

export function inline(rows) {
  return { inline_keyboard: rows.filter((r) => r && r.length) };
}

export function truncateLabel(s, max = 48) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Teclado fixo embaixo da conversa: parar, conversa nova e painel sempre à mão. */
export function replyKeyboard() {
  return {
    keyboard: [[{ text: REPLY.stop, style: 'danger' }, { text: REPLY.newChat }, { text: REPLY.panel }]],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: 'Escreva, mande áudio, foto ou arquivo…',
  };
}

export function isReplyButton(text) {
  return Object.values(REPLY).includes(String(text ?? '').trim());
}
