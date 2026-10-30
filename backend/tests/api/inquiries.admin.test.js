import { ConnectionRefusedError, DatabaseError } from 'sequelize';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ADMIN_ROLE } from '../../src/constants/auth.js';
import { buildTestAppWithKit, signTestToken, TEST_ADMIN, TEST_ORIGIN } from '../helpers/testApp.js';

const COOKIE = 'edtech_admin_session';
const ID = '6f1c3c1e-3f5b-4c8e-9a51-2b0b7f0e9d11';

const record = {
  id: ID,
  name: 'Asha Verma',
  email: 'asha@example.com',
  phone: '+91 98765 43210',
  userType: 'Parent',
  category: 'Admission',
  message: 'When does admission open?',
  status: 'New',
  createdAt: '2026-10-30T10:00:00.000Z',
  updatedAt: '2026-10-30T10:00:00.000Z',
};

function setup() {
  const inquiryService = {
    createInquiry: vi.fn(),
    listInquiries: vi.fn().mockResolvedValue({
      inquiries: [record],
      meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    }),
    getInquiry: vi.fn().mockResolvedValue(record),
    updateInquiryStatus: vi.fn().mockResolvedValue({ ...record, status: 'Resolved' }),
    getInquiryStats: vi.fn().mockResolvedValue({ total: 1, byStatus: {}, byCategory: {} }),
    exportInquiries: vi.fn().mockResolvedValue([]),
  };
  const kit = buildTestAppWithKit({ services: { inquiryService } });
  const token = kit.kit.tokenService.issue(TEST_ADMIN.id).token;
  return { ...kit, inquiryService, token };
}

const PROTECTED = [
  ['GET', `/api/inquiries`],
  ['GET', `/api/inquiries/stats`],
  ['GET', `/api/inquiries/export`],
  ['GET', `/api/inquiries/${ID}`],
  ['PATCH', `/api/inquiries/${ID}/status`],
];

function call(app, method, path, cookie) {
  let req = request(app)[method.toLowerCase()](path).set('Origin', TEST_ORIGIN);
  if (cookie !== undefined) req = req.set('Cookie', `${COOKIE}=${cookie}`);
  return method === 'PATCH' ? req.send({ status: 'Resolved' }) : req;
}

describe('unauthorized access to inquiry records', () => {
  const badTokens = {
    'no cookie': () => undefined,
    'an invalid signature': ({ token }) => `${token.slice(0, -3)}xyz`,
    'an expired token': ({ config }) =>
      signTestToken(
        config,
        { role: ADMIN_ROLE, jti: '9d2f0c5e-1b7a-4e3c-8f6d-2a4b6c8e0f12' },
        { subject: TEST_ADMIN.id, expiresIn: -1 },
      ),
    'a malformed token': () => 'not.a.jwt',
  };

  for (const [method, path] of PROTECTED) {
    for (const [label, makeToken] of Object.entries(badTokens)) {
      it(`${method} ${path.replace(ID, ':id')} with ${label} → 401 and no data`, async () => {
        const ctx = setup();
        const res = await call(ctx.app, method, path, makeToken(ctx));

        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
        expect(res.body).not.toHaveProperty('data');
        expect(JSON.stringify(res.body)).not.toContain('asha@example.com');
        expect(ctx.inquiryService.listInquiries).not.toHaveBeenCalled();
        expect(ctx.inquiryService.getInquiry).not.toHaveBeenCalled();
        expect(ctx.inquiryService.updateInquiryStatus).not.toHaveBeenCalled();
        expect(ctx.inquiryService.getInquiryStats).not.toHaveBeenCalled();
        expect(ctx.inquiryService.exportInquiries).not.toHaveBeenCalled();
      });
    }
  }

  it('also answers 401 for unknown admin paths instead of revealing what exists', async () => {
    const { app } = setup();
    expect((await request(app).get('/api/inquiries/export/all')).status).toBe(401);
  });

  it('keeps the public submission endpoint open', async () => {
    const { app, inquiryService } = setup();
    inquiryService.createInquiry.mockResolvedValue({ inquiry: { id: ID }, created: true });
    const res = await request(app).post('/api/inquiries').send({
      name: 'Asha Verma',
      email: 'asha@example.com',
      phone: '+91 98765 43210',
      userType: 'Parent',
      category: 'Admission',
      message: 'When does admission open?',
    });
    expect(res.status).toBe(201);
  });
});

