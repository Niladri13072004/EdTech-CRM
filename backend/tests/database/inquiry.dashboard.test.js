// Admin inquiry listing, filtering, search, pagination and status updates
// through the real app, auth, Sequelize and `pg` driver, against an isolated
// in-process PostgreSQL (PGlite) with schema.sql applied. Expected results are
// computed from the seed data in JavaScript and compared with the API's.

import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase } from '../../src/config/database.js';
import { BACKEND_ROOT, loadConfig } from '../../src/config/env.js';
import { CATEGORIES, INQUIRY_STATUSES, USER_TYPES } from '../../src/constants/inquiry.js';
import { createAdminRepository } from '../../src/services/admin.repository.js';
import { createAdminAccount } from '../../src/services/admin.service.js';
import { createAuthService } from '../../src/services/auth.service.js';
import { createInquiryService, LIST_ATTRIBUTES } from '../../src/services/inquiry.service.js';
import { UTF8_BOM } from '../../src/utils/csv.js';
import { parseCsv } from '../helpers/csv.js';
import { createTokenRevocationList } from '../../src/services/tokenRevocation.js';
import { createTokenService } from '../../src/utils/jwt.js';
import { silentLogger } from '../../src/utils/logger.js';
import { TEST_ENV, TEST_ORIGIN } from '../helpers/testApp.js';

const schemaSql = fs.readFileSync(path.join(BACKEND_ROOT, '..', 'schema.sql'), 'utf8');
const PASSWORD = 'test-only dashboard passphrase';
const BASE_TIME = Date.parse('2026-10-01T12:00:00Z');

const SPECIAL = [
  { name: 'Asha Verma', phone: '+91 98765-43210' },
  { name: 'ASHA Patel', phone: '+44 20 7946 0958' },
  { name: 'Ravi Kumar', phone: '+1 (555) 010-0000' },
  { name: 'Meera Iyer', phone: '020 7946 0001' },
  { name: 'Priya_Shah', phone: '+65 6123 4567' },
];

// 26 inquiries; index 0 is the newest. Types and categories rotate so every
// value appears and combinations are uneven.
const SEED = Array.from({ length: 26 }, (_, i) => ({
  name: SPECIAL[i]?.name ?? `Learner ${String(i).padStart(2, '0')}`,
  email: `person${i}@example.org`,
  phone: SPECIAL[i]?.phone ?? `+61 2 9000 ${String(1000 + i)}`,
  userType: USER_TYPES[i % 3],
  category: CATEGORIES[i % 4],
  status: ['New', 'New', 'In Progress', 'Resolved'][i % 4],
  message: `Seeded inquiry number ${i} for dashboard tests.`,
  createdAt: new Date(BASE_TIME - i * 60_000),
}));

let pglite;
let socketServer;
let db;
let app;
let agent;

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.exec(schemaSql);
  for (const row of SEED) {
    const { rows } = await pglite.query(
      `INSERT INTO public.inquiries (name, email, phone, user_type, category, status, message, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING id`,
      [
        row.name,
        row.email,
        row.phone,
        row.userType,
        row.category,
        row.status,
        row.message,
        row.createdAt,
      ],
    );
    row.id = rows[0].id;
  }

  socketServer = new PGLiteSocketServer({ db: pglite, port: 0, maxConnections: 4 });
  await socketServer.start();
  db = createDatabase({
    url: `postgresql://postgres:postgres@${socketServer.getServerConn()}/postgres`,
    sslMode: 'disable',
    poolMax: 3,
    connectRetries: 0,
  });
  await db.connectWithRetry({ retries: 0 });

  const config = loadConfig(TEST_ENV);
  app = createApp({
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

  await createAdminAccount({
    Admin: db.models.Admin,
    email: 'ops@school.org',
    password: PASSWORD,
    saltRounds: 10,
  });
  agent = request.agent(app);
  const login = await agent
    .post('/api/auth/login')
    .set('Origin', TEST_ORIGIN)
    .send({ email: 'ops@school.org', password: PASSWORD });
  expect(login.status).toBe(200);
});

