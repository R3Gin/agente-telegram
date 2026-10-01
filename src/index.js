// Ponto de entrada: node --env-file-if-exists=.env src/index.js
import { loadConfig, ensureDirs } from './config.js';
import { setLogLevel, logger } from './log.js';
import { createApp } from './telegram/bot.js';

const log = logger('main');

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
setLogLevel(config.logLevel);
ensureDirs(config);

const app = createApp(config);

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  log.info(`recebi ${signal}`);
  const force = setTimeout(() => process.exit(0), 12_000);
  force.unref();
  try {
    await app.shutdown();
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
process.on('unhandledRejection', (err) => log.error('promessa rejeitada sem tratamento:', err));
process.on('uncaughtException', (err) => {
  log.error('exceção não tratada:', err);
});

app.start().catch((err) => {
  log.error('falha ao iniciar:', err);
  process.exit(1);
});
