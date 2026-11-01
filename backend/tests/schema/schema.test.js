// Executes the real schema.sql in PGlite — PostgreSQL compiled to WebAssembly —
// so constraints, defaults, triggers and RLS are checked without a server.
// This verifies the SQL itself; it is not a Supabase connection test.

import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import bcrypt from 'bcrypt';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BACKEND_ROOT } from '../../src/config/env.js';
import { CATEGORIES, INQUIRY_STATUSES, USER_TYPES } from '../../src/constants/inquiry.js';
import {
  buildColumnsQuery,
  buildRlsQuery,
  compareModelsToColumns,
  expectedDataType,
  modelTableNames,
} from '../../src/models/schemaComparison.js';
import { buildOfflineModels } from '../helpers/testApp.js';

const schemaSql = fs.readFileSync(path.join(BACKEND_ROOT, '..', 'schema.sql'), 'utf8');
const CHECK_VIOLATION = '23514';
const NOT_NULL_VIOLATION = '23502';
const UNIQUE_VIOLATION = '23505';

let db;
const offline = buildOfflineModels();

beforeAll(async () => {
  db = new PGlite();
  await db.exec(schemaSql);
});

afterAll(async () => {
  await db?.close();
  await offline.sequelize.close();
});

beforeEach(async () => {
  await db.exec('DELETE FROM public.inquiries; DELETE FROM public.admins;');
});

const inquiry = (overrides = {}) => ({
  name: 'Asha Verma',
  email: 'asha@example.com',
  phone: '+91 98765-43210',
  user_type: 'Parent',
  category: 'Admission',
  message: 'When does admission open?',
  ...overrides,
});

