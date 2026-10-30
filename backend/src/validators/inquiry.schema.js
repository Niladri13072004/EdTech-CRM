import { z } from 'zod';
import { CATEGORIES, FIELD_LIMITS, INQUIRY_STATUSES, USER_TYPES } from '../constants/inquiry.js';

// C0 control characters and DEL, except tab, line feed and carriage return.
// Matching control characters is the point of this pattern.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

// International format, not tied to one country: optional leading "+",
// starts with a digit or "(", ends with a digit or ")", and contains only
// digits, spaces, hyphens and brackets in between. Digit count is checked
// separately (E.164 allows at most 15 digits).
const PHONE_FORMAT = /^\+?[0-9(][0-9() -]*[0-9)]$/;

export const INQUIRY_MESSAGE_MIN_LENGTH = 10;

const collapseWhitespace = (value) => value.replace(/\s+/g, ' ');

/** A trimmed, required string without control characters. */
function requiredText(label) {
  return z
    .string({
      error: (issue) =>
        issue.input === undefined || issue.input === null
          ? `${label} is required`
          : `${label} must be text`,
    })
    .trim()
    .min(1, { error: `${label} is required`, abort: true })
    .refine((value) => !CONTROL_CHARACTERS.test(value), {
      error: `${label} contains characters that are not allowed`,
      abort: true,
    });
}

function choice(label, values) {
  const allowed = values.join(', ');
  return z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : value),
    z.enum(values, {
      error: (issue) =>
        issue.input === undefined || issue.input === null || issue.input === ''
          ? `${label} is required`
          : `${label} must be one of: ${allowed}`,
    }),
  );
}

const { name, email, phone, message } = FIELD_LIMITS;

const phoneSchema = requiredText('Phone number')
  .transform(collapseWhitespace)
  .pipe(
    z
      .string()
      .max(phone.maxLength, {
        error: `Phone number must be at most ${phone.maxLength} characters`,
        abort: true,
      })
      .regex(PHONE_FORMAT, {
        error:
          'Phone number may contain only digits, spaces, hyphens and brackets, with an optional leading +',
        abort: true,
      })
      .refine(
        (value) => {
          const digits = value.replace(/\D/g, '').length;
          return digits >= phone.minDigits && digits <= phone.maxDigits;
        },
        { error: `Phone number must contain ${phone.minDigits}–${phone.maxDigits} digits` },
      ),
  );

/**
 * Body of POST /api/inquiries. Unknown keys are rejected (not silently
 * dropped), so clients cannot set `status`, `id`, timestamps or anything else
 * that is not part of the public form.
 */
export const createInquirySchema = z.strictObject(
  {
    name: requiredText('Name')
      .min(name.min, { error: `Name must be at least ${name.min} characters`, abort: true })
      .max(name.max, { error: `Name must be at most ${name.max} characters`, abort: true })
      .regex(/\p{L}/u, { error: 'Name must include at least one letter' })
      .transform(collapseWhitespace),
    email: requiredText('Email')
      .max(email.max, { error: `Email must be at most ${email.max} characters`, abort: true })
      .toLowerCase()
      .pipe(z.email({ error: 'Enter a valid email address, for example name@example.com' })),
    phone: phoneSchema,
    userType: choice('User type', USER_TYPES),
    category: choice('Category', CATEGORIES),
    message: requiredText('Message')
      .max(message.max, {
        error: `Message must be at most ${message.max} characters`,
        abort: true,
      })
      .min(INQUIRY_MESSAGE_MIN_LENGTH, {
        error: `Message must be at least ${INQUIRY_MESSAGE_MIN_LENGTH} characters`,
      })
      .transform((value) => value.replace(/\r\n?/g, '\n')),
  },
  {
    error: (issue) =>
      issue.code === 'invalid_type' ? 'Request body must be a JSON object' : undefined,
  },
);

export const INQUIRY_PAGE_SIZE_MAX = 100;
export const INQUIRY_PAGE_SIZE_DEFAULT = 20;
export const INQUIRY_SEARCH_MAX_LENGTH = 100;

// Columns the list may be sorted by (attribute names; never raw input).
export const INQUIRY_SORT_FIELDS = Object.freeze([
  'createdAt',
  'name',
  'category',
  'userType',
  'status',
]);
export const SORT_DIRECTIONS = Object.freeze(['asc', 'desc']);

