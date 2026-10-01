// Log simples em uma linha por evento (vai para o journald via stdout/stderr).
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let current = LEVELS.info;

export function setLogLevel(level) {
  current = LEVELS[level] ?? LEVELS.info;
}

function fmt(args) {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object') {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      }
      return String(a);
    })
    .join(' ');
}

function write(level, tag, args) {
  if (LEVELS[level] < current) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${tag}] ${fmt(args)}`;
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export function logger(tag) {
  return {
    debug: (...a) => write('debug', tag, a),
    info: (...a) => write('info', tag, a),
    warn: (...a) => write('warn', tag, a),
    error: (...a) => write('error', tag, a),
  };
}
