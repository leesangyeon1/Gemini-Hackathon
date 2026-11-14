/**
 * HTTP Server Entrypoint (`src/server/index.ts`)
 *
 * Binds `0.0.0.0` on `Number(process.env.PORT) || 8080` for Cloud Run and local startup.
 */

import type { Server } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from './app';
import { type ServerConfig, loadServerConfig } from './config';

export function startServer(overrideConfig?: ServerConfig): Server {
  const config = overrideConfig ?? loadServerConfig();
  const port =
    overrideConfig !== undefined &&
    Number.isInteger(overrideConfig.port) &&
    overrideConfig.port >= 0 &&
    overrideConfig.port <= 65535
      ? overrideConfig.port
      : config.port;
  const host = overrideConfig?.host || config.host || '0.0.0.0';

  const app = createApp({ config });

  const server = app.listen(port, host, () => {
    console.log(
      `[foreal-estate] listening on http://${host}:${port} (env=${config.nodeEnv}, budgetStore=${config.budgetStoreMode})`
    );
  });

  const shutdown = (signal: string) => {
    console.log(`[foreal-estate] received ${signal}, closing HTTP server...`);
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => {
      process.exit(1);
    }, 5000).unref();
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

const isDirectExecution =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  startServer();
}
