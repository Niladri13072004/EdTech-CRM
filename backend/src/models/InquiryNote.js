import { DataTypes } from 'sequelize';

/** Maps to public.inquiry_notes (schema.sql). */
export function defineInquiryNote(sequelize) {
  return sequelize.define(
    'InquiryNote',
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
        allowNull: false,
      },
      body: {
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
      tableName: 'inquiry_notes',
      timestamps: true,
      updatedAt: false,
    },
  );
}