describe('authorized access to inquiry records', () => {
  it('lists inquiries for a signed-in admin', async () => {
    const { app, token, inquiryService } = setup();
    const res = await call(app, 'GET', '/api/inquiries?page=2&pageSize=10', token);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: [record],
      meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    });
    expect(inquiryService.listInquiries).toHaveBeenCalledWith({
      page: 2,
      pageSize: 10,
      sortBy: 'createdAt',
      sortDir: 'desc',
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns one inquiry', async () => {
    const { app, token } = setup();
    const res = await call(app, 'GET', `/api/inquiries/${ID}`, token);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(record);
  });

  it('updates the status', async () => {
    const { app, token, inquiryService } = setup();
    const res = await call(app, 'PATCH', `/api/inquiries/${ID}/status`, token);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('Resolved');
    expect(inquiryService.updateInquiryStatus).toHaveBeenCalledWith(
      ID,
      'Resolved',
      expect.objectContaining({ id: TEST_ADMIN.id, email: TEST_ADMIN.email }),
    );
  });

  it.each([
    ['pageSize=500', 'pageSize'],
    ['page=0', 'page'],
    ['page=abc', 'page'],
    ['sort=name', 'sort'],
  ])('rejects the invalid query %s', async (query, field) => {
    const { app, token } = setup();
    const res = await call(app, 'GET', `/api/inquiries?${query}`, token);
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe(field);
  });

  it('rejects a non-UUID id', async () => {
    const { app, token } = setup();
    const res = await call(app, 'GET', '/api/inquiries/42', token);
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ field: 'id', message: 'id must be a valid UUID' }]);
  });

  it('passes through a 404 for an unknown inquiry', async () => {
    const { app, token, inquiryService } = setup();
    const { AppError } = await import('../../src/utils/AppError.js');
    inquiryService.getInquiry.mockRejectedValue(
      new AppError(404, 'NOT_FOUND', 'Inquiry not found'),
    );
    const res = await call(app, 'GET', `/api/inquiries/${ID}`, token);
    expect(res.status).toBe(404);
  });

  it.each([
    [{ status: 'Closed' }, 'status'],
    [{}, 'status'],
    [{ status: 'Resolved', name: 'x' }, 'name'],
  ])('rejects the status update %o', async (body, field) => {
    const { app, token } = setup();
    const res = await request(app)
      .patch(`/api/inquiries/${ID}/status`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', `${COOKIE}=${token}`)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.field)).toContain(field);
  });

  it('passes validated filters, search and sort to the service', async () => {
    const { app, token, inquiryService } = setup();
    const res = await call(
      app,
      'GET',
      '/api/inquiries?category=Concert&userType=School&search=%20ravi%20%20kumar%20&sortBy=name&sortDir=asc&page=3',
      token,
    );
    expect(res.status).toBe(200);
    expect(inquiryService.listInquiries).toHaveBeenCalledWith({
      page: 3,
      pageSize: 20,
      category: 'Concert',
      userType: 'School',
      search: 'ravi kumar',
      sortBy: 'name',
      sortDir: 'asc',
    });
  });

  it('answers 503 without details when the database is down while listing', async () => {
    const { app, token, inquiryService } = setup();
    inquiryService.listInquiries.mockRejectedValue(
      new ConnectionRefusedError(new Error('connect ECONNREFUSED 10.1.2.3:5432')),
    );
    const res = await call(app, 'GET', '/api/inquiries', token);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DATABASE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain('10.1.2.3');
  });

  it('reports a database error during a status update without leaking it', async () => {
    const { app, token, inquiryService } = setup();
    inquiryService.updateInquiryStatus.mockRejectedValue(
      new DatabaseError(Object.assign(new Error('deadlock detected'), { code: '40P01' })),
    );
    const res = await call(app, 'PATCH', `/api/inquiries/${ID}/status`, token);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message: 'The service is temporarily unavailable. Please try again shortly.',
      },
    });
  });

  it('reports other database errors during a status update as a generic 500', async () => {
    const { app, token, inquiryService } = setup();
    inquiryService.updateInquiryStatus.mockRejectedValue(
      new DatabaseError(Object.assign(new Error('relation does not exist'), { code: '42P01' })),
    );
    const res = await call(app, 'PATCH', `/api/inquiries/${ID}/status`, token);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('DATABASE_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('relation');
  });

  it('passes the export filters (and only those) to the service', async () => {
    const { app, token, inquiryService } = setup();
    const res = await call(app, 'GET', '/api/inquiries/export?category=Concert&search=ravi', token);
    expect(res.status).toBe(200);
    expect(inquiryService.exportInquiries).toHaveBeenCalledWith({
      category: 'Concert',
      search: 'ravi',
      sortBy: 'createdAt',
      sortDir: 'desc',
    });
  });

  it('explains when an export is too large', async () => {
    const { app, token, inquiryService } = setup();
    const { AppError } = await import('../../src/utils/AppError.js');
    inquiryService.exportInquiries.mockRejectedValue(
      new AppError(422, 'EXPORT_TOO_LARGE', 'Narrow the filters and try again.'),
    );
    const res = await call(app, 'GET', '/api/inquiries/export', token);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('EXPORT_TOO_LARGE');
  });

  it('rejects a status update without a trusted origin (CSRF)', async () => {
    const { app, token, inquiryService } = setup();
    const res = await request(app)
      .patch(`/api/inquiries/${ID}/status`)
      .set('Cookie', `${COOKIE}=${token}`)
      .send({ status: 'Resolved' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    expect(inquiryService.updateInquiryStatus).not.toHaveBeenCalled();
  });
});
