import { DataTypes } from 'sequelize';

export const ACTIVITY_TYPES = Object.freeze([
  'received',
  'status',
  'note',
  'assignment',
  'follow_up',
  'outcome',
  'update',
]);

/** Maps to public.inquiry_activities (schema.sql). Append-only. */
export function defineInquiryActivity(sequelize) {
  return sequelize.define(
    'InquiryActivity',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      inquiryId: {
        type: DataTypes.UUID,
        field: 'inquiry_id',
        allowNull: false,
      },
      adminId: {
        type: DataTypes.UUID,
        field: 'admin_id',
        allowNull: true,
      },
      adminEmail: {
        type: DataTypes.TEXT,
        field: 'admin_email',
        allowNull: true,
      },
      type: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: { isIn: [[...ACTIVITY_TYPES]] },
      },
      summary: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      createdAt: {
        type: DataTypes.DATE,
        field: 'created_at',
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'inquiry_activities',
      timestamps: true,
      updatedAt: false,
    },
  );
}