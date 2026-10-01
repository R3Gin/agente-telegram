# agente-telegram

Assistente no Telegram que conversa com o **Claude Code** da sua VPS — rápido, mostrando ao vivo o que está fazendo, perguntando com botões quando tem dúvida e pedindo confirmação antes de ações perigosas.

Roda ao lado do bot antigo (`claude-telegram-bridge`), com outro bot do Telegram e outro serviço, sem mexer nele.

## O que muda em relação ao bot antigo

| | Bot antigo | agente-telegram |
|---|---|---|
| Processo do Claude | um novo a cada mensagem (~3,5 s só para abrir, +4 s com MCP) | **uma sessão contínua**, já aberta e aquecida |
| Enquanto trabalha | "Pensando…" editado | **"Pensando…" nativo do Telegram** (rascunho ao vivo) + etapas em português: 📖 Lendo, 🔎 Procurando, 💻 Rodando… |
| Dúvidas | não tinha como perguntar, chutava | **pergunta com botões** no meio da tarefa e continua do mesmo ponto |
| Ações perigosas | Bash liberado como root, sem confirmação | **confirmação por botão** (✅ Permitir / ❌ Negar / sempre nesta conversa) |
| Limite de etapas | apagava a conversa e rodava tudo de novo | avisa e oferece **▶️ Continuar** mantendo a conversa |
| Mensagem enviada durante uma tarefa | ficava em silêncio até a vez dela | **📥 Na fila** na hora, com ⚡ "parar o atual e fazer este" |
| API ocupada / limite da assinatura | silêncio | mostra **"nova tentativa em 8s (2/10)"** e avisos de limite |
| Tarefa demorada | morta aos 5 min | aviso aos 5 min, pergunta aos 10 min de silêncio, **nunca mata sozinho** |
| Reinício do serviço | tarefa morria e o "Pensando…" ficava parado | avisa e oferece **🔁 Tentar de novo / ▶️ Continuar** |
| Áudio | esperava na fila; 15 s de fala ≈ 50 s | transcreve na hora, modelo mais leve; "para" interrompe na hora |
| Arquivos | ignorava documentos | recebe documentos e **o Claude pode te mandar arquivos** |

## Como usar no Telegram

- **Escreva, mande áudio, foto ou arquivo.** A resposta chega ao vivo.
- **Teclado fixo:** 🛑 Parar · 🆕 Nova conversa · ⚙️ Painel.
- **Depois de cada resposta:** 🧠 Pensar mais (refaz com mais esforço), 💡 sugestão de próxima pergunta, 📋 copiar comando.
- **Comandos:** `/plano <tarefa>` (mostra o plano antes de mexer), `/continuar`, `/nova`, `/status`, `/menu`, `/ajuda`.
- **Áudio:** "para", "nova conversa", "painel" e "continua" funcionam como comandos.
- **Painel:** modelo, esforço, quando pedir confirmação, conversa nova automática, modo ao vivo, status (contexto usado).

## Instalação na VPS

Pré-requisitos: Node 20+, o Claude Code logado no root (o mesmo do bot antigo) e, para áudio, o whisper.cpp.

```bash
cd /home/rmthost
git clone https://github.com/R3Gin/agente-telegram.git
cd agente-telegram
bash scripts/instalar.sh
```

O instalador:
1. instala as dependências;
2. cria o `.env` (permissão 600) e copia do bot antigo, só lendo, o seu ID do Telegram e o caminho do whisper;
3. pede o **token do bot novo** (se rodar pelo SSH) — ou preencha `TELEGRAM_BOT_TOKEN` no `.env` e rode de novo;
4. confere se o `claude` roda nesta CPU e se está logado;
5. baixa o modelo de áudio leve (`ggml-tiny-q5_1`, ~31 MB) para `models/`;
6. instala e inicia o serviço `agente-telegram`.

Depois é só abrir o bot novo no Telegram e mandar `/start`.

> O token do bot novo **não pode** ser o mesmo do bot antigo (os dois brigariam pelas mensagens). O instalador confere isso.

## Operação

```bash
systemctl status agente-telegram          # está rodando?
journalctl -u agente-telegram -f          # logs ao vivo
systemctl restart agente-telegram         # reiniciar
bash scripts/atualizar.sh                 # puxar a versão nova do GitHub e reiniciar
bash scripts/comparar-audio.sh audio.ogg  # comparar velocidade/qualidade dos modelos de áudio
```