afterAll(async () => {
  await db?.close();
  await socketServer?.stop();
  await pglite?.close();
});

/** All matching ids, newest first, through the API (follows every page). */
async function idsFor(query) {
  const res = await agent.get('/api/inquiries').query({ pageSize: 100, ...query });
  expect(res.status).toBe(200);
  expect(res.body.meta.total).toBe(res.body.data.length);
  return res.body.data.map((row) => row.id);
}

const expectedIds = (predicate) => SEED.filter(predicate).map((row) => row.id);

describe('GET /api/inquiries — authentication', () => {
  it('rejects unauthenticated requests without returning data', async () => {
    const res = await request(app).get('/api/inquiries');
    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty('data');
  });

  it('lists the first 20 for a signed-in admin, newest first, with totals', async () => {
    const res = await agent.get('/api/inquiries');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(20);
    expect(res.body.data.map((row) => row.id)).toEqual(SEED.slice(0, 20).map((row) => row.id));
    expect(res.body.meta).toMatchObject({
      page: 1,
      pageSize: 20,
      total: 26,
      totalPages: 2,
      hasPreviousPage: false,
      hasNextPage: true,
      sort: { by: 'createdAt', direction: 'desc' },
    });
    expect(Object.keys(res.body.data[0]).sort()).toEqual([...LIST_ATTRIBUTES].sort());
    expect(res.body.data[0]).toMatchObject({
      name: 'Asha Verma',
      phone: '+91 98765-43210',
      userType: 'Parent',
      category: 'Scholarship',
      status: 'New',
      createdAt: '2026-10-01T12:00:00.000Z',
    });
  });
});

