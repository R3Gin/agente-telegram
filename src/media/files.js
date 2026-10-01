// Baixa arquivos do Telegram (fotos, documentos, áudios).
import fs from 'node:fs';
import path from 'node:path';

const MAX_DOWNLOAD = 20 * 1024 * 1024; // limite da Bot API para download

export async function downloadTelegramFile(api, token, fileId, { apiRoot = 'https://api.telegram.org', timeoutMs = 90_000 } = {}) {
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error('o Telegram não devolveu o caminho do arquivo');
  if (file.file_size && file.file_size > MAX_DOWNLOAD) throw new Error('arquivo maior que 20 MB (limite do Telegram para bots)');
  const url = `${apiRoot.replace(/\/$/, '')}/file/bot${token}/${file.file_path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`download falhou (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, filePath: file.file_path, size: buf.length };
}

export function safeFileName(name, fallback = 'arquivo') {
  const base = path.basename(String(name || fallback)).normalize('NFKC');
  const clean = base.replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  return clean || fallback;
}

/** Guarda um arquivo recebido em <cwd>/recebidos/ sem sobrescrever nada. */
export function saveIncoming(cwd, name, buffer) {
  const dir = path.join(cwd, 'recebidos');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(dir, `${stamp}-${safeFileName(name)}`);
  fs.writeFileSync(file, buffer);
  return file;
}

export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
