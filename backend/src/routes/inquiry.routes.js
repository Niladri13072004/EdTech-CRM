import { Router } from 'express';
import { ADMIN_ROLE } from '../constants/auth.js';
import { createInquiryController } from '../controllers/inquiry.controller.js';
import { requireRole } from '../middleware/authenticate.js';
import { createInquirySubmissionLimiter } from '../middleware/rateLimiters.js';
import { requireJson } from '../middleware/requireJson.js';
import { validate } from '../middleware/validate.js';
import { uuidParamSchema } from '../validators/common.schema.js';
import {
  createInquirySchema,
  emptyQuerySchema,
  exportInquiriesQuerySchema,
  listInquiriesQuerySchema,
  addInquiryNoteSchema,
  updateInquiryStatusSchema,
  updateInquiryWorkflowSchema,
} from '../validators/inquiry.schema.js';

export function createInquiryRouter({ inquiryService, config, security }) {
  const controller = createInquiryController({ inquiryService });
  const router = Router();

  // Public: the inquiry form is used by visitors who have no account.
  router.post(
    '/',
    createInquirySubmissionLimiter(config.inquiries.rateLimit),
    requireJson,
    validate({ body: createInquirySchema }),
    controller.create,
  );

  // Everything below is admin-only. Placed after the public route, this also
  // makes any other /api/inquiries/* path answer 401 to anonymous callers.
  router.use(security.authenticate, requireRole(ADMIN_ROLE));

  router.get('/', validate({ query: listInquiriesQuerySchema }), controller.list);
  // Fixed paths before /:id, which only accepts UUIDs.
  router.get('/stats', validate({ query: emptyQuerySchema }), controller.stats);
  router.get('/export', validate({ query: exportInquiriesQuerySchema }), controller.exportCsv);
  router.get('/assignable-admins', validate({ query: emptyQuerySchema }), controller.assignableAdmins);
  router.get('/:id', validate({ params: uuidParamSchema }), controller.show);
  router.post(
    '/:id/notes',
    security.requireTrustedOrigin,
    requireJson,
    validate({ params: uuidParamSchema, body: addInquiryNoteSchema }),
    controller.addNote,
  );
  router.patch(
    '/:id',
    security.requireTrustedOrigin,
    requireJson,
    validate({ params: uuidParamSchema, body: updateInquiryWorkflowSchema }),
    controller.updateWorkflow,
  );
  router.patch(
    '/:id/status',
    security.requireTrustedOrigin,
    requireJson,
    validate({ params: uuidParamSchema, body: updateInquiryStatusSchema }),
    controller.updateStatus,
  );

  return router;
}
