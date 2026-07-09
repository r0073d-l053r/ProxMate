import { Router, type Request, type Response } from 'express';
import { createReadStream } from 'node:fs';
import { statSync } from 'node:fs';
import path from 'node:path';
import { consumeDownloadToken, pruneDownloadTokens, DownloadError } from '../services/download.service.js';
import { publicTokenLimiter } from '../middleware/rate-limit.js';

/**
 * Public, token-authenticated backup download. Mounted OUTSIDE the auth
 * middleware — the single-use token in the URL is the credential (like a
 * password-reset link). Any invalid/expired/spent token gets a generic 404 so
 * the endpoint is not a guessing oracle.
 */
const router = Router();

// A token is 64 hex chars; reject anything else before touching the DB.
const TOKEN_RE = /^[a-f0-9]{64}$/;

router.get('/:token', publicTokenLimiter, async (req: Request, res: Response) => {
  const raw = req.params['token'] as string;
  if (!TOKEN_RE.test(raw)) { res.status(404).json({ error: 'Not found' }); return; }

  let resolved;
  try {
    resolved = await consumeDownloadToken(raw);
  } catch (err) {
    if (err instanceof DownloadError) { res.status(404).json({ error: 'This download link is invalid or has expired.' }); return; }
    res.status(500).json({ error: 'Download failed' });
    return;
  }

  // Opportunistic cleanup (best-effort, never blocks the response).
  void pruneDownloadTokens().catch(() => undefined);

  const { fullPath, filename } = resolved;
  try {
    const size = statSync(fullPath).size;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(size));
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filename)}"`);
    const stream = createReadStream(fullPath);
    // If the client aborts mid-download, destroy the file stream so we don't
    // keep reading multi-GB vzdumps into a closed socket.
    const abort = () => { stream.destroy(); };
    req.on('close', abort);
    res.on('close', abort);
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
    stream.pipe(res);
  } catch {
    res.status(404).json({ error: 'This download link is invalid or has expired.' });
  }
});

export default router;
