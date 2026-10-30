import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { Sequelize } from 'sequelize';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { initModels } from '../../src/models/index.js';
import { createAuthService } from '../../src/services/auth.service.js';
import { createTokenRevocationList } from '../../src/services/tokenRevocation.js';
import { createTokenService } from '../../src/utils/jwt.js';
import { silentLogger } from '../../src/utils/logger.js';

export const TEST_ORIGIN = 'http://localhost:5173';

export const TEST_ENV = Object.freeze({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test_user:test_password@localhost:5432/edtech_test',
  DATABASE_SSL_MODE: 'disable',
  JWT_SECRET: 'test-only-secret-that-is-long-enough-1234567890',
  FRONTEND_URL: TEST_ORIGIN,
  // Minimum allowed work factor keeps the dummy-hash comparison fast in tests.
  BCRYPT_SALT_ROUNDS: '10',
});

/** Test-only credentials; never used outside the test suite. */
export const TEST_ADMIN = Object.freeze({
  id: '0b6f3c1e-8d2a-4c51-9e47-3a1f5c2b7d90',
  email: 'admin@example.com',
  password: 'test-only correct horse battery',
});

const TEST_ADMIN_HASH = bcrypt.hashSync(TEST_ADMIN.password, 4);

/** In-memory stand-in for createAdminRepository(Admin). */
export function createInMemoryAdmins(
  admins = [{ id: TEST_ADMIN.id, email: TEST_ADMIN.email, passwordHash: TEST_ADMIN_HASH }],
) {
  const byId = new Map(admins.map((admin) => [admin.id, admin]));
  return {
    async findByEmailWithPassword(email) {
      return [...byId.values()].find((admin) => admin.email === email) ?? null;
    },
    async findById(id) {
      const admin = byId.get(id);
      return admin ? { id: admin.id, email: admin.email } : null;
    },
    remove(id) {
      byId.delete(id);
    },
  };
}

/** An inquiry service that fails loudly if a test forgets to stub it. */
export const unstubbedInquiryService = Object.freeze(
  Object.fromEntries(
    [
      'createInquiry',
      'listInquiries',
      'getInquiryStats',
      'exportInquiries',
      'getInquiry',
      'addNote',
      'updateInquiryWorkflow',
      'updateInquiryStatus',
      'getAssignableAdmins',
    ].map((name) => [
      name,
      async () => {
        throw new Error(`inquiryService.${name} was not stubbed for this test`);
      },
    ]),
  ),
);

/** The real auth service (bcrypt, JWT, revocation) over in-memory admins. */
export function buildAuthKit(config, admins = createInMemoryAdmins()) {
  const tokenService = createTokenService(config.jwt);
  const revocationList = createTokenRevocationList();
  const authService = createAuthService({
    admins,
    tokenService,
    revocationList,
    bcryptRounds: config.auth.bcryptRounds,
  });
  return { admins, tokenService, revocationList, authService };
}

/**
 * App with real middleware and real auth; the inquiry service is stubbed
 * unless given. Returns the config and auth kit for tests that need them.
 */
export function buildTestAppWithKit({
  env = {},
  checkDatabase = async () => {},
  logger = silentLogger,
  services = {},
  admins,
} = {}) {
  const config = loadConfig({ ...TEST_ENV, ...env });
  const kit = buildAuthKit(config, admins);
  const app = createApp({
    config,
    logger,
    checkDatabase,
    services: {
      inquiryService: unstubbedInquiryService,
      authService: kit.authService,
      ...services,
    },
  });
  return { app, config, kit };
}

export function buildTestApp(options) {
  return buildTestAppWithKit(options).app;
}

/** Signs a token with arbitrary claims/options, for forging test cases. */
export function signTestToken(config, payload, { secret = config.jwt.secret, ...options } = {}) {
  return jwt.sign(payload, secret, {
    algorithm: 'HS256',
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
    expiresIn: '1h',
    ...options,
  });
}

/** Models on a Sequelize instance that never connects (definition/validation tests only). */
export function buildOfflineModels() {
  const sequelize = new Sequelize('postgres://offline:offline@127.0.0.1:1/offline', {
    dialect: 'postgres',
    dialectModule: pg,
    logging: false,
  });
  return { sequelize, ...initModels(sequelize) };
}

export function captureLogger() {
  const entries = [];
  const record = (level) => (message, meta) => entries.push({ level, message, meta });
  return {
    entries,
    logger: {
      error: record('error'),
      warn: record('warn'),
      info: record('info'),
      debug: record('debug'),
    },
  };
}
