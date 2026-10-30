import { DataTypes } from 'sequelize';
import {
  CATEGORIES,
  DEFAULT_INQUIRY_STATUS,
  FIELD_LIMITS,
  INQUIRY_STATUSES,
  PHONE_PATTERN,
  USER_TYPES,
} from '../constants/inquiry.js';

/** Maps to public.inquiries (schema.sql). Attribute names are camelCase; columns snake_case. */
export function defineInquiry(sequelize) {
  return sequelize.define(
    'Inquiry',
    {
      id: {
        type: DataTypes.UUID,
        field: 'id',
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      name: {
        type: DataTypes.TEXT,
        field: 'name',
        allowNull: false,
        validate: {
          len: [FIELD_LIMITS.name.min, FIELD_LIMITS.name.max],
        },
      },
      email: {
        type: DataTypes.TEXT,
        field: 'email',
        allowNull: false,
        validate: {
          isEmail: true,
          len: [3, FIELD_LIMITS.email.max],
        },
      },
      phone: {
        type: DataTypes.TEXT,
        field: 'phone',
        allowNull: false,
        validate: {
          len: [1, FIELD_LIMITS.phone.maxLength],
          is: PHONE_PATTERN,
          hasValidDigitCount(value) {
            const digits = String(value).replace(/\D/g, '').length;
            const { minDigits, maxDigits } = FIELD_LIMITS.phone;
            if (digits < minDigits || digits > maxDigits) {
              throw new Error(`Phone number must contain ${minDigits}-${maxDigits} digits`);
            }
          },
        },
      },
      userType: {
        type: DataTypes.TEXT,
        field: 'user_type',
        allowNull: false,
        validate: { isIn: [[...USER_TYPES]] },
      },
      category: {
        type: DataTypes.TEXT,
        field: 'category',
        allowNull: false,
        validate: { isIn: [[...CATEGORIES]] },
      },
      message: {
        type: DataTypes.TEXT,
        field: 'message',
        allowNull: false,
        validate: {
          len: [FIELD_LIMITS.message.min, FIELD_LIMITS.message.max],
        },
      },
      status: {
        type: DataTypes.TEXT,
        field: 'status',
        allowNull: false,
        defaultValue: DEFAULT_INQUIRY_STATUS,
        validate: { isIn: [[...INQUIRY_STATUSES]] },
      },
      assignedAdminId: {
        type: DataTypes.UUID,
        field: 'assigned_admin_id',
        allowNull: true,
      },
      followUpDate: {
        type: DataTypes.DATEONLY,
        field: 'follow_up_date',
        allowNull: true,
      },
      followUpOutcome: {
        type: DataTypes.TEXT,
        field: 'follow_up_outcome',
        allowNull: true,
      },
      createdAt: {
        type: DataTypes.DATE,
        field: 'created_at',
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      updatedAt: {
        type: DataTypes.DATE,
        field: 'updated_at',
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'inquiries',
      timestamps: true,
      hooks: {
        // Each NOW default is evaluated separately, so the two timestamps can
        // differ by a millisecond on insert. A new row was created and last
        // updated at the same instant.
        beforeCreate(inquiry) {
          inquiry.updatedAt = inquiry.createdAt;
        },
      },
    },
  );
}
