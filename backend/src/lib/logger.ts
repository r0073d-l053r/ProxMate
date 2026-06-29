import pino from 'pino';

/**
 * Structured JSON logger. One line per event with a level, so logs stay parseable
 * in Docker/k8s/Loki instead of the free-form console.* scattered through the app.
 * Level is `LOG_LEVEL` (default: debug in dev, info otherwise); set `LOG_PRETTY=1`
 * for human-readable local output if the `pino-pretty` transport is installed.
 */
const level = process.env['LOG_LEVEL'] ?? (process.env['NODE_ENV'] === 'production' ? 'info' : 'debug');

export const logger = pino({
  level,
  // Drop the Proxmox API token / secrets if they ever ride along on a logged object.
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'tokenSecret', 'password', 'pass'],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