describe('GET /api/inquiries — filters and search', () => {
  it.each(CATEGORIES)('filters by category %s', async (category) => {
    const ids = await idsFor({ category });
    expect(ids).toEqual(expectedIds((row) => row.category === category));
    expect(ids.length).toBeGreaterThan(0);
  });

  it.each(USER_TYPES)('filters by user type %s', async (userType) => {
    const ids = await idsFor({ userType });
    expect(ids).toEqual(expectedIds((row) => row.userType === userType));
    expect(ids.length).toBeGreaterThan(0);
  });

  it('searches names case-insensitively and by part of the name', async () => {
    expect(await idsFor({ search: 'asha' })).toEqual(expectedIds((row) => /asha/i.test(row.name)));
    expect(await idsFor({ search: 'asha' })).toHaveLength(2);
    expect(await idsFor({ search: 'ERMA' })).toEqual(
      expectedIds((row) => row.name === 'Asha Verma'),
    );
  });

  it('searches phone numbers as typed', async () => {
    expect(await idsFor({ search: '98765-43210' })).toEqual(
      expectedIds((row) => row.name === 'Asha Verma'),
    );
    expect(await idsFor({ search: '7946' })).toEqual(
      expectedIds((row) => row.phone.includes('7946')),
    );
  });

  it('searches phone numbers regardless of spaces, dashes and brackets', async () => {
    expect(await idsFor({ search: '98765 43210' })).toEqual(
      expectedIds((row) => row.name === 'Asha Verma'),
    );
    expect(await idsFor({ search: '5550100000' })).toEqual(
      expectedIds((row) => row.name === 'Ravi Kumar'),
    );
  });

  it('combines category, user type and search', async () => {
    const query = { category: 'Scholarship', userType: 'Parent', search: 'learner' };
    const ids = await idsFor(query);
    expect(ids).toEqual(
      expectedIds(
        (row) =>
          row.category === 'Scholarship' && row.userType === 'Parent' && /learner/i.test(row.name),
      ),
    );
    expect(ids.length).toBeGreaterThan(0);
  });

  it('returns an empty page (not an error) when nothing matches', async () => {
    const res = await agent.get('/api/inquiries').query({ search: 'nobody-by-this-name' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta).toMatchObject({ total: 0, totalPages: 0, hasNextPage: false });
  });

  it('treats LIKE wildcards in the search literally', async () => {
    expect(await idsFor({ search: '%' })).toEqual([]);
    expect(await idsFor({ search: '_' })).toEqual(expectedIds((row) => row.name === 'Priya_Shah'));
  });

  it('is not vulnerable to SQL injection through search', async () => {
    expect(await idsFor({ search: "'; DELETE FROM inquiries; --" })).toEqual([]);
    expect(await idsFor({ search: "x' OR '1'='1" })).toEqual([]);
    const { rows } = await pglite.query('SELECT count(*)::int AS n FROM public.inquiries');
    expect(rows[0].n).toBe(26);
  });

  it.each([
    [{ category: 'Sports' }, 'category'],
    [{ userType: 'Teacher' }, 'userType'],
    [{ sortBy: 'email' }, 'sortBy'],
    [{ pageSize: 500 }, 'pageSize'],
  ])('rejects the invalid parameter %o with 400', async (query, field) => {
    const res = await agent.get('/api/inquiries').query(query);
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe(field);
  });
});

describe('GET /api/inquiries — pagination and sorting', () => {
  it('pages through a filtered result without losing the filter', async () => {
    const filter = { userType: 'Student' };
    const expected = expectedIds((row) => row.userType === 'Student');
    const seen = [];
    let page = 1;
    let meta;
    do {
      const res = await agent.get('/api/inquiries').query({ ...filter, pageSize: 3, page });
      expect(res.status).toBe(200);
      meta = res.body.meta;
      expect(meta.total).toBe(expected.length);
      expect(res.body.data.every((row) => row.userType === 'Student')).toBe(true);
      seen.push(...res.body.data.map((row) => row.id));
      page += 1;
    } while (meta.hasNextPage);

    expect(seen).toEqual(expected);
    expect(meta.totalPages).toBe(Math.ceil(expected.length / 3));
    expect(meta.hasPreviousPage).toBe(true);
  });

  it('pages through combined filters and search', async () => {
    const filter = { category: 'Scholarship', search: 'learner' };
    const expected = expectedIds(
      (row) => row.category === 'Scholarship' && /learner/i.test(row.name),
    );
    const first = await agent.get('/api/inquiries').query({ ...filter, pageSize: 2, page: 1 });
    const second = await agent.get('/api/inquiries').query({ ...filter, pageSize: 2, page: 2 });
    expect([...first.body.data, ...second.body.data].map((row) => row.id)).toEqual(
      expected.slice(0, 4),
    );
    expect(second.body.meta).toMatchObject({ total: expected.length, page: 2 });
  });

  it('returns the remaining records on the last page and nothing beyond it', async () => {
    const last = await agent.get('/api/inquiries').query({ page: 2 });
    expect(last.body.data.map((row) => row.id)).toEqual(SEED.slice(20).map((row) => row.id));
    expect(last.body.meta).toMatchObject({ hasNextPage: false, hasPreviousPage: true });

    const beyond = await agent.get('/api/inquiries').query({ page: 3 });
    expect(beyond.status).toBe(200);
    expect(beyond.body.data).toEqual([]);
    expect(beyond.body.meta.total).toBe(26);
  });

  it('sorts by a whitelisted field in either direction', async () => {
    const oldest = await agent.get('/api/inquiries').query({ sortDir: 'asc', pageSize: 100 });
    expect(oldest.body.data.map((row) => row.id)).toEqual([...SEED].reverse().map((row) => row.id));

    const byStatus = await agent
      .get('/api/inquiries')
      .query({ sortBy: 'status', sortDir: 'asc', pageSize: 100 });
    const statuses = byStatus.body.data.map((row) => row.status);
    expect(statuses).toEqual([...statuses].sort());
  });
});

const countWhere = (predicate) => SEED.filter(predicate).length;

describe('GET /api/inquiries/stats', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/inquiries/stats');
    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty('data');
  });

  it('returns totals aggregated in the database, zero-filled for every value', async () => {
    const res = await agent.get('/api/inquiries/stats');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toEqual({
      total: SEED.length,
      byStatus: Object.fromEntries(
        INQUIRY_STATUSES.map((status) => [status, countWhere((row) => row.status === status)]),
      ),
      byCategory: Object.fromEntries(
        CATEGORIES.map((category) => [category, countWhere((row) => row.category === category)]),
      ),
    });
  });

  it('returns only numbers, never inquiry records', async () => {
    const res = await agent.get('/api/inquiries/stats');
    expect(JSON.stringify(res.body)).not.toMatch(/@example\.org|Asha|Learner/);
  });

  it('rejects parameters', async () => {
    expect((await agent.get('/api/inquiries/stats?category=Concert')).status).toBe(400);
  });
});