async function insertInquiry(values) {
  const columns = Object.keys(values);
  const placeholders = columns.map((_, i) => `$${i + 1}`);
  const { rows } = await db.query(
    `INSERT INTO public.inquiries (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    Object.values(values),
  );
  return rows[0];
}

async function checkValues(constraintName) {
  const { rows } = await db.query(
    'SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1',
    [constraintName],
  );
  return [...rows[0].def.matchAll(/'([^']+)'::text/g)].map((match) => match[1]);
}

describe('schema.sql', () => {
  it('is idempotent', async () => {
    await expect(db.exec(schemaSql)).resolves.toBeDefined();
  });

  it('covers every registered model table', () => {
    expect(modelTableNames(offline)).toEqual([
      'admins',
      'inquiries',
      'inquiry_activities',
      'inquiry_notes',
    ]);
  });

  it('matches every Sequelize model column for column', async () => {
    const { sql, bind } = buildColumnsQuery(modelTableNames(offline));
    const { rows } = await db.query(sql, bind);
    expect(compareModelsToColumns(offline, rows)).toEqual([]);
    // The comparison is only meaningful if all four tables were actually read.
    expect(new Set(rows.map((row) => row.table_name))).toEqual(
      new Set(['admins', 'inquiries', 'inquiry_notes', 'inquiry_activities']),
    );
  });

  it('reports the live PostgreSQL type for every model column', async () => {
    const { sql, bind } = buildColumnsQuery(modelTableNames(offline));
    const { rows } = await db.query(sql, bind);
    const types = Object.fromEntries(
      rows.map((row) => [`${row.table_name}.${row.column_name}`, row.data_type]),
    );
    expect(types['admins.id']).toBe('uuid');
    expect(types['admins.email']).toBe('text');
    expect(types['admins.created_at']).toBe('timestamp with time zone');
    expect(types['inquiries.follow_up_date']).toBe('date');
    expect(types['inquiries.assigned_admin_id']).toBe('uuid');
  });

  it('reports a column whose PostgreSQL type drifted away from the model', async () => {
    const { sql, bind } = buildColumnsQuery(modelTableNames(offline));
    const { rows } = await db.query(sql, bind);
    const drifted = rows.map((row) =>
      row.table_name === 'inquiries' && row.column_name === 'message'
        ? { ...row, data_type: 'varchar' }
        : row,
    );
    expect(compareModelsToColumns(offline, drifted)).toEqual([
      'inquiries.message: column type is "varchar" but the model expects "text"',
    ]);
  });

  it('translates Sequelize types to information_schema names', () => {
    const attributes = offline.Inquiry.getAttributes();
    expect(expectedDataType(attributes.id.type)).toBe('uuid');
    expect(expectedDataType(attributes.message.type)).toBe('text');
    expect(expectedDataType(attributes.followUpDate.type)).toBe('date');
    expect(expectedDataType(attributes.createdAt.type)).toBe('timestamp with time zone');
  });

  it('allows exactly the values defined in constants/inquiry.js', async () => {
    expect(await checkValues('inquiries_user_type_allowed')).toEqual([...USER_TYPES]);
    expect(await checkValues('inquiries_category_allowed')).toEqual([...CATEGORIES]);
    expect(await checkValues('inquiries_status_allowed')).toEqual([...INQUIRY_STATUSES]);
  });

  it('creates the dashboard indexes', async () => {
    const { rows } = await db.query(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'inquiries'",
    );
    expect(rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'inquiries_created_at_idx',
        'inquiries_category_created_at_idx',
        'inquiries_user_type_created_at_idx',
      ]),
    );
  });

  it('enables Row Level Security on every model table', async () => {
    const { sql, bind } = buildRlsQuery(modelTableNames(offline));
    const { rows } = await db.query(sql, bind);
    expect(rows).toEqual([
      { relname: 'admins', relrowsecurity: true },
      { relname: 'inquiries', relrowsecurity: true },
      { relname: 'inquiry_activities', relrowsecurity: true },
      { relname: 'inquiry_notes', relrowsecurity: true },
    ]);
  });
});

describe('inquiries table', () => {
  it('generates id and timestamps and defaults status to New', async () => {
    const row = await insertInquiry(inquiry());
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.status).toBe('New');
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
  });

  it('stores phone numbers as text, keeping "+" and leading zeros', async () => {
    const row = await insertInquiry(inquiry({ phone: '+44 0207 946 0958' }));
    expect(row.phone).toBe('+44 0207 946 0958');
  });

  it.each(USER_TYPES.map((value) => ({ user_type: value })))('accepts %o', async (values) => {
    await expect(insertInquiry(inquiry(values))).resolves.toBeDefined();
  });

  it.each(CATEGORIES.map((value) => ({ category: value })))('accepts %o', async (values) => {
    await expect(insertInquiry(inquiry(values))).resolves.toBeDefined();
  });

  it.each([
    { user_type: 'Teacher' },
    { user_type: 'parent' },
    { category: 'Sports' },
    { status: 'Closed' },
    { name: ' ' },
    { name: 'x'.repeat(101) },
    { email: 'not-an-email' },
    { phone: 'call me' },
    { phone: '12345' },
    { phone: '1'.repeat(16) },
    { phone: '9876543210+' },
    { message: '   ' },
    { message: 'x'.repeat(2001) },
  ])('rejects %o with a CHECK violation', async (override) => {
    await expect(insertInquiry(inquiry(override))).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it.each(['name', 'email', 'phone', 'user_type', 'category', 'message'])(
    'requires %s',
    async (column) => {
      const values = inquiry();
      delete values[column];
      await expect(insertInquiry(values)).rejects.toMatchObject({ code: NOT_NULL_VIOLATION });
    },
  );

  it('refreshes updated_at on every update', async () => {
    const row = await insertInquiry(
      inquiry({ created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z' }),
    );
    const { rows } = await db.query(
      "UPDATE public.inquiries SET status = 'In Progress' WHERE id = $1 RETURNING updated_at, created_at",
      [row.id],
    );
    expect(rows[0].updated_at.getTime()).toBeGreaterThan(rows[0].created_at.getTime());
  });
});

describe('admins table', () => {
  const hash = bcrypt.hashSync('a long test password', 4);
  const insertAdmin = (email, passwordHash = hash) =>
    db.query('INSERT INTO public.admins (email, password_hash) VALUES ($1, $2) RETURNING *', [
      email,
      passwordHash,
    ]);

  it('stores an admin with a bcrypt hash', async () => {
    const { rows } = await insertAdmin('admin@example.com');
    expect(rows[0]).toMatchObject({ email: 'admin@example.com', password_hash: hash });
    expect(rows[0].created_at).toBeInstanceOf(Date);
  });

  it('enforces unique emails', async () => {
    await insertAdmin('admin@example.com');
    await expect(insertAdmin('admin@example.com')).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
    });
  });

  it('rejects emails that are not normalised to lower case', async () => {
    await expect(insertAdmin('Admin@Example.com')).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('refuses to store a plaintext password', async () => {
    await expect(insertAdmin('admin@example.com', 'hunter2-plaintext')).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
  });

  it('requires email and password_hash', async () => {
    await expect(
      db.query('INSERT INTO public.admins (email) VALUES ($1)', ['a@example.com']),
    ).rejects.toMatchObject({
      code: NOT_NULL_VIOLATION,
    });
  });
});
