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

const PORT = parseInt(process.env.PORT || '4000', 10);

const server = http.createServer(app);
// Node kills any request still streaming after 5 minutes by default
// (requestTimeout=300s) — a multi-GB MateState backup upload takes longer.
// Disable the whole-request timer; headersTimeout (60s) still guards slowloris.
server.requestTimeout = 0;
setupConsoleWebSocket(server);

server.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' }, `ProxMate API running on http://localhost:${PORT}`);
  startScheduler();
});