Estado (conversa atual, preferências) fica em `data/state.json`. O histórico das conversas é o do próprio Claude Code (`/root/.claude/projects/…`).

## Configuração (`.env`)

Veja todos os campos comentados no [`.env.example`](.env.example). Os principais:

| Variável | Padrão | Para que serve |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | token do bot novo |
| `ALLOWED_TELEGRAM_IDS` | — | quem pode usar (IDs numéricos) |
| `AGENT_CWD` | `/home/rmthost/agente` | pasta de trabalho do Claude |
| `DEFAULT_MODEL` / `DEFAULT_EFFORT` | `sonnet` / `low` | ponto de partida rápido; troque no painel |
| `CONFIRM_MODE` | `risky` | `risky`, `writes` ou `off` |
| `MAX_TURNS` | `80` | limite de segurança por pedido (depois pergunta se continua) |
| `STREAM_MODE` | `draft` | `draft` (nativo) ou `edit` (se o seu Telegram não mostrar o rascunho) |
| `AUTO_NEW_SESSION_HOURS` | `6` | conversa nova depois de X horas parado (`0` = nunca) |
| `CLAUDE_BIN` | vazio | caminho do `claude`; vazio usa o do SDK |
| `WHISPER_MODEL` / `WHISPER_AUDIO_CTX` | tiny / `auto` | modelo de áudio; `auto` acelera áudios curtos |

## Segurança

- Só os IDs de `ALLOWED_TELEGRAM_IDS` são atendidos, e só em conversa privada.
- O serviço roda como root (é onde está o login do Claude Code). Por isso o padrão é **pedir confirmação** antes de: apagar arquivos, parar/reiniciar serviços, derrubar containers, `git push`, mexer em firewall/usuários, escrever em `/etc`, `.env`, `~/.ssh`, na pasta do próprio bot, e ações destrutivas em MCP.
- O token do bot não é repassado para o Claude (ele não consegue lê-lo pelos comandos).
- Ative a verificação em duas etapas no Telegram: quem controla a sua conta controla o bot.
- O login de assinatura (Pro/Max) é para uso pessoal: não libere o bot para outras pessoas usando a sua assinatura.

## Problemas comuns

| Sintoma | O que fazer |
|---|---|
| "🔑 O Claude Code da VPS está sem login" | como root: `claude`, depois `/login` |
| Não aparece o "Pensando…" ao vivo | atualize o app do Telegram, ou no ⚙️ Painel troque 📺 para "Edição" |
| Áudio demorando | `bash scripts/comparar-audio.sh` com um áudio seu; ajuste `WHISPER_MODEL`/`WHISPER_AUDIO_CTX` |
| Áudio com erros de transcrição | `WHISPER_AUDIO_CTX=0` ou volte para o modelo `base` |
| Respostas ficando lentas | 🆕 Nova conversa (conversas longas ficam mais lentas) |
| Bot não responde | `systemctl status agente-telegram` e `journalctl -u agente-telegram -n 100` |

## Desenvolvimento

```bash
npm test   # ~45 s
```

Os testes sobem o bot de verdade contra um **Telegram falso** e uma **API da Anthropic falsa**, usando o binário real do Claude Code. Cobrem: resposta ao vivo, etapas, perguntas com botões (inclusive múltipla escolha e resposta digitada), confirmações, parar (botão, teclado, rascunho nativo e áudio), fila, nova tentativa da API, limite de etapas, avisos de demora, envio e recebimento de arquivos, fotos, `/plano`, painel, conversa nova, conversa salva que sumiu, processo do Claude morrendo, reinício no meio do pedido e o modo sem rascunho nativo.

Estrutura:

```
src/
  index.js                 entrada
  config.js                leitura do .env
  store.js                 estado (data/state.json)
  engine/
    session.js             sessão contínua do Claude Code (Agent SDK, streaming input)
    turn.js                acompanha um pedido: etapas, texto, novas tentativas, limites
    policy.js              o que pede confirmação
    activity.js            descrições em português das etapas
    telegram-tools.js      ferramenta "enviar_arquivo" para o Claude
    prompt.js              instruções extras (perguntar quando houver dúvida etc.)
  telegram/
    bot.js                 grammY, comandos e roteamento
    controller.js          fila, pedidos, controles, áudio/fotos/arquivos
    run-view.js            exibição ao vivo (rascunho nativo ou edição)
    interactions.js        perguntas, confirmações e plano com botões
    panel.js               painel
    format.js              Markdown → HTML do Telegram
  media/                   download de arquivos e transcrição (whisper.cpp)
```
