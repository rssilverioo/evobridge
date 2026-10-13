import { boot } from './boot.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const runtime = await boot(config);
const { app } = runtime;

await app.listen({ port: config.port, host: config.host });
app.log.info(`EvoBridge ${config.version} listening on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 25_000);
  force.unref();
  try {
    await runtime.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
