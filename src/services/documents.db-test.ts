import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { parseBusinessDate } from '@/lib/time';

import {
  listDocumentCards,
  listPendingDocuments,
  reviewDocument,
  submitDocument,
} from './documents';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Документы жильца: сроки годности §1.3, проверка админом, изоляция домов.
 *
 * Расчёт сроков проверен числами в `src/domain/documents.test.ts`; здесь —
 * то, что живёт только в базе: кто чей документ видит, что попадает в журнал
 * и что происходит с непринятым файлом.
 */
const url = process.env.TEST_DATABASE_URL ?? 'postgres://nice:nice@localhost:5432/nice_almaty';
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

const TODAY = parseBusinessDate('2027-03-15');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `doc-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `doc-a-${suffix}` })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `doc-b-${suffix}` })
    .returning();

  const [types] = await tx
    .insert(schema.documentTypes)
    .values([
      {
        orgId,
        code: 'photo_3x4',
        nameI18n: { ru: 'Фото 3×4' },
        validityMonths: null,
        requiresIssueDate: false,
        sortOrder: 10,
      },
      {
        orgId,
        code: 'dispensary',
        nameI18n: { ru: 'Справка' },
        validityMonths: 12,
        requiresIssueDate: false,
        sortOrder: 20,
      },
      {
        orgId,
        code: 'fluorography',
        nameI18n: { ru: 'Флюорография' },
        validityMonths: 12,
        requiresIssueDate: true,
        sortOrder: 30,
      },
    ])
    .returning();
  void types;

  const typeRows = await tx.select().from(schema.documentTypes);
  const typeId = (code: string) => typeRows.find((row) => row.code === code)?.id ?? '';

  async function resident(index: number, houseId: string) {
    const [user] = await tx
      .insert(schema.users)
      .values({ orgId, phone: `+7708${index}${suffix}`, passwordHash: 'x', role: 'resident' })
      .returning();

    const [residency] = await tx
      .insert(schema.residencies)
      .values({ orgId, userId: user?.id ?? '', houseId })
      .returning();

    return { userId: user?.id ?? '', residencyId: residency?.id ?? '' };
  }

  const [adminUser] = await tx
    .insert(schema.users)
    .values({
      orgId,
      phone: `+7707${suffix}`,
      passwordHash: 'x',
      role: 'admin',
      houseId: houseA?.id ?? '',
    })
    .returning();

  const a = await resident(1, houseA?.id ?? '');
  const b = await resident(2, houseB?.id ?? '');

  const context = (
    role: AccessContext['role'],
    userId: string,
    houseId: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });

  /** Принятый файл: двухшаговая загрузка уже отработала (T2.6). */
  async function readyFile(residencyId: string, userId: string, name: string) {
    const [file] = await tx
      .insert(schema.files)
      .values({
        orgId,
        residencyId,
        provider: 'local',
        path: `doc-${suffix}/${name}`,
        mime: 'image/jpeg',
        sizeBytes: 4096,
        originalName: `${name}.jpg`,
        uploadedBy: userId,
        status: 'ready',
      })
      .returning();

    return file?.id ?? '';
  }

  return {
    orgId,
    typeId,
    residentA: actor(context('resident', a.userId, null)),
    residentB: actor(context('resident', b.userId, null)),
    adminA: actor(context('admin', adminUser?.id ?? '', houseA?.id ?? null)),
    residencyA: a.residencyId,
    residencyB: b.residencyId,
    userA: a.userId,
    userB: b.userId,
    readyFile,
  };
}

describe('загрузка документа', () => {
  it('справка получает срок в год от даты загрузки', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5001');
      const fileId = await fixture.readyFile(fixture.residencyA, fixture.userA, 'spravka');

      const document = await submitDocument(
        fixture.residentA,
        {
          residencyId: fixture.residencyA,
          documentTypeId: fixture.typeId('dispensary'),
          fileId,
          issueDate: null,
        },
        { executor: tx, today: TODAY },
      );

      expect(document.status).toBe('uploaded');
      expect(document.validFrom).toBe('2027-03-15');
      expect(document.validUntil).toBe('2028-03-15');
    });
  });

  it('флюорография считает срок от даты снимка, а не от загрузки', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5002');
      const fileId = await fixture.readyFile(fixture.residencyA, fixture.userA, 'fluo');

      const document = await submitDocument(
        fixture.residentA,
        {
          residencyId: fixture.residencyA,
          documentTypeId: fixture.typeId('fluorography'),
          fileId,
          issueDate: parseBusinessDate('2027-01-10'),
        },
        { executor: tx, today: TODAY },
      );

      expect(document.validFrom).toBe('2027-01-10');
      expect(document.validUntil).toBe('2028-01-10');
    });
  });

  it('флюорография без даты снимка не принимается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5003');
      const fileId = await fixture.readyFile(fixture.residencyA, fixture.userA, 'fluo');

      await expect(
        submitDocument(
          fixture.residentA,
          {
            residencyId: fixture.residencyA,
            documentTypeId: fixture.typeId('fluorography'),
            fileId,
            issueDate: null,
          },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toThrow(ValidationError);
    });
  });

  it('фото 3×4 бессрочно', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5004');
      const fileId = await fixture.readyFile(fixture.residencyA, fixture.userA, 'photo');

      const document = await submitDocument(
        fixture.residentA,
        {
          residencyId: fixture.residencyA,
          documentTypeId: fixture.typeId('photo_3x4'),
          fileId,
          issueDate: null,
        },
        { executor: tx, today: TODAY },
      );

      expect(document.validUntil).toBeNull();
    });
  });

  it('неподтверждённый файл документом не становится', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5005');
      const [pending] = await tx
        .insert(schema.files)
        .values({
          orgId: fixture.orgId,
          residencyId: fixture.residencyA,
          provider: 'local',
          path: `doc-5005/pending`,
          mime: 'image/jpeg',
          sizeBytes: 4096,
          originalName: 'pending.jpg',
          uploadedBy: fixture.userA,
        })
        .returning();

      await expect(
        submitDocument(
          fixture.residentA,
          {
            residencyId: fixture.residencyA,
            documentTypeId: fixture.typeId('photo_3x4'),
            fileId: pending?.id ?? '',
            issueDate: null,
          },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toThrow(ConflictError);
    });
  });

  it('чужое проживание неотличимо от несуществующего', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5006');
      const fileId = await fixture.readyFile(fixture.residencyB, fixture.userB, 'spravka');

      await expect(
        submitDocument(
          fixture.residentA,
          {
            residencyId: fixture.residencyB,
            documentTypeId: fixture.typeId('dispensary'),
            fileId,
            issueDate: null,
          },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toThrow(NotFoundError);
    });
  });

  it('загрузка попадает в журнал', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5007');
      const fileId = await fixture.readyFile(fixture.residencyA, fixture.userA, 'spravka');

      await submitDocument(
        fixture.residentA,
        {
          residencyId: fixture.residencyA,
          documentTypeId: fixture.typeId('dispensary'),
          fileId,
          issueDate: null,
        },
        { executor: tx, today: TODAY },
      );

      const entries = await tx.select().from(schema.auditLog);
      expect(entries.map((entry) => entry.action)).toContain('document.submitted');
    });
  });
});

describe('проверка документа', () => {
  async function uploaded(tx: Transaction, suffix: string) {
    const fixture = await seed(tx, suffix);
    const fileId = await fixture.readyFile(fixture.residencyA, fixture.userA, 'spravka');

    const document = await submitDocument(
      fixture.residentA,
      {
        residencyId: fixture.residencyA,
        documentTypeId: fixture.typeId('dispensary'),
        fileId,
        issueDate: null,
      },
      { executor: tx, today: TODAY },
    );

    return { fixture, document };
  }

  it('админ дома принимает документ', async () => {
    await inRollback(async (tx) => {
      const { fixture, document } = await uploaded(tx, '5010');

      const approved = await reviewDocument(
        fixture.adminA,
        document.id,
        { approve: true },
        { executor: tx, today: TODAY },
      );

      expect(approved.status).toBe('approved');
      expect(approved.reviewedAt).not.toBeNull();
      expect(approved.rejectReason).toBeNull();
    });
  });

  it('отклонение без причины не проходит: жильцу нечего исправлять', async () => {
    await inRollback(async (tx) => {
      const { fixture, document } = await uploaded(tx, '5011');

      await expect(
        reviewDocument(
          fixture.adminA,
          document.id,
          { approve: false, reason: '   ' },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toThrow(ValidationError);
    });
  });

  it('отклонение сохраняет причину и попадает в журнал', async () => {
    await inRollback(async (tx) => {
      const { fixture, document } = await uploaded(tx, '5012');

      const rejected = await reviewDocument(
        fixture.adminA,
        document.id,
        { approve: false, reason: 'Снимок нечитаем' },
        { executor: tx, today: TODAY },
      );

      expect(rejected.status).toBe('rejected');
      expect(rejected.rejectReason).toBe('Снимок нечитаем');

      const entries = await tx.select().from(schema.auditLog);
      expect(entries.map((entry) => entry.action)).toContain('document.rejected');
    });
  });

  it('жилец не проверяет собственные документы', async () => {
    await inRollback(async (tx) => {
      const { fixture, document } = await uploaded(tx, '5013');

      await expect(
        reviewDocument(
          fixture.residentA,
          document.id,
          { approve: true },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  it('документ чужого дома для админа не существует', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5014');
      const fileId = await fixture.readyFile(fixture.residencyB, fixture.userB, 'spravka');

      const foreign = await submitDocument(
        fixture.residentB,
        {
          residencyId: fixture.residencyB,
          documentTypeId: fixture.typeId('dispensary'),
          fileId,
          issueDate: null,
        },
        { executor: tx, today: TODAY },
      );

      await expect(
        reviewDocument(
          fixture.adminA,
          foreign.id,
          { approve: true },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toThrow(NotFoundError);
    });
  });
});

describe('карточки документов', () => {
  it('показывают все типы, включая ещё не загруженные', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5020');

      const cards = await listDocumentCards(fixture.residentA, fixture.residencyA, {
        executor: tx,
        today: TODAY,
      });

      expect(cards.map((card) => card.type.code)).toEqual([
        'photo_3x4',
        'dispensary',
        'fluorography',
      ]);
      expect(cards.every((card) => card.document === null)).toBe(true);
    });
  });

  it('считают состояние срока на сегодня', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5021');
      const fileId = await fixture.readyFile(fixture.residencyA, fixture.userA, 'fluo');

      await submitDocument(
        fixture.residentA,
        {
          residencyId: fixture.residencyA,
          documentTypeId: fixture.typeId('fluorography'),
          fileId,
          // Снимок годичной давности: на сегодня он уже просрочен.
          issueDate: parseBusinessDate('2026-01-10'),
        },
        { executor: tx, today: TODAY },
      );

      const cards = await listDocumentCards(fixture.residentA, fixture.residencyA, {
        executor: tx,
        today: TODAY,
      });

      const fluorography = cards.find((card) => card.type.code === 'fluorography');
      expect(fluorography?.validity).toBe('expired');
      expect(fluorography?.daysLeft).toBeLessThan(0);
    });
  });

  it('бессрочный документ не истекает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5022');
      const fileId = await fixture.readyFile(fixture.residencyA, fixture.userA, 'photo');

      await submitDocument(
        fixture.residentA,
        {
          residencyId: fixture.residencyA,
          documentTypeId: fixture.typeId('photo_3x4'),
          fileId,
          issueDate: null,
        },
        { executor: tx, today: TODAY },
      );

      const cards = await listDocumentCards(fixture.residentA, fixture.residencyA, {
        executor: tx,
        today: TODAY,
      });

      expect(cards.find((card) => card.type.code === 'photo_3x4')?.validity).toBe('permanent');
    });
  });

  it('чужие карточки жильцу недоступны', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5023');

      await expect(
        listDocumentCards(fixture.residentA, fixture.residencyB, { executor: tx, today: TODAY }),
      ).rejects.toThrow(NotFoundError);
    });
  });
});

describe('очередь проверки', () => {
  it('админ видит документы только своего дома', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5030');

      const ownFile = await fixture.readyFile(fixture.residencyA, fixture.userA, 'own');
      const foreignFile = await fixture.readyFile(fixture.residencyB, fixture.userB, 'foreign');

      await submitDocument(
        fixture.residentA,
        {
          residencyId: fixture.residencyA,
          documentTypeId: fixture.typeId('dispensary'),
          fileId: ownFile,
          issueDate: null,
        },
        { executor: tx, today: TODAY },
      );
      await submitDocument(
        fixture.residentB,
        {
          residencyId: fixture.residencyB,
          documentTypeId: fixture.typeId('dispensary'),
          fileId: foreignFile,
          issueDate: null,
        },
        { executor: tx, today: TODAY },
      );

      const pending = await listPendingDocuments(fixture.adminA, { executor: tx, today: TODAY });

      expect(pending).toHaveLength(1);
      expect(pending[0]?.residencyId).toBe(fixture.residencyA);
    });
  });

  it('проверенный документ из очереди уходит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5031');
      const fileId = await fixture.readyFile(fixture.residencyA, fixture.userA, 'own');

      const document = await submitDocument(
        fixture.residentA,
        {
          residencyId: fixture.residencyA,
          documentTypeId: fixture.typeId('dispensary'),
          fileId,
          issueDate: null,
        },
        { executor: tx, today: TODAY },
      );

      await reviewDocument(
        fixture.adminA,
        document.id,
        { approve: true },
        { executor: tx, today: TODAY },
      );

      expect(await listPendingDocuments(fixture.adminA, { executor: tx, today: TODAY })).toEqual(
        [],
      );
    });
  });
});
