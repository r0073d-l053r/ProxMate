import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Auto-generate ENCRYPTION_KEY on first run and persist it to .env
if (!process.env.ENCRYPTION_KEY) {
  const key = randomBytes(32).toString('hex');
  process.env.ENCRYPTION_KEY = key;
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    let content = readFileSync(envPath, 'utf8');
    content = content.includes('ENCRYPTION_KEY=')
      ? content.replace(/^ENCRYPTION_KEY=.*$/m, `ENCRYPTION_KEY=${key}`)
      : content + `\nENCRYPTION_KEY=${key}`;
    writeFileSync(envPath, content, 'utf8');
  }
  console.log('Generated and saved ENCRYPTION_KEY to .env');
}

import http from 'node:http';
import { app } from './app.js';
import { logger } from './lib/logger.js';
import { setupConsoleWebSocket } from './routes/console.routes.js';
import { startScheduler } from './services/scheduler.service.js';
import { reconcileInterruptedPassthroughApplies } from './services/passthrough-request.service.js';

const PORT = parseInt(process.env.PORT || '4000', 10);
// Default to 0.0.0.0 so the port is reachable by the reverse proxy and sibling
// containers (Docker networking) — the container boundary is the isolation, and
// *host* exposure is controlled at the reverse proxy / the compose `ports:`
// host-bind. A bare-metal operator behind a same-host proxy can set
// BIND_ADDR=127.0.0.1 to listen on loopback only.
const BIND_ADDR = process.env.BIND_ADDR || '0.0.0.0';

const server = http.createServer(app);
// Node kills any request still streaming after 5 minutes by default
// (requestTimeout=300s) — a multi-GB MateState backup upload takes longer.
// Disable the whole-request timer; headersTimeout still guards slowloris.
server.requestTimeout = 0;
// keepAliveTimeout should stay *below* headersTimeout, otherwise a keep-alive
// connection reused right at the boundary can race the header timer (a source
// of intermittent 502s behind a proxy). Keep headers a touch higher.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
setupConsoleWebSocket(server);

server.listen(PORT, BIND_ADDR, () => {
  logger.info({ port: PORT, bind: BIND_ADDR, env: process.env.NODE_ENV || 'development' }, `ProxMate API running on http://${BIND_ADDR}:${PORT}`);
  startScheduler();
  // Recover any passthrough approval that was mid-flight when the process last
  // stopped (a long disk relocation can outlast a deploy). Best-effort.
  void reconcileInterruptedPassthroughApplies().catch((err) =>
    logger.error({ err }, 'passthrough startup reconcile failed'),
  );
});
