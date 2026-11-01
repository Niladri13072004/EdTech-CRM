#!/usr/bin/env node
// Local development without Supabase. Starts an in-memory PostgreSQL (PGlite:
// the real PostgreSQL engine compiled to WebAssembly) with ../schema.sql
// applied, serves it over the Postgres wire protocol on 127.0.0.1, then runs
// the normal API (src/server.js) against it.
//
// Everything is lost when the process stops. Development only: refuses to
// run with NODE_ENV=production, and its dependency is a devDependency.
//
// Usage (from backend/):  npm run dev:memory

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { BACKEND_ROOT, loadDotenv } from '../src/config/env.js';

loadDotenv();

if (process.env.NODE_ENV === 'production') {
  process.stderr.write('dev:memory is for local development only (NODE_ENV=production).\n');
  process.exit(1);
}

const port = Number(process.env.MEMORY_DB_PORT ?? 54329);
const db = new PGlite();
await db.exec(await fs.readFile(path.join(BACKEND_ROOT, '..', 'schema.sql'), 'utf8'));

const socketServer = new PGLiteSocketServer({ db, host: '127.0.0.1', port, maxConnections: 8 });
try {
  await socketServer.start();
} catch (err) {
  process.stderr.write(
    `Could not listen on 127.0.0.1:${port} (${err.code}). Set MEMORY_DB_PORT.\n`,
  );
  process.exit(1);
}

const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
Object.assign(process.env, {
  NODE_ENV: 'development',
  DATABASE_URL: databaseUrl,
  DATABASE_SSL_MODE: 'disable',
  DATABASE_CONNECT_RETRIES: '0',
});
// Browsers may reach the same local Vite server through either hostname.
// Allow both exact origins in memory mode to avoid a confusing CORS failure
// when the browser address uses 127.0.0.1 but the default uses localhost.
const configuredFrontendOrigins = (process.env.FRONTEND_URL ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
process.env.FRONTEND_URL = [
  ...new Set(['http://localhost:5173', 'http://127.0.0.1:5173', ...configuredFrontendOrigins]),
].join(',');

const secret = process.env.JWT_SECRET ?? '';
const ephemeralSecret = secret.length < 32 || secret.startsWith('replace-with');
if (ephemeralSecret) process.env.JWT_SECRET = randomBytes(48).toString('base64url');

process.stdout.write(
  [
    '',
    '  In-memory PostgreSQL (PGlite) ready — schema.sql applied, data is NOT persisted.',
    `  Database: 127.0.0.1:${port}`,
    ephemeralSecret ? '  JWT_SECRET: random for this run (sessions end when it stops).' : '',
    '',
    '  Create an admin in another terminal (from backend/):',
    `    DATABASE_URL=${databaseUrl} DATABASE_SSL_MODE=disable npm run admin:create`,
    '',
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n') + '\n',
);

process.on('exit', () => {
  socketServer.stop().catch(() => {});
});

await import('../src/server.js');