describe('GET /api/inquiries/export', () => {
  async function exportCsv(query = {}) {
    const res = await agent
      .get('/api/inquiries/export')
      .query(query)
      .buffer(true)
      .parse((r, cb) => {
        let data = '';
        r.setEncoding('utf8');
        r.on('data', (chunk) => (data += chunk));
        r.on('end', () => cb(null, data));
      });
    return { res, rows: res.status === 200 ? parseCsv(res.body) : null };
  }

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/inquiries/export');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('downloads every inquiry as CSV, newest first, with a header row', async () => {
    const { res, rows } = await exportCsv();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="inquiries-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-export-row-count']).toBe(String(SEED.length));
    expect(res.body.startsWith(UTF8_BOM)).toBe(true);

    const [header, ...data] = rows;
    expect(header).toEqual([
      'Name',
      'Phone',
      'Email',
      'User Type',
      'Category',
      'Status',
      'Submitted (UTC)',
      'Last updated (UTC)',
      'Message',
      'Reference ID',
    ]);
    expect(data.map((row) => row[9])).toEqual(SEED.map((row) => row.id));
    const asha = data[0];
    expect(asha).toEqual([
      'Asha Verma',
      "'+91 98765-43210",
      'person0@example.org',
      'Parent',
      'Scholarship',
      'New',
      '2026-10-01T12:00:00.000Z',
      '2026-10-01T12:00:00.000Z',
      'Seeded inquiry number 0 for dashboard tests.',
      SEED[0].id,
    ]);
  });

  it('respects the current filters, search and sort', async () => {
    const { rows } = await exportCsv({
      category: 'Scholarship',
      userType: 'Parent',
      search: 'learner',
      sortDir: 'asc',
    });
    const expected = SEED.filter(
      (row) =>
        row.category === 'Scholarship' && row.userType === 'Parent' && /learner/i.test(row.name),
    )
      .reverse()
      .map((row) => row.id);
    expect(rows.slice(1).map((row) => row[9])).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  it('matches the list endpoint for the same filters', async () => {
    const query = { userType: 'Student', search: '9000' };
    const list = await agent.get('/api/inquiries').query({ ...query, pageSize: 100 });
    const { rows } = await exportCsv(query);
    expect(rows.slice(1).map((row) => row[9])).toEqual(list.body.data.map((row) => row.id));
  });

  it('exports just the header when nothing matches', async () => {
    const { rows } = await exportCsv({ search: 'nobody-by-this-name' });
    expect(rows).toHaveLength(1);
  });

  it('neutralises spreadsheet formulas and escapes quotes, commas and line breaks', async () => {
    const { rows: inserted } = await pglite.query(
      `INSERT INTO public.inquiries (name, email, phone, user_type, category, message)
       VALUES ($1, 'formula@example.org', '+44 20 7946 0000', 'Parent', 'Concert', $2) RETURNING id`,
      ['=HYPERLINK("http://evil.example","Click")', '@SUM(1+1), then "quoted"\nand a second line'],
    );
    try {
      const { rows } = await exportCsv({ search: 'HYPERLINK' });
      expect(rows).toHaveLength(2);
      const [name, phone, , , , , , , message, id] = rows[1];
      expect(name).toBe(`'=HYPERLINK("http://evil.example","Click")`);
      expect(phone).toBe("'+44 20 7946 0000");
      expect(message).toBe(`'@SUM(1+1), then "quoted"\nand a second line`);
      expect(id).toBe(inserted[0].id);
    } finally {
      await pglite.query('DELETE FROM public.inquiries WHERE id = $1', [inserted[0].id]);
    }
  });

  it('never includes admin data, password hashes or tokens', async () => {
    const { res } = await exportCsv();
    const { rows } = await pglite.query('SELECT password_hash FROM public.admins');
    expect(res.body).not.toContain(rows[0].password_hash);
    expect(res.body).not.toMatch(/\$2[aby]\$|ops@school\.org|eyJ/);
  });

  it.each([
    [{ category: 'Sports' }, 'category'],
    [{ page: 2 }, ''],
    [{ sortBy: 'password_hash' }, 'sortBy'],
  ])('rejects the invalid parameter %o with 400', async (query) => {
    const res = await agent.get('/api/inquiries/export').query(query);
    expect(res.status).toBe(400);
  });

  it('refuses exports above the row limit instead of truncating them', async () => {
    const small = createInquiryService({
      sequelize: db.sequelize,
      Inquiry: db.models.Inquiry,
      InquiryNote: db.models.InquiryNote,
      InquiryActivity: db.models.InquiryActivity,
      Admin: db.models.Admin,
      duplicateWindowMs: 0,
      exportMaxRows: 5,
    });
    await expect(small.exportInquiries({})).rejects.toMatchObject({
      status: 422,
      code: 'EXPORT_TOO_LARGE',
    });
    await expect(small.exportInquiries({ search: 'asha' })).resolves.toHaveLength(2);
  });
});

