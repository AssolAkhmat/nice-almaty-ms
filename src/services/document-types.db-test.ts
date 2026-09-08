import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ForbiddenError, ValidationError } from '@/lib/errors';

import {
  archiveDocumentType,
  createDocumentType,
  listDocumentTypes,
  updateDocumentType,
} from './document-types';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Типы документов у суперадмина (T8.2, модуль 11 «Настройки сети»).
 *
 * До этого экрана типы заводил только сид: очистка боевой базы оставила сеть
 * без них, и вернуть их было неоткуда. Поэтому проверяется не столько форма,
 * сколько границы — кто может править и что нельзя сломать уже загруженным
 * документам.
 */
const url = testDatabaseUrl();
const client = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => undefined });
const db = drizzle(client, { schema }) as unknown as Database;

afterAll(async () => {
  await client.end();
});

class Rollback extends Error {}

async function inRollback(body: (tx: Transaction) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await body(tx);

      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error;
    }
  }
}

interface Fixture {
  superadmin: UserActor;
  admin: UserActor;
  orgId: string;
}

async function seed(tx: Transaction, suffix: string): Promise<Fixture> {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `dt-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `dt-a-${suffix}` })
    .returning();
  const houseId = house?.id ?? '';

  const [chief] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7709${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();

  const [manager] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7710${suffix}`, passwordHash: 'x', role: 'admin', houseId })
    .returning();

  const context = (user: typeof chief, role: AccessContext['role'], house: string | null) => ({
    context: { orgId, userId: user?.id ?? '', role, houseId: house },
    requestId: `dt-${suffix}`,
  });

  return {
    orgId,
    superadmin: context(chief, 'superadmin', null),
    admin: context(manager, 'admin', houseId),
  };
}

const INPUT = {
  code: 'insurance',
  nameI18n: { ru: 'Страховка', kk: 'Сақтандыру', en: 'Insurance' },
  validityMonths: 12,
  requiresIssueDate: false,
  isRequired: true,
  sortOrder: 40,
};

describe('типы документов', () => {
  it('суперадмин заводит тип, и он попадает в журнал', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2001');

      const created = await createDocumentType(fixture.superadmin, INPUT, tx);

      expect(created.code).toBe('insurance');
      expect(created.validityMonths).toBe(12);

      const audit = await tx
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.entityId, created.id));

      expect(audit).toHaveLength(1);
      expect(audit[0]?.action).toBe('document_type.saved');
    });
  });

  it('админу типы сети не подчиняются: ни завести, ни переименовать, ни увидеть список', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2002');
      const created = await createDocumentType(fixture.superadmin, INPUT, tx);

      await expect(createDocumentType(fixture.admin, INPUT, tx)).rejects.toThrow(ForbiddenError);
      await expect(
        updateDocumentType(fixture.admin, created.id, { sortOrder: 1 }, tx),
      ).rejects.toThrow(ForbiddenError);
      await expect(archiveDocumentType(fixture.admin, created.id, tx)).rejects.toThrow(
        ForbiddenError,
      );
      await expect(listDocumentTypes(fixture.admin, {}, tx)).rejects.toThrow(ForbiddenError);
    });
  });

  it('код уникален в сети', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2003');
      await createDocumentType(fixture.superadmin, INPUT, tx);

      await expect(createDocumentType(fixture.superadmin, INPUT, tx)).rejects.toThrow(
        ValidationError,
      );
    });
  });

  it('код — латиница нижнего регистра: он идёт в путь хранения', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2004');

      await expect(
        createDocumentType(fixture.superadmin, { ...INPUT, code: 'Страховка' }, tx),
      ).rejects.toThrow(ValidationError);
      await expect(
        createDocumentType(fixture.superadmin, { ...INPUT, code: 'INSURANCE' }, tx),
      ).rejects.toThrow(ValidationError);
    });
  });

  it('название обязательно во всех трёх локалях', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2005');

      await expect(
        createDocumentType(
          fixture.superadmin,
          { ...INPUT, nameI18n: { ru: 'Страховка', kk: '', en: 'Insurance' } },
          tx,
        ),
      ).rejects.toThrow(ValidationError);
    });
  });

  it('срок годности либо пуст, либо разумен', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2006');

      await expect(
        createDocumentType(fixture.superadmin, { ...INPUT, validityMonths: 0 }, tx),
      ).rejects.toThrow(ValidationError);
      await expect(
        createDocumentType(fixture.superadmin, { ...INPUT, validityMonths: 1000 }, tx),
      ).rejects.toThrow(ValidationError);

      const forever = await createDocumentType(
        fixture.superadmin,
        { ...INPUT, code: 'photo', validityMonths: null },
        tx,
      );
      expect(forever.validityMonths).toBeNull();
    });
  });

  it('переименование не трогает код: на него ссылаются загруженные документы', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2007');
      const created = await createDocumentType(fixture.superadmin, INPUT, tx);

      const updated = await updateDocumentType(
        fixture.superadmin,
        created.id,
        {
          nameI18n: { ru: 'Медстраховка', kk: 'Медсақтандыру', en: 'Health insurance' },
          validityMonths: 24,
        },
        tx,
      );

      expect(updated.code).toBe('insurance');
      expect(updated.nameI18n).toMatchObject({ ru: 'Медстраховка' });
      expect(updated.validityMonths).toBe(24);
    });
  });

  it('архивация прячет тип из списка, но не удаляет его', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2008');
      const created = await createDocumentType(fixture.superadmin, INPUT, tx);

      await archiveDocumentType(fixture.superadmin, created.id, tx);

      const active = await listDocumentTypes(fixture.superadmin, {}, tx);
      const all = await listDocumentTypes(fixture.superadmin, { includeArchived: true }, tx);

      expect(active.map((type) => type.id)).not.toContain(created.id);
      expect(all.map((type) => type.id)).toContain(created.id);
    });
  });
});
