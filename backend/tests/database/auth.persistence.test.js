// Admin creation, password storage and the full cookie session flow against
// an isolated in-process PostgreSQL (PGlite) with schema.sql applied: real
// app, real Sequelize models, real `pg` driver, real bcrypt and JWT.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase } from '../../src/config/database.js';
import { BACKEND_ROOT, loadConfig } from '../../src/config/env.js';
import { createAdminRepository } from '../../src/services/admin.repository.js';
import { createAdminAccount } from '../../src/services/admin.service.js';
import { createAuthService } from '../../src/services/auth.service.js';
import { createInquiryService } from '../../src/services/inquiry.service.js';
import { createTokenRevocationList } from '../../src/services/tokenRevocation.js';
import { createTokenService } from '../../src/utils/jwt.js';
import { silentLogger } from '../../src/utils/logger.js';
import { TEST_ENV, TEST_ORIGIN } from '../helpers/testApp.js';

const schemaSql = fs.readFileSync(path.join(BACKEND_ROOT, '..', 'schema.sql'), 'utf8');
const PASSWORD = 'test-only quiet river lantern';

let pglite;
let socketServer;
let db;
let databaseUrl;

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.exec(schemaSql);
  socketServer = new PGLiteSocketServer({ db: pglite, port: 0, maxConnections: 4 });
  await socketServer.start();
  databaseUrl = `postgresql://postgres:postgres@${socketServer.getServerConn()}/postgres`;
  db = createDatabase({ url: databaseUrl, sslMode: 'disable', poolMax: 2, connectRetries: 0 });
  await db.connectWithRetry({ retries: 0 });
});

afterAll(async () => {
  await db?.close();
  await socketServer?.stop();
  await pglite?.close();
});

beforeEach(async () => {
  await pglite.exec('DELETE FROM public.admins; DELETE FROM public.inquiries;');
});

const adminRows = async () => (await pglite.query('SELECT * FROM public.admins')).rows;

describe('createAdminAccount', () => {
  it('stores only a bcrypt hash (cost 12) in admins.password_hash', async () => {
    const admin = await createAdminAccount({
      Admin: db.models.Admin,
      email: '  Principal@School.org ',
      password: PASSWORD,
      saltRounds: 12,
    });

    expect(admin).toEqual({ id: expect.any(String), email: 'principal@school.org' });
    const [row] = await adminRows();
    expect(Object.keys(row).sort()).toEqual(['created_at', 'email', 'id', 'password_hash']);
    expect(row.email).toBe('principal@school.org');
    expect(row.password_hash).toMatch(/^\$2b\$12\$[./A-Za-z0-9]{53}$/);
    expect(row.password_hash).not.toContain(PASSWORD);
    expect(await bcrypt.compare(PASSWORD, row.password_hash)).toBe(true);
    expect(JSON.stringify(admin)).not.toContain(row.password_hash);
  });

  it('rejects a duplicate email, case-insensitively', async () => {
    const create = (email) =>
      createAdminAccount({ Admin: db.models.Admin, email, password: PASSWORD, saltRounds: 10 });
    await create('principal@school.org');

    await expect(create('PRINCIPAL@school.org')).rejects.toMatchObject({
      status: 409,
      code: 'ADMIN_EXISTS',
    });
    expect(await adminRows()).toHaveLength(1);
  });

  it('lets the UNIQUE constraint settle concurrent creations', async () => {
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        createAdminAccount({
          Admin: db.models.Admin,
          email: 'race@school.org',
          password: PASSWORD,
          saltRounds: 10,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason.code).toBe('ADMIN_EXISTS');
    expect(await adminRows()).toHaveLength(1);
  });

  it.each([
    ['not-an-email', PASSWORD, /valid email/],
    ['ok@school.org', 'short', /at least 12/],
    ['ok@school.org', 'password1234', /too common/],
  ])('rejects invalid input (%s) without writing anything', async (email, password, expected) => {
    const error = await createAdminAccount({
      Admin: db.models.Admin,
      email,
      password,
      saltRounds: 10,
    }).catch((err) => err);
    expect(error.code).toBe('INVALID_ADMIN_INPUT');
    expect(error.details.map((d) => d.message).join(' ')).toMatch(expected);
    expect(await adminRows()).toHaveLength(0);
  });
});

describe('scripts/createAdmin.js', () => {
  function runScript(args, env) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['scripts/createAdmin.js', ...args], {
        cwd: BACKEND_ROOT,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'development',
          DATABASE_URL: databaseUrl,
          DATABASE_SSL_MODE: 'disable',
          BCRYPT_SALT_ROUNDS: '10',
          ...env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      child.stdin.end(env.STDIN ?? '');
      child.on('close', (code) => resolve({ code, output }));
    });
  }

  it('creates an admin from the environment without printing secrets', async () => {
    const { code, output } = await runScript([], {
      ADMIN_EMAIL: 'ops@school.org',
      ADMIN_PASSWORD: PASSWORD,
    });

    expect(code).toBe(0);
    expect(output).toContain('Admin created: ops@school.org');
    const [row] = await adminRows();
    expect(output).not.toContain(PASSWORD);
    expect(output).not.toContain(row.password_hash);
    expect(output).not.toContain(row.password_hash.slice(7, 29)); // the salt
  });

  it('reads the password from a pipe when not interactive', async () => {
    const { code } = await runScript(['--email', 'pipe@school.org'], { STDIN: `${PASSWORD}\n` });
    expect(code).toBe(0);
    expect((await adminRows())[0].email).toBe('pipe@school.org');
  });

  it('exits non-zero for a duplicate email', async () => {
    const env = { ADMIN_EMAIL: 'ops@school.org', ADMIN_PASSWORD: PASSWORD };
    await runScript([], env);
    const { code, output } = await runScript([], env);
    expect(code).toBe(1);
    expect(output).toContain('already exists');
    expect(await adminRows()).toHaveLength(1);
  });

  it('exits non-zero for a weak password and does not echo it', async () => {
    const { code, output } = await runScript([], {
      ADMIN_EMAIL: 'ops@school.org',
      ADMIN_PASSWORD: 'tooshort',
    });
    expect(code).toBe(1);
    expect(output).toContain('at least 12 characters');
    expect(output).not.toContain('tooshort');
    expect(await adminRows()).toHaveLength(0);
  });

  it('refuses a password passed as a command-line argument', async () => {
    const { code, output } = await runScript(
      ['--email', 'ops@school.org', '--password', PASSWORD],
      {},
    );
    expect(code).toBe(1);
    expect(output).toContain('Refusing --password');
    expect(output).not.toContain(PASSWORD);
    expect(await adminRows()).toHaveLength(0);
  });
});

