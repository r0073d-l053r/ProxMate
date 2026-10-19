import { envNumber } from '../lib/env-number.js';

export const env = {
  PORT: Math.floor(envNumber('PORT', 4000, 1)),
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  FRONTEND_URL: process.env.FRONTEND_URL ?? 'http://localhost:3000',
};
