import { createApp } from './app.js';
import { createDatabase } from './config/database.js';
import { collectStartupWarnings } from './config/startupWarnings.js';
import { ConfigError, loadConfig, loadDotenv } from './config/env.js';
import { createAdminRepository } from './services/admin.repository.js';
import { createAuthService } from './services/auth.service.js';
import { createInquiryService } from './services/inquiry.service.js';
import { createTokenRevocationList } from './services/tokenRevocation.js';
import { createTokenService } from './utils/jwt.js';
import { createLogger } from './utils/logger.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function loadConfigOrExit() {
  loadDotenv();
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\nSee .env.example for every supported variable.\n`);
      process.exit(1);
    }
    throw err;
  }
}

async function main() {
  const config = loadConfigOrExit();
  const logger = createLogger({
    level: config.logLevel,
    format: config.isProduction ? 'json' : 'pretty',
  });

  for (const warning of collectStartupWarnings(config)) logger.warn(warning);

  const db = createDatabase(config.database, { logger, logQueries: config.logLevel === 'debug' });

  try {
    await db.connectWithRetry();
  } catch {
    // connectWithRetry has already logged the cause and a hint.
    logger.error('Exiting: the API cannot start without a database connection');
    await db.close().catch(() => {});
    process.exit(1);
  }

  const services = {
    inquiryService: createInquiryService({
      sequelize: db.sequelize,
      Inquiry: db.models.Inquiry,
      InquiryNote: db.models.InquiryNote,
      InquiryActivity: db.models.InquiryActivity,
      Admin: db.models.Admin,
      duplicateWindowMs: config.inquiries.duplicateWindowMs,
    }),
    authService: createAuthService({
      admins: createAdminRepository(db.models.Admin),
      tokenService: createTokenService(config.jwt),
      revocationList: createTokenRevocationList(),
      bcryptRounds: config.auth.bcryptRounds,
    }),
  };
  const app = createApp({
    config,
    logger,
    checkDatabase: () => db.checkConnection(),
    services,
  });
  const server = app.listen(config.port, () => {
    logger.info(`API listening on port ${config.port}`, { env: config.env });
  });

  server.on('error', async (err) => {
    logger.error(
      err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use` : 'HTTP server error',
      { err },
    );
    await db.close().catch(() => {});
    process.exit(1);
  });

  let shuttingDown = false;
  async function shutdown(signal, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down`);

    const force = setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();

    server.close(async () => {
      await db.close().catch((err) => logger.error('Error closing database pool', { err }));
      clearTimeout(force);
      process.exit(exitCode);
    });
    server.closeIdleConnections();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', {
      err: reason instanceof Error ? reason : new Error(String(reason)),
    });
    shutdown('unhandledRejection', 1);
  });
}

main().catch((err) => {
  process.stderr.write(`Fatal startup error: ${err?.stack ?? err}\n`);
  process.exit(1);
});
