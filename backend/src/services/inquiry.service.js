import { Op } from 'sequelize';
import { AppError } from '../utils/AppError.js';
import { CATEGORIES, INQUIRY_STATUSES } from '../constants/inquiry.js';
import { buildInquiryWhere } from '../utils/buildInquiryWhere.js';
import { INQUIRY_EXPORT_ATTRIBUTES } from '../utils/inquiryCsv.js';

/** Largest CSV export allowed in one request (keeps memory and time bounded). */
export const EXPORT_MAX_ROWS = 5000;

// Columns returned by the admin list (the message is fetched per inquiry).
export const LIST_ATTRIBUTES = Object.freeze([
  'id',
  'name',
  'email',
  'phone',
  'userType',
  'category',
  'status',
  'createdAt',
  'updatedAt',
]);

// The only attributes a public submission may set. Everything else (id,
// status, timestamps) comes from model/database defaults.
export const CREATABLE_FIELDS = Object.freeze([
  'name',
  'email',
  'phone',
  'userType',
  'category',
  'message',
]);

function pickCreatable(input) {
  return Object.fromEntries(CREATABLE_FIELDS.map((field) => [field, input[field]]));
}

/**
 * @param {object} deps
 * @param {import('sequelize').Sequelize} deps.sequelize
 * @param {import('sequelize').ModelStatic<any>} deps.Inquiry
 * @param {number} [deps.exportMaxRows]  cap on rows per CSV export
 * @param {number} deps.duplicateWindowMs  identical submissions within this window
 *   return the existing inquiry instead of creating another (0 disables)
 */
