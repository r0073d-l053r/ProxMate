import 'dotenv/config';
import { ensureEncryptionKey } from './lib/encryption-key.js';

// A missing ENCRYPTION_KEY is generated only when it can be persisted (a dev
// .env); otherwise refuse to start rather than run on a key the next restart
// will not have. See lib/encryption-key.ts.
try {
  const k = ensureEncryptionKey();
  if (k.generated) console.log(`Generated ENCRYPTION_KEY and saved it to ${k.savedTo}`);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

import http from 'node:http';
import { app } from './app.js';
import { logger } from './lib/logger.js';
import { loadModules } from './modules/registry.js';
import { handleConsoleUpgrade } from './routes/console.routes.js';
import { handleIdeUpgrade } from './services/ide-proxy.service.js';
import { startScheduler } from './services/scheduler.service.js';
import { reconcileInterruptedPassthroughApplies } from './services/passthrough-request.service.js';
import { runGuestMarkerBackfill } from './services/vm.service.js';

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

// One upgrade dispatcher for every WebSocket transport: the console relay claims
// /console + /serial, the IDE proxy claims /api/ide/:id/proxy, and anything else
// is rejected. Each handler returns true once it takes ownership of the socket.
server.on('upgrade', (req, socket, head) => {
  if (handleConsoleUpgrade(req, socket, head)) return;
  if (handleIdeUpgrade(req, socket, head)) return;
  socket.destroy();
});

// Optional module routers (see src/modules/). A no-op unless PROXMATE_MODULES names
// one. Runs BEFORE listen on purpose: a named-but-broken module must stop the boot
// rather than 404 on an already-open port, where the container looks healthy and a
// paid-for feature is simply absent. Recovery is config-only — unset PROXMATE_MODULES.
try {
  await loadModules();
} catch (err) {
  logger.error({ err }, 'module loading failed - refusing to start (unset PROXMATE_MODULES to boot without modules)');
  process.exit(1);
}

server.listen(PORT, BIND_ADDR, () => {
  logger.info({ port: PORT, bind: BIND_ADDR, env: process.env.NODE_ENV || 'development' }, `ProxMate API running on http://${BIND_ADDR}:${PORT}`);
  startScheduler();
  // Recover any passthrough approval that was mid-flight when the process last
  // stopped (a long disk relocation can outlast a deploy). Best-effort.
  void reconcileInterruptedPassthroughApplies().catch((err) =>
    logger.error({ err }, 'passthrough startup reconcile failed'),
  );
  // Tag guests created before ProxMate's ownership tag existed (idempotent; only
  // unambiguous matches are tagged, the rest are listed for an admin). The
  // scheduler repeats this until a pass completes without a Proxmox error.
  void runGuestMarkerBackfill()
    .then((r) => logger.info(r, 'guest ownership tag backfill done'))
    .catch((err) => logger.error({ err }, 'guest ownership tag backfill failed'));
});
