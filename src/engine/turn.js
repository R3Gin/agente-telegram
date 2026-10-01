// Acompanha um pedido (turno) do início ao fim a partir das mensagens do
// Claude Code e mantém um "estado" pronto para ser mostrado no Telegram:
// etapas, texto sendo escrito, novas tentativas da API, limite de uso etc.
import { describeTool, describeResult } from './activity.js';

const DENIED_RE = /negou|denied|rejected|doesn't want to proceed|não quer/i;

export class TurnTracker {
  constructor({ onChange = () => {}, now = () => Date.now() } = {}) {
    this.now = now;
    this.onChange = onChange;
    const t = now();
    this.state = {
      startedAt: t,
      lastEventAt: t,
      phase: 'starting', // starting | thinking | writing | tool | waiting_user | retrying | compacting | done
      steps: [],
      liveText: '', // texto do bloco sendo escrito agora
      texts: [], // blocos de texto já concluídos (só da conversa principal)
      retry: null,
      rateLimit: null,
      compacted: false,
      model: null,
      result: null,
      assistantError: null,
      thinkingSince: null,
      refusalFallback: null,
    };
    this.blockTypes = new Map(); // índice do bloco em streaming → tipo
    this.stepsById = new Map();
  }

  touch() {
    this.state.lastEventAt = this.now();
  }

  changed() {
    this.touch();
    this.onChange(this.state);
  }

  addStep(id, name, input, status = 'running', parent = null) {
    const d = describeTool(name, input);
    const step = { id, name, icon: d.icon, text: d.text, status, startedAt: this.now(), endedAt: null, detail: '', parent, children: 0 };
    if (id) this.stepsById.set(id, step);
    this.state.steps.push(step);
    return step;
  }

