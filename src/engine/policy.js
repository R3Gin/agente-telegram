// Decide o que o Claude pode fazer sozinho e o que precisa da sua confirmação
// por botão. Modos:
//   risky  → só pergunta antes de ações perigosas (apagar, parar serviço, push…)
//   writes → pergunta antes de qualquer coisa que altere o servidor
//   off    → nunca pergunta
// AskUserQuestion e ExitPlanMode sempre vão para a interface (perguntas/plano).

const UI_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const READ_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'ToolSearch',
  'Skill',
  'Agent',
  'Task',
  'EnterPlanMode',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'TaskOutput',
  'BashOutput',
]);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const SYSTEM_PATH =
  /^(\/(etc|boot|usr|bin|sbin|lib|lib64|proc|sys)(\/|$)|\/var\/lib(\/|$)|\/var\/spool\/cron(\/|$)|\/root\/\.(ssh|claude)(\/|$)|\/home\/[^/]+\/\.ssh(\/|$)|\/dev\/(sd|nvme|vd|xvd|hd)|\/\*?$)/;

// ---------------------------------------------------------------------------
// Quebra de comandos do shell (heurística, mas cobre os casos do dia a dia)
// ---------------------------------------------------------------------------

/** Divide uma linha de shell em comandos simples, respeitando aspas. */
export function splitCommands(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  const s = String(cmd ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < s.length) {
        cur += c + s[++i];
        continue;
      }
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '\\' && i + 1 < s.length) {
      cur += c + s[++i];
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      // $( ... ) vira um comando próprio
      let depth = 1;
      let j = i + 2;
      let inner = '';
      while (j < s.length && depth > 0) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')') depth--;
        if (depth > 0) inner += s[j];
        j++;
      }
      out.push(...splitCommands(inner));
      cur += '$()';
      i = j - 1;
      continue;
    }
    if (c === '`') {
      const end = s.indexOf('`', i + 1);
      if (end !== -1) {
        out.push(...splitCommands(s.slice(i + 1, end)));
        cur += '``';
        i = end;
        continue;
      }
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&' || c === '(' || c === ')' || c === '{' || c === '}') {
      // ">&" / "2>&1" não separam comandos
      if (c === '&' && (s[i - 1] === '>' || s[i + 1] === '>')) {
        cur += c;
        continue;
      }
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      if ((c === '|' || c === '&') && s[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Separa um comando simples em palavras, tirando as aspas. */
export function words(segment) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
      continue;
    }
    if (c === '\\' && i + 1 < segment.length) {
      cur += segment[++i];
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (has || cur) out.push(cur);
  return out;
}

const WRAPPERS = new Set(['sudo', 'nohup', 'time', 'nice', 'ionice', 'exec', 'command', 'builtin', 'env', 'stdbuf', 'chronic', 'unbuffer']);

/** Remove prefixos como "sudo", "VAR=x", "timeout 10" e devolve [comando, ...args]. */
export function unwrap(argv) {
  let a = [...argv];
  for (let guard = 0; guard < 10 && a.length; guard++) {
    const first = a[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      a.shift();
      continue;
    }
    if (WRAPPERS.has(first)) {
      a.shift();
      while (a.length && a[0].startsWith('-')) {
        const flag = a.shift();
        if (['-u', '-g', '-n', '-c', '-o', '-e', '-i'].includes(flag) && a.length) a.shift();
      }
      continue;
    }
    if (first === 'timeout') {
      a.shift();
      while (a.length && a[0].startsWith('-')) a.shift();
      if (a.length && /^\d/.test(a[0])) a.shift();
      continue;
    }
    if (first === 'xargs') {
      a.shift();
      while (a.length && a[0].startsWith('-')) {
        const flag = a.shift();
        if (['-I', '-n', '-P', '-d', '-L', '-s', '-E'].includes(flag) && a.length) a.shift();
      }
      continue;
    }
    break;
  }
  if (a.length) a[0] = a[0].replace(/^.*\//, ''); // /usr/bin/rm → rm
  return a;
}

function nonFlags(args) {
  return args.filter((x) => !x.startsWith('-'));
}

function hasFlag(args, ...flags) {
  return args.some((x) => flags.includes(x) || flags.some((f) => /^-[a-zA-Z]+$/.test(x) && f.length === 2 && x.includes(f[1])));
}

function isSystemPath(p) {
  if (!p) return false;
  const clean = p.replace(/^['"]|['"]$/g, '');
  return SYSTEM_PATH.test(clean) || /(^|\/)\.env(\.|$)/.test(clean);
}

// ---------------------------------------------------------------------------
// Regras de risco para o Bash
// ---------------------------------------------------------------------------

function riskyReasonForSegment(argv, raw) {
  const [cmd, ...args] = unwrap(argv);
  if (!cmd) return null;
  const sub = nonFlags(args)[0];

  switch (cmd) {
    case 'rm': {
      const targets = nonFlags(args);
      if (!targets.length) return argv.includes('xargs') ? 'apagar arquivos' : null; // alvos vêm do pipe
      if (targets.every((t) => /^\/tmp\//.test(t) && !t.includes('..'))) return null;
      return 'apagar arquivos';
    }
    case 'rmdir':
    case 'unlink':
    case 'shred':
    case 'truncate':
      return 'apagar ou zerar arquivos';
    case 'dd':
    case 'wipefs':
    case 'fdisk':
    case 'sfdisk':
    case 'parted':
    case 'mkswap':
      return 'mexer em disco';
    case 'find':
      if (args.includes('-delete') || /-exec(dir)?\s+(rm|shred|mv)\b/.test(raw)) return 'apagar arquivos';
      return null;
    case 'mv':
    case 'cp':
      if (nonFlags(args).some(isSystemPath)) return 'mexer em arquivos do sistema';
      return null;
    case 'chmod':
    case 'chown':
    case 'chgrp':
      if (hasFlag(args, '-R') || args.includes('--recursive') || nonFlags(args).some(isSystemPath) || args.includes('777'))
        return 'mudar permissões';
      return null;
    case 'systemctl': {
      const s = sub || '';
      if (['stop', 'restart', 'disable', 'mask', 'kill', 'poweroff', 'reboot', 'halt', 'isolate', 'rescue', 'emergency', 'try-restart', 'reload-or-restart'].includes(s))
        return 'parar ou reiniciar serviço';
      return null;
    }
    case 'service':
      if (args.some((a) => ['stop', 'restart', 'force-reload'].includes(a))) return 'parar ou reiniciar serviço';
      return null;
    case 'reboot':
    case 'shutdown':
    case 'poweroff':
    case 'halt':
      return 'desligar ou reiniciar o servidor';
    case 'init':
    case 'telinit':
      if (['0', '6'].includes(sub)) return 'desligar ou reiniciar o servidor';
      return null;
    case 'kill':
    case 'killall':
    case 'pkill':
      return 'encerrar processos';
    case 'docker':
    case 'podman': {
      const na = nonFlags(args);
      const s = na[0] || '';
      if (['rm', 'rmi', 'kill', 'stop', 'restart'].includes(s)) return 'parar ou apagar containers';
      if (s === 'compose' && ['down', 'rm', 'stop', 'restart', 'kill'].includes(na[1])) return 'parar ou apagar containers';
      if (['system', 'container', 'image', 'volume', 'network', 'builder'].includes(s) && ['prune', 'rm', 'remove'].includes(na[1]))
        return 'apagar dados do Docker';
      if (s === 'prune') return 'apagar dados do Docker';
      if (['service', 'stack'].includes(s) && ['rm', 'remove'].includes(na[1])) return 'apagar serviços do Docker';
      if (s === 'swarm' && na[1] === 'leave') return 'sair do swarm';
      return null;
    }
    case 'docker-compose':
      if (['down', 'rm', 'stop', 'restart', 'kill'].includes(sub)) return 'parar ou apagar containers';
      return null;
    case 'apt':
    case 'apt-get':
    case 'aptitude':
    case 'dnf':
    case 'yum':
    case 'pacman':
    case 'snap':
    case 'zypper':
      if (['remove', 'purge', 'autoremove', 'erase', 'upgrade', 'dist-upgrade', 'full-upgrade', 'uninstall'].includes(sub) || args.includes('-R'))
        return 'remover ou atualizar pacotes do sistema';
      return null;
    case 'npm':
    case 'yarn':
    case 'pnpm':
      if (['uninstall', 'remove', 'rm', 'un', 'unlink'].includes(sub)) return 'remover pacotes';
      return null;
    case 'pip':
    case 'pip3':
      if (sub === 'uninstall') return 'remover pacotes';
      return null;
    case 'git': {
      const na = nonFlags(args);
      const s = na[0] || '';
      if (s === 'push') return 'enviar código para o repositório remoto';
      if (s === 'reset' && args.includes('--hard')) return 'descartar alterações do git';
      if (s === 'clean' && args.some((a) => /^-[a-zA-Z]*f/.test(a))) return 'apagar arquivos não versionados';
      if ((s === 'checkout' || s === 'restore') && (args.includes('.') || args.includes('--'))) return 'descartar alterações do git';
      if (s === 'branch' && args.some((a) => a === '-D' || a === '--delete' || a === '-d')) return 'apagar branch';
      if (s === 'stash' && ['drop', 'clear'].includes(na[1])) return 'apagar stash';
      if (['rebase', 'filter-branch', 'filter-repo'].includes(s)) return 'reescrever o histórico do git';
      return null;
    }
    case 'crontab':
      if (args.includes('-r')) return 'apagar o crontab';
      return null;
    case 'iptables':
    case 'ip6tables':
    case 'nft':
    case 'ufw':
      if (args.some((a) => ['-L', '-S', '--list', 'status', 'list', 'show', '-n', '-v'].includes(a)) && !args.some((a) => ['-A', '-D', '-I', '-F', '-X', '-P', 'delete', 'deny', 'allow', 'reset', 'disable', 'enable', 'flush', 'add'].includes(a)))
        return null;
      return 'mudar o firewall';
    case 'userdel':
    case 'deluser':
    case 'usermod':
    case 'passwd':
    case 'chpasswd':
    case 'groupdel':
    case 'delgroup':
      return 'mudar usuários do sistema';
    case 'umount':
      return 'desmontar disco';
    case 'mount':
      return args.length ? 'montar disco' : null;
    case 'pm2':
      if (['delete', 'del', 'stop', 'kill', 'restart', 'reload', 'flush'].includes(sub)) return 'parar ou reiniciar processos do pm2';
      return null;
    case 'nginx':
      if (args.includes('-s') && ['stop', 'quit'].includes(args[args.indexOf('-s') + 1])) return 'parar o nginx';
      return null;
    case 'tee':
      if (nonFlags(args).some(isSystemPath)) return 'escrever em arquivo do sistema';
      return null;
    case 'sed':
      if (args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place')) && nonFlags(args).some(isSystemPath))
        return 'editar arquivo do sistema';
      return null;
    case 'bash':
    case 'sh':
    case 'zsh':
    case 'dash': {
      const i = args.indexOf('-c');
      if (i !== -1 && args[i + 1]) return riskyBash(args[i + 1]);
      return null;
    }
    default:
      return null;
  }
}

/** Motivo (em português) se o comando for perigoso; null se for tranquilo. */
export function riskyBash(command) {
  const cmd = String(command ?? '');
  if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(cmd)) return 'executar script baixado da internet';
  if (/\b(drop\s+(table|database|schema|index)|truncate\s+table|delete\s+from)\b/i.test(cmd)) return 'apagar dados do banco';
  if (/(^|[^0-9&>])>{1,2}\s*['"]?(\/etc|\/boot|\/usr|\/bin|\/sbin|\/lib|\/var\/lib|\/root\/\.ssh|\/root\/\.claude|\/dev\/(sd|nvme|vd))/.test(cmd))
    return 'escrever em arquivo do sistema';
  if (/(^|\s|\/)\.env\b/.test(cmd) && /(^|[^0-9&>])>{1,2}\s*\S*\.env\b/.test(cmd)) return 'sobrescrever arquivo .env';
  for (const seg of splitCommands(cmd)) {
    const reason = riskyReasonForSegment(words(seg), seg);
    if (reason) return reason;
  }
  return null;
}

// Comandos que só leem (para o modo "writes").
const READONLY = new Set([
  'ls', 'll', 'la', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'fd', 'pwd', 'echo', 'printf',
  'which', 'whereis', 'type', 'whoami', 'id', 'date', 'uptime', 'df', 'du', 'free', 'ps', 'pgrep', 'stat', 'file', 'wc', 'sort',
  'uniq', 'cut', 'tr', 'awk', 'jq', 'yq', 'diff', 'cmp', 'md5sum', 'sha1sum', 'sha256sum', 'printenv', 'hostname', 'uname',
  'lsb_release', 'ss', 'netstat', 'ping', 'dig', 'nslookup', 'host', 'journalctl', 'dmesg', 'lsof', 'tree', 'realpath',
  'basename', 'dirname', 'test', '[', 'true', 'false', 'sleep', 'nproc', 'lscpu', 'lsblk', 'cd', 'column', 'nl', 'tac', 'rev',
  'xxd', 'od', 'strings', 'readlink', 'getent', 'groups', 'last', 'w', 'who', 'top', 'htop', 'vmstat', 'iostat', 'sar', 'curl',
  'node', 'python', 'python3', 'openssl', 'timedatectl', 'hostnamectl', 'locale', 'env',
]);

function readOnlySegment(argv, raw) {
  const [cmd, ...args] = unwrap(argv);
  if (!cmd) return true;
  if (/(^|[^0-9&>])>{1,2}\s*(?!\/dev\/null)\S/.test(raw)) return false; // redireciona para arquivo
  const sub = nonFlags(args)[0];
  switch (cmd) {
    case 'git':
      return ['status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'ls-files', 'blame', 'describe', 'tag', 'shortlog', 'grep', 'config'].includes(sub) &&
        !(sub === 'config' && !args.includes('--get') && !args.includes('--list') && !args.includes('-l')) &&
        !(sub === 'branch' && args.some((a) => ['-d', '-D', '-m', '-M', '--delete'].includes(a))) &&
        !(sub === 'tag' && args.some((a) => ['-d', '-a', '-s'].includes(a)));
    case 'docker':
    case 'podman': {
      const na = nonFlags(args);
      if (['ps', 'logs', 'inspect', 'images', 'version', 'info', 'stats', 'top', 'port', 'history', 'events'].includes(na[0])) return true;
      if (na[0] === 'compose' && ['ps', 'logs', 'config', 'ls', 'images', 'top'].includes(na[1])) return true;
      return false;
    }
    case 'docker-compose':
      return ['ps', 'logs', 'config', 'images', 'top'].includes(sub);
    case 'systemctl':
      return ['status', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-unit-files', 'list-timers', 'show', 'cat'].includes(sub);
    case 'npm':
    case 'pnpm':
    case 'yarn':
      return ['ls', 'list', 'view', 'info', 'outdated', 'why', 'config'].includes(sub) || args.includes('-v') || args.includes('--version');
    case 'pip':
    case 'pip3':
      return ['list', 'show', 'freeze'].includes(sub);
    case 'apt':
    case 'apt-cache':
      return ['list', 'show', 'policy', 'search', 'depends', 'rdepends'].includes(sub);
    case 'dpkg':
      return args.includes('-l') || args.includes('-L') || args.includes('-s');
    case 'pm2':
      return ['list', 'ls', 'status', 'logs', 'show', 'describe', 'jlist', 'prettylist'].includes(sub);
    case 'nginx':
      return args.includes('-t') || args.includes('-T') || args.includes('-v') || args.includes('-V');
    case 'crontab':
      return args.includes('-l');
    case 'ufw':
      return sub === 'status';
    case 'find':
      return !args.includes('-delete') && !/-exec/.test(raw);
    case 'sed':
      return !args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'));
    case 'curl':
      return !args.some((a) => ['-X', '--request', '-d', '--data', '--data-binary', '--data-raw', '-F', '--form', '-T', '--upload-file', '-o', '--output', '-O'].includes(a));
    case 'node':
    case 'python':
    case 'python3':
      return args.length === 1 && ['-v', '--version', '-V'].includes(args[0]);
    case 'openssl':
      return ['x509', 's_client', 'version', 'req'].includes(sub) && !args.includes('-out');
    default:
      return READONLY.has(cmd);
  }
}

export function readOnlyBash(command) {
  const segs = splitCommands(command);
  return segs.every((seg) => readOnlySegment(words(seg), seg));
}

// ---------------------------------------------------------------------------
// Decisão final por ferramenta
// ---------------------------------------------------------------------------

/**
 * @returns {{decision: 'allow'|'ask'|'ui', reason?: string}}
 */
export function classifyTool(toolName, input = {}, { mode = 'risky', protectedPaths = [], mcpSource } = {}) {
  if (UI_TOOLS.has(toolName)) return { decision: 'ui' };
  if (mode === 'off') return { decision: 'allow' };

  const isProtected = (p) => {
    if (!p) return false;
    const clean = String(p);
    return isSystemPath(clean) || protectedPaths.some((pp) => clean === pp || clean.startsWith(pp.endsWith('/') ? pp : pp + '/'));
  };

  if (toolName === 'Bash') {
    const command = String(input.command ?? '');
    const reason = riskyBash(command) || (protectedPaths.some((pp) => command.includes(pp)) && !readOnlyBash(command) ? 'mexer na pasta do próprio bot' : null);
    if (reason) return { decision: 'ask', reason };
    if (mode === 'writes' && !readOnlyBash(command)) return { decision: 'ask', reason: 'comando que altera o servidor' };
    return { decision: 'allow' };
  }

  if (WRITE_TOOLS.has(toolName)) {
    const p = input.file_path || input.notebook_path;
    if (/\/\.claude\/plans\/[^/]+\.md$/.test(String(p || ''))) return { decision: 'allow' }; // arquivo de plano do próprio Claude Code
    if (isProtected(p)) return { decision: 'ask', reason: 'alterar arquivo sensível' };
    if (mode === 'writes') return { decision: 'ask', reason: 'alterar arquivo' };
    return { decision: 'allow' };
  }

  if (toolName.startsWith('mcp__')) {
    if (mcpSource === 'sdk' || toolName.startsWith('mcp__telegram__')) return { decision: 'allow' };
    const action = toolName.split('__').slice(2).join('__');
    if (/(delete|remove|destroy|drop|purge|wipe|reset|revoke|terminate|uninstall|rollback|kill|deprovision)/i.test(action))
      return { decision: 'ask', reason: 'ação destrutiva em serviço externo' };
    if (mode === 'writes' && !/^(get|list|read|search|describe|fetch|status|logs|show|find|query|whoami|check)/i.test(action.replace(/^[^a-z]+/i, '')))
      return { decision: 'ask', reason: 'ação em serviço externo' };
    return { decision: 'allow' };
  }

  if (READ_TOOLS.has(toolName)) return { decision: 'allow' };
  // ferramentas desconhecidas: no modo "writes", confirma
  if (mode === 'writes') return { decision: 'ask', reason: 'ação desconhecida' };
  return { decision: 'allow' };
}