describe('session flow against PostgreSQL', () => {
  function buildApp() {
    const config = loadConfig({ ...TEST_ENV, INQUIRY_RATE_LIMIT_MAX: '1000' });
    return createApp({
      config,
      logger: silentLogger,
      checkDatabase: () => db.checkConnection(),
      services: {
        inquiryService: createInquiryService({
          sequelize: db.sequelize,
          Inquiry: db.models.Inquiry,
          InquiryNote: db.models.InquiryNote,
          InquiryActivity: db.models.InquiryActivity,
          Admin: db.models.Admin,
          duplicateWindowMs: 0,
        }),
        authService: createAuthService({
          admins: createAdminRepository(db.models.Admin),
          tokenService: createTokenService(config.jwt),
          revocationList: createTokenRevocationList(),
          bcryptRounds: config.auth.bcryptRounds,
        }),
      },
    });
  }

  it('login → protected inquiry data → status update → logout → 401', async () => {
    await createAdminAccount({
      Admin: db.models.Admin,
      email: 'ops@school.org',
      password: PASSWORD,
      saltRounds: 10,
    });
    const app = buildApp();
    const submitted = await request(app).post('/api/inquiries').send({
      name: 'Ravi Kumar',
      email: 'ravi@example.org',
      phone: '+1 (555) 010-0000',
      userType: 'Student',
      category: 'Scholarship',
      message: 'Is the merit scholarship open to everyone?',
    });
    const inquiryId = submitted.body.data.id;

    // Anonymous: no records.
    expect((await request(app).get('/api/inquiries')).status).toBe(401);

    // Wrong password: generic error.
    const wrong = await request(app)
      .post('/api/auth/login')
      .set('Origin', TEST_ORIGIN)
      .send({ email: 'ops@school.org', password: 'not the password at all' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');

    const agent = request.agent(app);
    const login = await agent
      .post('/api/auth/login')
      .set('Origin', TEST_ORIGIN)
      .send({ email: 'OPS@school.org', password: PASSWORD });
    expect(login.status).toBe(200);
    expect(JSON.stringify(login.body)).not.toMatch(/password|\$2b\$/i);

    const me = await agent.get('/api/auth/me');
    expect(me.body.data.admin).toMatchObject({ email: 'ops@school.org', role: 'admin' });
    expect(JSON.stringify(me.body)).not.toMatch(/passwordHash|password_hash|\$2b\$/);

    const list = await agent.get('/api/inquiries');
    expect(list.status).toBe(200);
    expect(list.body.meta).toMatchObject({ page: 1, pageSize: 20, total: 1, totalPages: 1 });
    expect(list.body.data[0]).toMatchObject({ id: inquiryId, status: 'New', userType: 'Student' });

    const updated = await agent
      .patch(`/api/inquiries/${inquiryId}/status`)
      .set('Origin', TEST_ORIGIN)
      .send({ status: 'In Progress' });
    expect(updated.status).toBe(200);
    const [row] = (await pglite.query('SELECT status, created_at, updated_at FROM inquiries')).rows;
    expect(row.status).toBe('In Progress');
    expect(row.updated_at.getTime()).toBeGreaterThanOrEqual(row.created_at.getTime());

    const missing = await agent.get('/api/inquiries/00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);

    expect((await agent.post('/api/auth/logout').set('Origin', TEST_ORIGIN)).status).toBe(200);
    const afterLogout = await agent.get('/api/inquiries');
    expect(afterLogout.status).toBe(401);
    expect(afterLogout.body).not.toHaveProperty('data');
  });

  it('revokes access immediately when the admin row is deleted', async () => {
    await createAdminAccount({
      Admin: db.models.Admin,
      email: 'temp@school.org',
      password: PASSWORD,
      saltRounds: 10,
    });
    const agent = request.agent(buildApp());
    await agent
      .post('/api/auth/login')
      .set('Origin', TEST_ORIGIN)
      .send({ email: 'temp@school.org', password: PASSWORD });
    expect((await agent.get('/api/inquiries')).status).toBe(200);

    await pglite.exec("DELETE FROM public.admins WHERE email = 'temp@school.org'");
    const res = await agent.get('/api/inquiries');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });
});
