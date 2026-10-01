// Sessão contínua do Claude Code para um usuário.
//
// Em vez de abrir um processo novo a cada mensagem (o que custava segundos),
// mantemos um único Claude Code aberto em "streaming input mode": cada
// mensagem do Telegram é empurrada para a mesma sessão, e o processo já está
// pronto, com ferramentas e MCP carregados.
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from './async-queue.js';
import { classifyTool } from './policy.js';
import { logger } from '../log.js';

const log = logger('sessao');

export class AgentSession {
  /**
   * @param {object} o
   * @param {object} o.config            configuração global (loadConfig)
   * @param {() => object} o.getPrefs    preferências atuais do usuário
   * @param {string|null} o.sessionId    sessão a retomar
   * @param {(id: string) => void} o.onSessionId
   * @param {(toolName: string, input: object, opts: object) => Promise<object>} o.onToolRequest
   * @param {() => object} [o.mcpServers]
   * @param {string} [o.systemAppend]
   * @param {string[]} [o.protectedPaths]
   * @param {(msg: object) => object|null} [o.onUnsolicited]  saída do Claude fora de um pedido
   * @param {Function} [o.queryFn]
   */
  constructor(o) {
    this.config = o.config;
    this.getPrefs = o.getPrefs;
    this.sessionId = o.sessionId || null;
    this.onSessionId = o.onSessionId || (() => {});
    this.onToolRequest = o.onToolRequest;
    this.mcpServers = o.mcpServers || (() => ({}));
    this.systemAppend = o.systemAppend || '';
    this.protectedPaths = o.protectedPaths || [];
    this.onUnsolicited = o.onUnsolicited || (() => null);
    this.onResumeFailed = o.onResumeFailed || null;
    this.queryFn = o.queryFn || sdkQuery;
    this.label = o.label || 'usuario';

    this.q = null;
    this.input = null;
    this.alive = false;
    this.closing = false;
    this.turn = null;
    this.lastTurn = null;
    this.generation = 0;
    this.startedAt = 0;
  }

  get busy() {
    return Boolean(this.turn);
  }

