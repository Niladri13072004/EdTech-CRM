import bcrypt from 'bcrypt';
import { afterAll, describe, expect, it } from 'vitest';
import { CATEGORIES, INQUIRY_STATUSES, USER_TYPES } from '../../src/constants/inquiry.js';
import { buildOfflineModels } from '../helpers/testApp.js';

const { sequelize, Admin, Inquiry } = buildOfflineModels();
afterAll(() => sequelize.close());

const fieldMap = (model) =>
  Object.fromEntries(Object.entries(model.getAttributes()).map(([name, def]) => [name, def.field]));

const validInquiry = (overrides = {}) => ({
  name: 'Asha Verma',
  email: 'asha@example.com',
  phone: '+91 98765-43210',
  userType: 'Parent',
  category: 'Admission',
  message: 'When does admission open for grade 6?',
  ...overrides,
});

describe('Inquiry model', () => {
  it('maps camelCase attributes to snake_case columns explicitly', () => {
    expect(Inquiry.getTableName()).toBe('inquiries');
    expect(fieldMap(Inquiry)).toEqual({
      id: 'id',
      name: 'name',
      email: 'email',
      phone: 'phone',
      userType: 'user_type',
      category: 'category',
      message: 'message',
      status: 'status',
      assignedAdminId: 'assigned_admin_id',
      followUpDate: 'follow_up_date',
      followUpOutcome: 'follow_up_outcome',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    });
  });

  it('accepts a valid inquiry and defaults status to New', async () => {
    const inquiry = Inquiry.build(validInquiry());
    await expect(inquiry.validate()).resolves.toBeDefined();
    expect(inquiry.status).toBe('New');
    expect(inquiry.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    ['userType', USER_TYPES],
    ['category', CATEGORIES],
    ['status', INQUIRY_STATUSES],
  ])('accepts every allowed %s', async (field, values) => {
    for (const value of values) {
      await expect(
        Inquiry.build(validInquiry({ [field]: value })).validate(),
      ).resolves.toBeDefined();
    }
  });

  it.each([
    { userType: 'Teacher' },
    { category: 'Sports' },
    { status: 'Closed' },
    { name: 'A' },
    { email: 'not-an-email' },
    { phone: '12345' },
    { phone: '98765abc43' },
    { phone: '1'.repeat(16) },
    { message: 'x'.repeat(2001) },
    { name: null },
  ])('rejects %o', async (override) => {
    await expect(Inquiry.build(validInquiry(override)).validate()).rejects.toThrow();
  });
});

describe('Admin model', () => {
  const hash = bcrypt.hashSync('correct horse battery staple', 4);

  it('maps attributes to columns and has no updated_at', () => {
    expect(Admin.getTableName()).toBe('admins');
    expect(fieldMap(Admin)).toEqual({
      id: 'id',
      email: 'email',
      passwordHash: 'password_hash',
      createdAt: 'created_at',
    });
  });

  it('normalises email to lower case', () => {
    expect(Admin.build({ email: '  Admin@Example.COM ', passwordHash: hash }).email).toBe(
      'admin@example.com',
    );
  });

  it('only accepts bcrypt hashes', async () => {
    await expect(
      Admin.build({ email: 'a@example.com', passwordHash: hash }).validate(),
    ).resolves.toBeDefined();
    await expect(
      Admin.build({ email: 'a@example.com', passwordHash: 'plaintext' }).validate(),
    ).rejects.toThrow();
  });

  it('never serialises the password hash', () => {
    const admin = Admin.build({ email: 'a@example.com', passwordHash: hash });
    expect(admin.toJSON()).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(admin)).not.toContain(hash);
  });

  it('excludes password_hash from default queries', () => {
    expect(Admin.options.defaultScope).toEqual({ attributes: { exclude: ['passwordHash'] } });
  });
});