const positiveInt = (label, { max, fallback }) =>
  z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.coerce
      .number({ error: `${label} must be a whole number` })
      .int({ error: `${label} must be a whole number` })
      .min(1, { error: `${label} must be at least 1` })
      .max(max, { error: `${label} must be at most ${max}` })
      .default(fallback),
  );

/** Optional filter: blank means "no filter"; otherwise must be an allowed value. */
const optionalChoice = (label, values) =>
  z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() || undefined : value),
    z.enum(values, { error: `${label} must be one of: ${values.join(', ')}` }).optional(),
  );

/**
 * GET /api/inquiries query string. Repeated parameters (?category=a&category=b)
 * arrive as arrays and are rejected; unknown parameters are rejected.
 */
export const listInquiriesQuerySchema = z.strictObject({
  page: positiveInt('page', { max: 100_000, fallback: 1 }),
  pageSize: positiveInt('pageSize', {
    max: INQUIRY_PAGE_SIZE_MAX,
    fallback: INQUIRY_PAGE_SIZE_DEFAULT,
  }),
  category: optionalChoice('category', CATEGORIES),
  userType: optionalChoice('userType', USER_TYPES),
  status: optionalChoice('status', INQUIRY_STATUSES),
  search: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') || undefined : value),
    z
      .string({ error: 'search must be text' })
      .max(INQUIRY_SEARCH_MAX_LENGTH, {
        error: `search must be at most ${INQUIRY_SEARCH_MAX_LENGTH} characters`,
      })
      .refine((value) => !CONTROL_CHARACTERS.test(value), {
        error: 'search contains characters that are not allowed',
      })
      .optional(),
  ),
  sortBy: z
    .enum(INQUIRY_SORT_FIELDS, {
      error: `sortBy must be one of: ${INQUIRY_SORT_FIELDS.join(', ')}`,
    })
    .default('createdAt'),
  sortDir: z.enum(SORT_DIRECTIONS, { error: 'sortDir must be asc or desc' }).default('desc'),
});

/** GET /api/inquiries/export: the list filters and sort, without pagination. */
export const exportInquiriesQuerySchema = listInquiriesQuerySchema.omit({
  page: true,
  pageSize: true,
});

/** GET /api/inquiries/stats takes no parameters. */
export const emptyQuerySchema = z.strictObject({});

/** PATCH /api/inquiries/:id/status body. */
export const updateInquiryStatusSchema = z.strictObject(
  { status: choice('Status', INQUIRY_STATUSES) },
  {
    error: (issue) =>
      issue.code === 'invalid_type' ? 'Request body must be a JSON object' : undefined,
  },
);

/** Optional administrator note body. */
export const addInquiryNoteSchema = z.strictObject(
  {
    body: z
      .string({ error: 'Note must be text' })
      .trim()
      .min(1, { error: 'Note is required', abort: true })
      .max(5000, { error: 'Note must be at most 5000 characters' })
      .refine((value) => !CONTROL_CHARACTERS.test(value), {
        error: 'Note contains characters that are not allowed',
      }),
  },
  {
    error: (issue) =>
      issue.code === 'invalid_type' ? 'Request body must be a JSON object' : undefined,
  },
);

const nullableUuid = z.preprocess(
  (value) => (value === '' ? null : value),
  z.uuid({ error: 'Assigned administrator must be a valid id' }).nullable().optional(),
);

const nullableDate = z.preprocess(
  (value) => (value === '' ? null : value),
  z
    .string({ error: 'Follow-up date must be a date' })
    .regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'Follow-up date must use YYYY-MM-DD' })
    .nullable()
    .optional(),
);

const nullableOutcome = z.preprocess(
  (value) => (value === '' ? null : value),
  z
    .string({ error: 'Follow-up outcome must be text' })
    .trim()
    .max(2000, { error: 'Follow-up outcome must be at most 2000 characters' })
    .refine((value) => !CONTROL_CHARACTERS.test(value), {
      error: 'Follow-up outcome contains characters that are not allowed',
    })
    .nullable()
    .optional(),
);

/** PATCH /api/inquiries/:id — workflow fields. At least one field is required. */
export const updateInquiryWorkflowSchema = z
  .strictObject({
    status: choice('Status', INQUIRY_STATUSES).optional(),
    assignedAdminId: nullableUuid,
    followUpDate: nullableDate,
    followUpOutcome: nullableOutcome,
  })
  .refine(
    (value) =>
      value.status !== undefined ||
      value.assignedAdminId !== undefined ||
      value.followUpDate !== undefined ||
      value.followUpOutcome !== undefined,
    { error: 'Provide at least one field to update' },
  );