export function createInquiryService({
  sequelize,
  Inquiry,
  InquiryNote,
  InquiryActivity,
  Admin,
  duplicateWindowMs,
  exportMaxRows = EXPORT_MAX_ROWS,
}) {
  /**
   * Stores a validated public submission. Resolves only after the transaction
   * has committed, so callers never report success for data that was not saved.
   *
   * @returns {Promise<{ inquiry: { id: string }, created: boolean }>}
   */
  async function createInquiry(input) {
    const values = pickCreatable(input);

    if (duplicateWindowMs <= 0) {
      const inquiry = await Inquiry.create(values, { fields: [...CREATABLE_FIELDS] });
      return { inquiry, created: true };
    }

    return sequelize.transaction(async (transaction) => {
      // Serialise identical submissions (double clicks, client retries) so the
      // check-then-insert below cannot race. The lock is held until commit.
      await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', {
        replacements: { key: JSON.stringify(CREATABLE_FIELDS.map((field) => values[field])) },
        transaction,
      });

      const existing = await Inquiry.findOne({
        attributes: ['id'],
        where: {
          ...values,
          createdAt: { [Op.gte]: new Date(Date.now() - duplicateWindowMs) },
        },
        order: [['createdAt', 'DESC']],
        transaction,
      });
      if (existing) return { inquiry: existing, created: false };

      const inquiry = await Inquiry.create(values, { fields: [...CREATABLE_FIELDS], transaction });
      return { inquiry, created: true };
    });
  }

  /**
   * One page of inquiries matching the filters, plus the total count for those
   * same filters (so pagination never ignores them). Sort fields are
   * whitelisted by the validator; `createdAt` and `id` break ties so pages are
   * stable.
   */
  async function listInquiries({
    page,
    pageSize,
    category,
    userType,
    status,
    search,
    sortBy = 'createdAt',
    sortDir = 'desc',
  }) {
    const { rows, count } = await Inquiry.findAndCountAll({
      attributes: [...LIST_ATTRIBUTES],
      where: buildInquiryWhere({ category, userType, status, search }),
      order: orderFor(sortBy, sortDir),
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    const totalPages = Math.ceil(count / pageSize);
    return {
      inquiries: rows.map((row) => row.get({ plain: true })),
      meta: {
        page,
        pageSize,
        total: count,
        totalPages,
        hasPreviousPage: page > 1,
        hasNextPage: page < totalPages,
        filters: {
          category: category ?? null,
          userType: userType ?? null,
          status: status ?? null,
          search: search ?? null,
        },
        sort: { by: sortBy, direction: sortDir },
      },
    };
  }

  function orderFor(sortBy = 'createdAt', sortDir = 'desc') {
    const order = [[sortBy, sortDir === 'asc' ? 'ASC' : 'DESC']];
    if (sortBy !== 'createdAt') order.push(['createdAt', 'DESC']);
    order.push(['id', 'DESC']);
    return order;
  }

  /** COUNT(*) grouped by one column, zero-filled for every allowed value. */
  async function countBy(column, values) {
    const rows = await Inquiry.findAll({
      attributes: [column, [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
      group: [column],
      raw: true,
    });
    const counts = Object.fromEntries(values.map((value) => [value, 0]));
    for (const row of rows) {
      if (row[column] in counts) counts[row[column]] = Number(row.count);
    }
    return counts;
  }

  /**
   * Dashboard totals computed in PostgreSQL (two GROUP BY queries); no
   * inquiry rows leave the database.
   */
  async function getInquiryStats() {
    const [byStatus, byCategory] = await Promise.all([
      countBy('status', INQUIRY_STATUSES),
      countBy('category', CATEGORIES),
    ]);
    const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
    return { total, byStatus, byCategory };
  }

  /**
   * Every inquiry matching the filters, in the dashboard's sort order, for
   * the CSV export. Refuses exports larger than `exportMaxRows`.
   */
  async function exportInquiries({ category, userType, status, search, sortBy, sortDir }) {
    const where = buildInquiryWhere({ category, userType, status, search });
    const count = await Inquiry.count({ where });
    if (count > exportMaxRows) {
      throw new AppError(
        422,
        'EXPORT_TOO_LARGE',
        `This export would contain ${count} inquiries; the limit is ${exportMaxRows}. Narrow the filters and try again.`,
      );
    }
    return Inquiry.findAll({
      attributes: [...INQUIRY_EXPORT_ATTRIBUTES],
      where,
      order: orderFor(sortBy, sortDir),
      raw: true,
    });
  }

  async function findInquiryOrFail(id, options = {}) {
    const inquiry = await Inquiry.findByPk(id, options);
    if (!inquiry) throw new AppError(404, 'NOT_FOUND', 'Inquiry not found');
    return inquiry;
  }

  function actorFrom(actor) {
    return {
      adminId: actor?.id ?? null,
      adminEmail: actor?.email ?? 'System',
    };
  }

  async function recordActivity(inquiryId, type, summary, actor, transaction) {
    const { adminId, adminEmail } = actorFrom(actor);
    return InquiryActivity.create(
      { inquiryId, type, summary, adminId, adminEmail },
      { transaction },
    );
  }

  async function loadDetail(id, { transaction } = {}) {
    const inquiry = await findInquiryOrFail(id, { transaction });
    const [notes, activities, assignedAdmin] = await Promise.all([
      InquiryNote.findAll({ where: { inquiryId: id }, order: [['createdAt', 'ASC']], transaction }),
      InquiryActivity.findAll({
        where: { inquiryId: id },
        order: [['createdAt', 'ASC']],
        transaction,
      }),
      inquiry.assignedAdminId ? Admin.findByPk(inquiry.assignedAdminId, { transaction }) : null,
    ]);

    const activityRows = activities.map((row) => row.get({ plain: true }));
    const received = {
      id: `received-${inquiry.id}`,
      inquiryId: inquiry.id,
      type: 'received',
      summary: 'Inquiry received.',
      adminId: null,
      adminEmail: null,
      createdAt: inquiry.createdAt,
    };
    const timeline = [received, ...activityRows.filter((row) => row.type !== 'received')].sort(
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
    );

    return {
      ...inquiry.get({ plain: true }),
      assignedAdmin: assignedAdmin ? { id: assignedAdmin.id, email: assignedAdmin.email } : null,
      notes: notes.map((row) => {
        const note = row.get({ plain: true });
        return {
          id: note.id,
          body: note.body,
          admin: { id: note.adminId, email: note.adminEmail },
          createdAt: note.createdAt,
        };
      }),
      activities: timeline,
    };
  }

  async function addNote(id, body, actor) {
    return sequelize.transaction(async (transaction) => {
      const inquiry = await findInquiryOrFail(id, { transaction });
      const { adminId, adminEmail } = actorFrom(actor);
      const note = await InquiryNote.create(
        { inquiryId: inquiry.id, adminId, adminEmail, body },
        { transaction },
      );
      await recordActivity(inquiry.id, 'note', 'Note added.', actor, transaction);
      return {
        id: note.id,
        body: note.body,
        admin: { id: note.adminId, email: note.adminEmail },
        createdAt: note.createdAt,
      };
    });
  }

  async function updateInquiryWorkflow(id, input, actor) {
    return sequelize.transaction(async (transaction) => {
      const inquiry = await findInquiryOrFail(id, { transaction });
      const changes = {};
      const activityWrites = [];

      if (input.status !== undefined && input.status !== inquiry.status) {
        changes.status = input.status;
        activityWrites.push(
          recordActivity(
            inquiry.id,
            'status',
            `Status changed from ${inquiry.status} to ${input.status}.`,
            actor,
            transaction,
          ),
        );
      }

      if (input.assignedAdminId !== undefined) {
        const nextId = input.assignedAdminId || null;
        if (nextId !== (inquiry.assignedAdminId ?? null)) {
          let nextAdmin = null;
          if (nextId) {
            nextAdmin = await Admin.findByPk(nextId, { transaction });
            if (!nextAdmin)
              throw new AppError(422, 'INVALID_ASSIGNEE', 'That administrator does not exist');
          }
          changes.assignedAdminId = nextId;
          activityWrites.push(
            recordActivity(
              inquiry.id,
              'assignment',
              nextAdmin ? `Assigned to ${nextAdmin.email}.` : 'Assignment cleared.',
              actor,
              transaction,
            ),
          );
        }
      }

      if (input.followUpDate !== undefined) {
        const nextDate = input.followUpDate || null;
        const currentDate = inquiry.followUpDate ?? null;
        if (nextDate !== currentDate) {
          changes.followUpDate = nextDate;
          activityWrites.push(
            recordActivity(
              inquiry.id,
              'follow_up',
              nextDate ? `Follow-up scheduled for ${nextDate}.` : 'Follow-up date cleared.',
              actor,
              transaction,
            ),
          );
        }
      }

      if (input.followUpOutcome !== undefined) {
        const nextOutcome = input.followUpOutcome || null;
        if (nextOutcome !== (inquiry.followUpOutcome ?? null)) {
          changes.followUpOutcome = nextOutcome;
          activityWrites.push(
            recordActivity(
              inquiry.id,
              'outcome',
              nextOutcome ? 'Follow-up outcome recorded.' : 'Follow-up outcome cleared.',
              actor,
              transaction,
            ),
          );
        }
      }

      if (Object.keys(changes).length > 0) {
        await inquiry.update(changes, { fields: Object.keys(changes), transaction });
      }
      await Promise.all(activityWrites);
      return loadDetail(inquiry.id, { transaction });
    });
  }

  async function updateInquiryStatus(id, status, actor) {
    return updateInquiryWorkflow(id, { status }, actor);
  }

  async function getAssignableAdmins() {
    const admins = await Admin.findAll({ attributes: ['id', 'email'], order: [['email', 'ASC']] });
    return admins.map((admin) => admin.get({ plain: true }));
  }

  return {
    createInquiry,
    listInquiries,
    getInquiryStats,
    exportInquiries,
    getInquiry: loadDetail,
    addNote,
    updateInquiryWorkflow,
    updateInquiryStatus,
    getAssignableAdmins,
  };
}
