import {
  boolean,
  customType,
  date,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './users';

export const sexEnum = pgEnum('sex', ['male', 'female']);

export const preferredPaymentEnum = pgEnum('preferred_payment', ['kaspi', 'cash']);

/** Зашифрованное поле: в базе сырые байты, расшифровка — только в сервисе. */
const encrypted = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value: Uint8Array): Buffer {
    return Buffer.from(value);
  },
  fromDriver(value: Buffer): Uint8Array {
    return new Uint8Array(value);
  },
});

/**
 * Профиль жильца (docs/04-MODULES/01-onboarding.md, docs/02-DATA-MODEL.md).
 *
 * ИИН и номер УДЛ лежат зашифрованными, рядом — только последние четыре знака
 * для поиска и показа. Расшифровка идёт через сервис и пишет событие в аудит.
 */
export const residentProfiles = pgTable('resident_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  lastName: text('last_name'),
  firstName: text('first_name'),
  middleName: text('middle_name'),
  sex: sexEnum('sex'),
  birthDate: date('birth_date'),
  phone: text('phone'),
  idDocNumberEnc: encrypted('id_doc_number_enc'),
  idDocLast4: text('id_doc_last4'),
  /**
   * Орган выдачи удостоверения. Не шифруется: он не опознаёт человека,
   * в отличие от номера, и в договоре печатается как есть (T8.1).
   */
  idDocIssuer: text('id_doc_issuer').default('МВД РК'),
  /** Адрес прописки. В договоре — реквизит нанимателя, к месту в доме отношения не имеет. */
  registrationAddress: text('registration_address'),
  iinEnc: encrypted('iin_enc'),
  iinLast4: text('iin_last4'),
  university: text('university'),
  course: integer('course'),
  major: text('major'),
  emergencyName: text('emergency_name'),
  emergencyPhone: text('emergency_phone'),
  emergencyRelation: text('emergency_relation'),
  preferredPayment: preferredPaymentEnum('preferred_payment'),
  /* Ссылка на файл без внешнего ключа: таблица `files` появляется в T2.6. */
  photoFileId: uuid('photo_file_id'),
  noEpilepsy: boolean('no_epilepsy'),
  noAsthma: boolean('no_asthma'),
  healthDeclaredAt: timestamp('health_declared_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ResidentProfile = typeof residentProfiles.$inferSelect;
export type NewResidentProfile = typeof residentProfiles.$inferInsert;
