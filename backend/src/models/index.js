import { defineAdmin } from './Admin.js';
import { defineInquiry } from './Inquiry.js';
import { defineInquiryActivity } from './InquiryActivity.js';
import { defineInquiryNote } from './InquiryNote.js';

/**
 * Registers all models on a Sequelize instance. The schema itself is owned by
 * schema.sql — never call sequelize.sync() against a real database.
 */
export function initModels(sequelize) {
  const Admin = defineAdmin(sequelize);
  const Inquiry = defineInquiry(sequelize);
  const InquiryNote = defineInquiryNote(sequelize);
  const InquiryActivity = defineInquiryActivity(sequelize);

  Inquiry.hasMany(InquiryNote, { as: 'notes', foreignKey: 'inquiryId' });
  InquiryNote.belongsTo(Inquiry, { foreignKey: 'inquiryId' });
  Inquiry.hasMany(InquiryActivity, { as: 'activities', foreignKey: 'inquiryId' });
  InquiryActivity.belongsTo(Inquiry, { foreignKey: 'inquiryId' });

  return { Admin, Inquiry, InquiryNote, InquiryActivity };
}