describe('inquiry details, notes and follow-up', () => {
  const target = () => SEED[24];

  it('returns the complete detail with a synthetic received milestone', async () => {
    const res = await agent.get(`/api/inquiries/${target().id}`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: target().id, message: target().message });
    expect(res.body.data.notes).toEqual([]);
    expect(res.body.data.activities[0]).toMatchObject({
      type: 'received',
      summary: 'Inquiry received.',
    });
  });

  it('adds a note with the signed-in admin and records it in the timeline', async () => {
    const res = await agent
      .post(`/api/inquiries/${target().id}/notes`)
      .set('Origin', TEST_ORIGIN)
      .send({ body: 'Called the parent; discussed scholarship eligibility.' });
    expect(res.status).toBe(201);
    expect(res.body.data.body).toBe('Called the parent; discussed scholarship eligibility.');
    expect(res.body.data.admin.email).toBe('ops@school.org');

    const detail = await agent.get(`/api/inquiries/${target().id}`).set('Origin', TEST_ORIGIN);
    expect(detail.body.data.notes).toHaveLength(1);
    expect(detail.body.data.activities.some((item) => item.type === 'note')).toBe(true);
  });

  it('rejects an empty note and does not create an activity', async () => {
    const other = SEED[23];
    const res = await agent
      .post(`/api/inquiries/${other.id}/notes`)
      .set('Origin', TEST_ORIGIN)
      .send({ body: '   ' });
    expect(res.status).toBe(400);
    const detail = await agent.get(`/api/inquiries/${other.id}`).set('Origin', TEST_ORIGIN);
    expect(detail.body.data.notes).toHaveLength(0);
  });

  it('updates status, assignment, follow-up date and outcome with timeline entries', async () => {
    const admins = await agent.get('/api/inquiries/assignable-admins').set('Origin', TEST_ORIGIN);
    expect(admins.status).toBe(200);
    expect(admins.body.data.some((item) => item.email === 'ops@school.org')).toBe(true);

    const res = await agent.patch(`/api/inquiries/${target().id}`).set('Origin', TEST_ORIGIN).send({
      status: 'In Progress',
      followUpDate: '2026-11-02',
      followUpOutcome: 'Parent requested a callback.',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'In Progress', followUpDate: '2026-11-02' });
    expect(res.body.data.followUpOutcome).toBe('Parent requested a callback.');

    const types = res.body.data.activities.map((item) => item.type);
    expect(types).toEqual(expect.arrayContaining(['received', 'status', 'follow_up', 'outcome']));
  });

  it('rejects an unknown assignee and changes nothing', async () => {
    const res = await agent
      .patch(`/api/inquiries/${target().id}`)
      .set('Origin', TEST_ORIGIN)
      .send({ assignedAdminId: '00000000-0000-4000-8000-000000000000' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_ASSIGNEE');
  });
});
describe('PATCH /api/inquiries/:id/status', () => {
  const target = () => SEED[25];
  const statusOf = async (id) =>
    (
      await pglite.query(
        'SELECT status, created_at, updated_at FROM public.inquiries WHERE id = $1',
        [id],
      )
    ).rows[0];

  it('updates the status and the updated_at timestamp', async () => {
    const res = await agent
      .patch(`/api/inquiries/${target().id}/status`)
      .set('Origin', TEST_ORIGIN)
      .send({ status: 'Resolved' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { id: target().id, status: 'Resolved' },
    });
    const row = await statusOf(target().id);
    expect(row.status).toBe('Resolved');
    expect(row.updated_at.getTime()).toBeGreaterThan(row.created_at.getTime());

    const listed = await idsFor({ status: 'Resolved' });
    expect(listed).toContain(target().id);
  });

  it.each(['In Progress', 'New'])('accepts %s', async (status) => {
    const res = await agent
      .patch(`/api/inquiries/${target().id}/status`)
      .set('Origin', TEST_ORIGIN)
      .send({ status });
    expect(res.status).toBe(200);
    expect((await statusOf(target().id)).status).toBe(status);
  });

  it.each(['Closed', 'resolved', '', 'Resolved; DROP TABLE inquiries'])(
    'rejects the invalid status %j and leaves the row unchanged',
    async (status) => {
      const before = (await statusOf(target().id)).status;
      const res = await agent
        .patch(`/api/inquiries/${target().id}/status`)
        .set('Origin', TEST_ORIGIN)
        .send({ status });
      expect(res.status).toBe(400);
      expect((await statusOf(target().id)).status).toBe(before);
    },
  );

  it('returns 404 for an inquiry that does not exist', async () => {
    const res = await agent
      .patch('/api/inquiries/00000000-0000-4000-8000-000000000000/status')
      .set('Origin', TEST_ORIGIN)
      .send({ status: 'Resolved' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects unauthenticated updates and changes nothing', async () => {
    const before = (await statusOf(target().id)).status;
    const res = await request(app)
      .patch(`/api/inquiries/${target().id}/status`)
      .set('Origin', TEST_ORIGIN)
      .send({ status: before === 'Resolved' ? 'New' : 'Resolved' });
    expect(res.status).toBe(401);
    expect((await statusOf(target().id)).status).toBe(before);
  });

  it('rejects a cross-site update attempt (no trusted Origin) and changes nothing', async () => {
    const before = (await statusOf(target().id)).status;
    const res = await agent
      .patch(`/api/inquiries/${target().id}/status`)
      .send({ status: before === 'Resolved' ? 'New' : 'Resolved' });
    expect(res.status).toBe(403);
    expect((await statusOf(target().id)).status).toBe(before);
  });
});