  /** Processa uma mensagem do Claude Code. */
  handle(msg) {
    const s = this.state;
    switch (msg.type) {
      case 'stream_event': {
        if (msg.parent_tool_use_id) return; // subagente: não mostra texto parcial
        const ev = msg.event || {};
        if (ev.type === 'message_start') {
          this.blockTypes.clear();
          if (s.phase === 'retrying') s.retry = null;
        } else if (ev.type === 'content_block_start') {
          const block = ev.content_block || {};
          this.blockTypes.set(ev.index, block.type);
          if (block.type === 'text') {
            s.liveText = '';
            s.phase = 'writing';
          } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
            s.phase = 'thinking';
            s.thinkingSince = this.now();
          } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
            s.phase = 'tool';
            if (block.id && !this.stepsById.has(block.id)) this.addStep(block.id, block.name, {}, 'preparing');
          }
        } else if (ev.type === 'content_block_delta') {
          const d = ev.delta || {};
          if (d.type === 'text_delta') {
            s.liveText += d.text;
            s.phase = 'writing';
          } else if (d.type === 'thinking_delta') {
            s.phase = 'thinking';
          }
        } else if (ev.type === 'content_block_stop') {
          const type = this.blockTypes.get(ev.index);
          if (type === 'text' && s.liveText.trim()) s.texts.push(s.liveText);
          if (type === 'thinking') s.thinkingSince = null;
        }
        this.changed();
        return;
      }
      case 'assistant': {
        const content = msg.message?.content || [];
        if (msg.error) s.assistantError = msg.error;
        if (msg.parent_tool_use_id) {
          // ferramentas usadas por um subagente: conta no passo do subagente
          const parent = this.stepsById.get(msg.parent_tool_use_id);
          for (const b of content) {
            if (b.type === 'tool_use' && parent) {
              parent.children += 1;
              const d = describeTool(b.name, b.input);
              parent.detail = `${d.icon} ${d.text}`;
            }
          }
          this.changed();
          return;
        }
        for (const b of content) {
          if (b.type === 'tool_use') {
            const existing = this.stepsById.get(b.id);
            if (existing) {
              const d = describeTool(b.name, b.input);
              existing.icon = d.icon;
              existing.text = d.text;
              existing.status = 'running';
              existing.input = b.input;
            } else {
              const step = this.addStep(b.id, b.name, b.input, 'running');
              step.input = b.input;
            }
            s.phase = b.name === 'AskUserQuestion' || b.name === 'ExitPlanMode' ? 'waiting_user' : 'tool';
          } else if (b.type === 'text') {
            // sem streaming parcial, o texto chega aqui inteiro
            if (b.text && !s.texts.includes(b.text) && s.liveText !== b.text) {
              s.texts.push(b.text);
              s.liveText = b.text;
            }
          }
        }
        this.changed();
        return;
      }
      case 'user': {
        if (msg.parent_tool_use_id) return;
        const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
        for (const b of content) {
          if (b.type !== 'tool_result') continue;
          const step = this.stepsById.get(b.tool_use_id);
          if (!step) continue;
          step.endedAt = this.now();
          const text = typeof b.content === 'string' ? b.content : (b.content || []).map((c) => c.text || '').join(' ');
          if (b.is_error) step.status = DENIED_RE.test(text) ? 'denied' : 'error';
          else step.status = 'done';
          const extra = describeResult(step.name, msg.tool_use_result);
          if (extra) step.detail = extra;
        }
        if (s.phase === 'tool' || s.phase === 'waiting_user') s.phase = 'thinking';
        this.changed();
        return;
      }
      case 'tool_progress': {
        const step = this.stepsById.get(msg.tool_use_id);
        if (step) step.elapsedSec = msg.elapsed_time_seconds;
        this.changed();
        return;
      }
      case 'rate_limit_event': {
        const info = msg.rate_limit_info || {};
        if (info.status && info.status !== 'allowed') s.rateLimit = info;
        this.changed();
        return;
      }
      case 'result': {
        s.result = msg;
        s.phase = 'done';
        if (s.liveText.trim() && !s.texts.includes(s.liveText)) s.texts.push(s.liveText);
        for (const step of s.steps) {
          if (step.status === 'running' || step.status === 'preparing') {
            step.status = msg.subtype === 'success' ? 'done' : 'error';
            step.endedAt = this.now();
          }
        }
        this.changed();
        return;
      }
      case 'system':
        this.handleSystem(msg);
        return;
      default:
        this.touch();
    }
  }

  handleSystem(msg) {
    const s = this.state;
    switch (msg.subtype) {
      case 'init':
        s.model = msg.model || s.model;
        break;
      case 'api_retry':
        s.retry = {
          attempt: msg.attempt,
          max: msg.max_retries,
          delayMs: msg.retry_delay_ms,
          status: msg.error_status,
          error: msg.error,
          at: this.now(),
        };
        s.phase = 'retrying';
        break;
      case 'status':
        if (msg.status === 'compacting') s.phase = 'compacting';
        else if (s.phase === 'compacting') s.phase = 'thinking';
        break;
      case 'compact_boundary':
        s.compacted = true;
        if (s.phase === 'compacting') s.phase = 'thinking';
        break;
      case 'task_started': {
        const step = msg.tool_use_id && this.stepsById.get(msg.tool_use_id);
        if (step && !msg.skip_transcript) step.longRunning = true;
        break;
      }
      case 'task_progress': {
        const step = msg.tool_use_id && this.stepsById.get(msg.tool_use_id);
        if (step && msg.summary) step.detail = msg.summary;
        break;
      }
      case 'permission_denied': {
        const step = this.stepsById.get(msg.tool_use_id);
        if (step) {
          step.status = 'denied';
          step.endedAt = this.now();
        }
        break;
      }
      case 'model_refusal_fallback':
        s.refusalFallback = { from: msg.original_model, to: msg.fallback_model };
        break;
      default:
        break;
    }
    this.changed();
  }

  /** Texto final da resposta e os textos intermediários (ditos entre as etapas). */
  finalTexts() {
    const s = this.state;
    const r = s.result;
    const all = s.texts.filter((t) => t && t.trim());
    let final = r && r.subtype === 'success' && typeof r.result === 'string' && r.result.trim() ? r.result : all[all.length - 1] || '';
    const intermediates = all.filter((t) => t.trim() !== final.trim());
    return { final, intermediates };
  }
}
