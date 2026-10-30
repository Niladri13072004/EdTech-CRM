import { describe, expect, it } from 'vitest';
import { updateInquiryWorkflowSchema } from '../../src/validators/inquiry.schema.js';

const parseDate = (followUpDate) => updateInquiryWorkflowSchema.safeParse({ followUpDate });

describe('updateInquiryWorkflowSchema — follow-up date', () => {
  it.each(['2026-01-31', '2024-02-29', '2026-12-01', '1999-06-15'])(
    'accepts the real calendar date %s',
    (value) => {
      const result = parseDate(value);
      expect(result.success).toBe(true);
      expect(result.data.followUpDate).toBe(value);
    },
  );

  it.each(['2026-02-31', '2026-04-31', '2025-02-29', '2026-13-01', '2026-00-10', '2026-01-32'])(
    'rejects the impossible date %s',
    (value) => {
      expect(parseDate(value).success).toBe(false);
    },
  );

  it.each(['2026-1-05', '31-01-2026', '2026/01/31', 'yesterday', '2026-01-31T00:00:00Z'])(
    'rejects the malformed date %s',
    (value) => {
      expect(parseDate(value).success).toBe(false);
    },
  );

  it('treats an empty string as "no follow-up date"', () => {
    const result = parseDate('');
    expect(result.success).toBe(true);
    expect(result.data.followUpDate).toBeNull();
  });
});
