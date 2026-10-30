import { exportFilename, inquiriesToCsv } from '../utils/inquiryCsv.js';

export const INQUIRY_CREATED_MESSAGE = 'Thank you! Your inquiry has been received.';
export const INQUIRY_DUPLICATE_MESSAGE =
  'We have already received this inquiry. Our team will get back to you soon.';

export function createInquiryController({ inquiryService }) {
  return {
    /** POST /api/inquiries — 201 when stored, 200 when it repeats a recent identical submission. */
    async create(req, res) {
      const { inquiry, created } = await inquiryService.createInquiry(req.validated.body);

      res.status(created ? 201 : 200).json({
        success: true,
        message: created ? INQUIRY_CREATED_MESSAGE : INQUIRY_DUPLICATE_MESSAGE,
        data: { id: inquiry.id, duplicate: !created },
      });
    },

    /** GET /api/inquiries (admin) */
    async list(req, res) {
      const { inquiries, meta } = await inquiryService.listInquiries(req.validated.query);
      res.set('Cache-Control', 'no-store').json({ success: true, data: inquiries, meta });
    },

    /** GET /api/inquiries/stats (admin): totals by status and by category. */
    async stats(_req, res) {
      const stats = await inquiryService.getInquiryStats();
      res.set('Cache-Control', 'no-store').json({ success: true, data: stats });
    },

    /** GET /api/inquiries/export (admin): the filtered list as a CSV download. */
    async exportCsv(req, res) {
      const rows = await inquiryService.exportInquiries(req.validated.query);
      res
        .set({
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${exportFilename()}"`,
          'Cache-Control': 'no-store',
          'X-Export-Row-Count': String(rows.length),
        })
        .send(inquiriesToCsv(rows));
    },

    /** GET /api/inquiries/:id (admin) */
    async show(req, res) {
      const inquiry = await inquiryService.getInquiry(req.validated.params.id);
      res.set('Cache-Control', 'no-store').json({ success: true, data: inquiry });
    },

    /** GET /api/inquiries/assignable-admins (admin) */
    async assignableAdmins(_req, res) {
      const admins = await inquiryService.getAssignableAdmins();
      res.set('Cache-Control', 'no-store').json({ success: true, data: admins });
    },

    /** POST /api/inquiries/:id/notes (admin) */
    async addNote(req, res) {
      const note = await inquiryService.addNote(
        req.validated.params.id,
        req.validated.body.body,
        req.auth.admin,
      );
      res.status(201).json({ success: true, message: 'Note added.', data: note });
    },

    /** PATCH /api/inquiries/:id (admin) — status, assignment and follow-up. */
    async updateWorkflow(req, res) {
      const inquiry = await inquiryService.updateInquiryWorkflow(
        req.validated.params.id,
        req.validated.body,
        req.auth.admin,
      );
      res.json({ success: true, message: 'Inquiry updated.', data: inquiry });
    },

    /** PATCH /api/inquiries/:id/status (admin) */
    async updateStatus(req, res) {
      const inquiry = await inquiryService.updateInquiryStatus(
        req.validated.params.id,
        req.validated.body.status,
        req.auth.admin,
      );
      res.json({ success: true, message: 'Status updated.', data: inquiry });
    },
  };
}
