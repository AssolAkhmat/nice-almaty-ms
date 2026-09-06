import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { NotFoundError } from '@/lib/errors';

import { createFile, findFile, requireFile, updateFile } from './files';

import type { AccessContext } from '../access';
import type { Database, Transaction } from '../client';

/**
 * Видимость файла идёт через проживание — тем же правилом, что и всё
 * остальное в фазе 2. Своей копии правила у файлов нет: две копии
 * однажды разойдутся, и разойдутся молча.
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

function errorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;

  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }

  return parts.join(' | ');
}

async function failureText(
  tx: Transaction,
  body: (inner: Transaction) => Promise<unknown>,
): Promise<string> {
  try {
    await tx.transaction(async (inner) => {
      await body(inner);
    });
    return '';
  } catch (error) {
    return errorChain(error);
  }
}

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `file-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `file-a-${suffix}` })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `file-b-${suffix}` })
    .returning();

  const [userA] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+77081${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();
  const [userB] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+77082${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  const [residencyA] = await tx
    .insert(schema.residencies)
    .values({ orgId, userId: userA?.id ?? '', houseId: houseA?.id ?? '' })
    .returning();
  const [residencyB] = await tx
    .insert(schema.residencies)
    .values({ orgId, userId: userB?.id ?? '', houseId: houseB?.id ?? '' })
    .returning();

  const superadmin: AccessContext = {
    orgId,
    userId: '00000000-0000-0000-0000-000000000000',
    role: 'superadmin',
    houseId: null,
  };
  const adminA: AccessContext = {
    orgId,
    userId: '00000000-0000-0000-0000-000000000001',
    role: 'admin',
    houseId: houseA?.id ?? null,
  };
  const residentA: AccessContext = {
    orgId,
    userId: userA?.id ?? '',
    role: 'resident',
    houseId: null,
  };
  const residentB: AccessContext = {
    orgId,
    userId: userB?.id ?? '',
    role: 'resident',
    houseId: null,
  };

  return {
    orgId,
    residencyA: residencyA?.id ?? '',
    residencyB: residencyB?.id ?? '',
    superadmin,
    adminA,
    residentA,
    residentB,
  };
}

function fileInput(residencyId: string, uploadedBy: string, path: string) {
  return {
    residencyId,
    provider: 'local' as const,
    path,
    mime: 'image/jpeg',
    sizeBytes: 120_000,
    originalName: 'spravka.jpg',
    uploadedBy,
    scope: { documentType: 'fluorography' },
  };
}

describe('файлы', () => {
  it('создаются со статусом pending: готовым файл становится только после подтверждения', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2001');

      const file = await createFile(
        fixture.residentA,
        fileInput(fixture.residencyA, fixture.residentA.userId, 'a/1/fluorography/f1.jpg'),
        tx,
      );

      expect(file.status).toBe('pending');
      expect(file.orgId).toBe(fixture.orgId);
      expect(file.checksum).toBeNull();
      expect(file.externalId).toBeNull();
    });
  });

  it('жилец видит свой файл', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2002');
      const file = await createFile(
        fixture.residentA,
        fileInput(fixture.residencyA, fixture.residentA.userId, 'a/1/fluorography/f2.jpg'),
        tx,
      );

      await expect(requireFile(fixture.residentA, file.id, tx)).resolves.toMatchObject({
        id: file.id,
      });
    });
  });

  it('чужой файл жильцу неотличим от несуществующего', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2003');
      const file = await createFile(
        fixture.residentA,
        fileInput(fixture.residencyA, fixture.residentA.userId, 'a/1/fluorography/f3.jpg'),
        tx,
      );

      await expect(findFile(fixture.residentB, file.id, tx)).resolves.toBeNull();
      await expect(requireFile(fixture.residentB, file.id, tx)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  it('админ видит файл жильца своего дома и не видит файл чужого', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2004');

      const own = await createFile(
        fixture.residentA,
        fileInput(fixture.residencyA, fixture.residentA.userId, 'a/1/fluorography/f4.jpg'),
        tx,
      );
      const foreign = await createFile(
        fixture.residentB,
        fileInput(fixture.residencyB, fixture.residentB.userId, 'b/1/fluorography/f5.jpg'),
        tx,
      );

      await expect(findFile(fixture.adminA, own.id, tx)).resolves.not.toBeNull();
      await expect(findFile(fixture.adminA, foreign.id, tx)).resolves.toBeNull();
    });
  });

  it('суперадмин видит файлы любого дома сети', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2005');
      const foreign = await createFile(
        fixture.residentB,
        fileInput(fixture.residencyB, fixture.residentB.userId, 'b/1/fluorography/f6.jpg'),
        tx,
      );

      await expect(findFile(fixture.superadmin, foreign.id, tx)).resolves.not.toBeNull();
    });
  });

  it('файл соседней сети не виден даже суперадмину', async () => {
    await inRollback(async (tx) => {
      const first = await seed(tx, '2006');
      const second = await seed(tx, '2007');

      const file = await createFile(
        second.residentA,
        fileInput(second.residencyA, second.residentA.userId, 'a/2/fluorography/f7.jpg'),
        tx,
      );

      await expect(findFile(first.superadmin, file.id, tx)).resolves.toBeNull();
    });
  });

  it('обновление тоже отфильтровано: чужой файл не перевести в ready', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2008');
      const foreign = await createFile(
        fixture.residentB,
        fileInput(fixture.residencyB, fixture.residentB.userId, 'b/1/fluorography/f8.jpg'),
        tx,
      );

      await expect(
        updateFile(fixture.adminA, foreign.id, { status: 'ready' }, tx),
      ).resolves.toBeNull();

      const [row] = await tx.select().from(schema.files).where(eq(schema.files.id, foreign.id));
      expect(row?.status).toBe('pending');
    });
  });

  it('свой файл переводится в ready вместе с фактическим размером и контрольной суммой', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2009');
      const file = await createFile(
        fixture.residentA,
        fileInput(fixture.residencyA, fixture.residentA.userId, 'a/1/fluorography/f9.jpg'),
        tx,
      );

      const updated = await updateFile(
        fixture.residentA,
        file.id,
        { status: 'ready', sizeBytes: 118_003, checksum: 'sha256:abc' },
        tx,
      );

      expect(updated).toMatchObject({
        status: 'ready',
        sizeBytes: 118_003,
        checksum: 'sha256:abc',
      });
    });
  });

  /**
   * Две записи на один объект хранилища означали бы два разных набора прав
   * на одни и те же байты. База такого не допускает.
   */
  it('один путь в хранилище — одна запись', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2010');
      const input = fileInput(
        fixture.residencyA,
        fixture.residentA.userId,
        'a/1/fluorography/same.jpg',
      );

      await createFile(fixture.residentA, input, tx);

      const failure = await failureText(tx, (inner) => createFile(fixture.residentA, input, inner));

      expect(failure).toMatch(/files_provider_path_unique|duplicate key/i);
    });
  });
});
