// Estado persistente do bot (preferências, sessão, tarefa em andamento) em um
// arquivo JSON. Gravação atômica: escreve um .tmp e renomeia.
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './log.js';

const log = logger('store');

export class Store {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = { users: {} };
    this.saveTimer = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.users) this.data = parsed;
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn('estado ilegível, começando do zero:', err.message);
    }
  }

  user(id) {
    const key = String(id);
    if (!this.data.users[key]) {
      this.data.users[key] = {
        sessionId: null,
        previousSessionId: null,
        lastActivityAt: 0,
        prefs: {},
        stats: { messages: 0, lastDurationMs: 0, lastSteps: 0 },
        inflight: null,
      };
    }
    const u = this.data.users[key];
    u.prefs ||= {};
    u.stats ||= { messages: 0, lastDurationMs: 0, lastSteps: 0 };
    return u;
  }

  prefs(id) {
    const u = this.user(id);
    return { ...this.defaults, ...u.prefs };
  }

  setPref(id, key, value) {
    this.user(id).prefs[key] = value;
    this.save();
  }

  update(id, fn) {
    fn(this.user(id));
    this.save();
  }

  save({ now = false } = {}) {
    if (now) return this.flush();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 200);
    this.saveTimer.unref?.();
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log.error('falha ao salvar estado:', err.message);
    }
  }
}