  buildOptions(resume) {
    const prefs = this.getPrefs();
    const c = this.config.claude;
    // o token do bot não vai para o Claude (ele roda comandos que poderiam lê-lo)
    const env = { ...process.env, ...c.extraEnv };
    delete env.TELEGRAM_BOT_TOKEN;
    const options = {
      cwd: this.config.cwd,
      model: prefs.model,
      effort: prefs.effort,
      permissionMode: 'default',
      includePartialMessages: true,
      promptSuggestions: c.promptSuggestions !== false,
      maxTurns: c.maxTurns,
      env,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: this.systemAppend },
      mcpServers: this.mcpServers(),
      hooks: { PreToolUse: [{ hooks: [this.preToolUse.bind(this)] }] },
      canUseTool: (toolName, input, opts) => this.onToolRequest(toolName, input, opts),
      stderr: (data) => {
        const line = String(data).trim();
        if (line) log.debug(`[${this.label}] claude:`, line.slice(0, 500));
      },
    };
    if (resume) options.resume = resume;
    if (c.bin) options.pathToClaudeCodeExecutable = c.bin;
    if (c.settingSources) options.settingSources = c.settingSources;
    return options;
  }

  /** Classifica cada ferramenta antes de rodar: libera, pede confirmação ou deixa para a interface. */
  async preToolUse(input) {
    try {
      // no modo de planejamento quem decide é o próprio Claude Code (só leitura)
      if (input.permission_mode === 'plan') return {};
      const prefs = this.getPrefs();
      const { decision, reason } = classifyTool(input.tool_name, input.tool_input || {}, {
        mode: prefs.confirm,
        protectedPaths: this.protectedPaths,
        mcpSource: input.mcp_server?.source,
      });
      if (decision === 'ui') return {};
      if (decision === 'ask') {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } };
      }
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
    } catch (err) {
      log.error('erro no PreToolUse:', err);
      return {};
    }
  }

  /** Abre o processo do Claude Code (pré-aquecimento). */
  start({ resume = this.sessionId } = {}) {
    if (this.alive) return;
    this.closing = false;
    this.input = new AsyncQueue();
    const gen = ++this.generation;
    this.startedAt = Date.now();
    log.info(`[${this.label}] abrindo sessão${resume ? ` (retomando ${resume.slice(0, 8)})` : ' nova'}`);
    this.q = this.queryFn({ prompt: this.input, options: this.buildOptions(resume) });
    this.alive = true;
    this.consume(gen, this.q);
  }

  async consume(gen, q) {
    let error = null;
    try {
      for await (const msg of q) {
        if (gen !== this.generation) break;
        this.dispatch(msg);
      }
    } catch (err) {
      error = err;
    }
    if (gen !== this.generation) return; // sessão antiga, já substituída
    this.alive = false;
    const turn = this.turn;
    this.turn = null;
    if (this.closing) {
      if (turn) turn.reject(new Error('sessão encerrada'));
      return;
    }
    const reason = error ? String(error.message || error).split('\n').pop().slice(0, 300) : 'processo encerrado';
    log.warn(`[${this.label}] sessão do Claude terminou: ${reason}`);
    if (turn) {
      const err = new Error(reason);
      err.sessionEnded = true;
      turn.reject(err);
    }
  }

  isMissingSession(msg) {
    return (
      msg.type === 'result' &&
      msg.subtype === 'error_during_execution' &&
      !msg.num_turns &&
      (msg.errors || []).some((e) => /No conversation found/i.test(String(e)))
    );
  }

  /** A conversa salva sumiu (ex.: transcript apagado): começa outra e reenvia o pedido. */
  handleMissingSession() {
    log.warn(`[${this.label}] conversa ${String(this.sessionId).slice(0, 8)} não encontrada; começando uma nova`);
    const turn = this.turn;
    this.turn = null;
    this.sessionId = null;
    this.onSessionId(null);
    this.generation++; // o processo antigo vai encerrar sozinho
    try {
      this.input?.end();
    } catch {
      /* já encerrada */
    }
    this.alive = false;
    this.start({ resume: null });
    if (turn) {
      this.onResumeFailed?.();
      this.turn = turn;
      this.input.push(turn.userMessage);
    }
  }

  dispatch(msg) {
    if (this.isMissingSession(msg)) {
      this.handleMissingSession();
      return;
    }
    if (msg.session_id && msg.session_id !== this.sessionId && msg.type !== 'stream_event') {
      this.sessionId = msg.session_id;
      this.onSessionId(msg.session_id);
    }
    if (msg.type === 'prompt_suggestion') {
      this.lastTurn?.onSuggestion?.(msg.suggestion);
      return;
    }
    let turn = this.turn;
    if (!turn) {
      // O Claude Code às vezes continua sozinho (ex.: tarefa em segundo plano terminou).
      if (msg.type === 'stream_event' || msg.type === 'assistant') {
        const tracker = this.onUnsolicited(msg);
        if (tracker) {
          turn = this.turn = { tracker, onSuggestion: tracker.onSuggestion, resolve: () => {}, reject: () => {}, unsolicited: true };
        }
      }
      if (!turn) return;
    }
    try {
      turn.tracker.handle(msg);
    } catch (err) {
      log.error('erro ao processar mensagem do Claude:', err);
    }
    if (msg.type === 'result') {
      this.turn = null;
      this.lastTurn = turn;
      turn.resolve(msg);
    }
  }

  /**
   * Envia uma mensagem do usuário e resolve com a mensagem "result" do Claude.
   * @param {string|object[]} content  texto ou blocos (texto + imagens)
   * @param {{handle: Function, onSuggestion?: Function}} tracker
   */
  runTurn(content, tracker) {
    if (this.turn) return Promise.reject(new Error('já existe um pedido em andamento'));
    if (!this.alive) this.start();
    return new Promise((resolve, reject) => {
      const userMessage = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
      this.turn = { tracker, onSuggestion: (s) => tracker.onSuggestion?.(s), resolve, reject, userMessage };
      try {
        this.input.push(userMessage);
      } catch (err) {
        this.turn = null;
        reject(err);
      }
    });
  }

  async interrupt() {
    if (!this.alive || !this.q) return false;
    try {
      await this.q.interrupt();
      return true;
    } catch (err) {
      log.warn(`[${this.label}] interrupt falhou:`, err.message);
      return false;
    }
  }

  async setModel(model) {
    if (!this.alive) return;
    try {
      await this.q.setModel(model);
    } catch (err) {
      log.warn('setModel falhou:', err.message);
    }
  }

  async setEffort(effort) {
    if (!this.alive) return;
    try {
      await this.q.applyFlagSettings({ effortLevel: effort });
    } catch (err) {
      log.warn('applyFlagSettings(effort) falhou:', err.message);
    }
  }

  async setPermissionMode(mode) {
    if (!this.alive) return;
    try {
      await this.q.setPermissionMode(mode);
    } catch (err) {
      log.warn('setPermissionMode falhou:', err.message);
    }
  }

  async contextUsage() {
    if (!this.alive) return null;
    try {
      return await Promise.race([this.q.getContextUsage({ detail: 'summary' }), new Promise((r) => setTimeout(() => r(null), 4000))]);
    } catch {
      return null;
    }
  }

  /** Encerra o processo com calma (fecha a entrada; o Claude Code sai sozinho). */
  close() {
    if (!this.q) return;
    this.closing = true;
    this.alive = false;
    const q = this.q;
    this.generation++;
    try {
      this.input?.end();
    } catch {
      /* já encerrada */
    }
    const t = setTimeout(() => {
      try {
        q.close();
      } catch {
        /* ignora */
      }
    }, 3000);
    t.unref?.();
    if (this.turn) {
      this.turn.reject(new Error('sessão encerrada'));
      this.turn = null;
    }
    this.q = null;
  }

  /** Começa uma conversa do zero (o processo antigo é encerrado). */
  reset({ resume = null, prewarm = true } = {}) {
    this.close();
    this.sessionId = resume;
    if (prewarm) this.start({ resume });
  }
}
