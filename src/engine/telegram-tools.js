// Ferramentas que o próprio bot oferece ao Claude (servidor MCP dentro do
// processo, sem custo de inicialização): por enquanto, mandar arquivos.
import fs from 'node:fs';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const MAX_UPLOAD = 50 * 1024 * 1024; // limite da Bot API para envio

/**
 * @param {object} o
 * @param {string} o.cwd
 * @param {(file: string, caption?: string) => Promise<void>} o.sendFile
 */
export function telegramToolsServer({ cwd, sendFile }) {
  return createSdkMcpServer({
    name: 'telegram',
    version: '1.0.0',
    tools: [
      tool(
        'enviar_arquivo',
        'Envia um arquivo do servidor para o usuário no Telegram (relatório, planilha, imagem, PDF, log, zip). Use quando o usuário pedir para mandar/enviar um arquivo ou quando o resultado do trabalho for um arquivo. Limite: 50 MB.',
        {
          caminho: z.string().describe('Caminho do arquivo no servidor (absoluto ou relativo à pasta de trabalho)'),
          legenda: z.string().max(1000).optional().describe('Texto curto que acompanha o arquivo'),
        },
        async ({ caminho, legenda }) => {
          const file = path.resolve(cwd, caminho);
          let st;
          try {
            st = fs.statSync(file);
          } catch {
            return { content: [{ type: 'text', text: `Arquivo não encontrado: ${file}` }], isError: true };
          }
          if (!st.isFile()) return { content: [{ type: 'text', text: `Não é um arquivo: ${file}` }], isError: true };
          if (st.size > MAX_UPLOAD) {
            return { content: [{ type: 'text', text: `Arquivo grande demais para o Telegram (${(st.size / 1048576).toFixed(1)} MB; máximo 50 MB). Compacte ou divida.` }], isError: true };
          }
          try {
            await sendFile(file, legenda);
          } catch (err) {
            return { content: [{ type: 'text', text: `Falha ao enviar pelo Telegram: ${err.description || err.message}` }], isError: true };
          }
          return { content: [{ type: 'text', text: `Arquivo ${path.basename(file)} enviado ao usuário.` }] };
        },
      ),
    ],
  });
}
