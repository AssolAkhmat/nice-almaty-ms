import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { createLocalStorage } from '@/adapters/storage/local';
import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { MAX_UPLOAD_BYTES } from '@/domain/files';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';

import {
  completeUpload,
  createHouseUploadSession,
  createUploadSession,
  readFileContent,
  receiveUploadedBytes,
} from './files';

import type { StorageProvider } from '@/adapters/storage';
import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Двухшаговая загрузка целиком (docs/01-ARCHITECTURE.md, D4):
 * сессия — байты — подтверждение. Хранилище настоящее, локальный драйвер
 * во временном каталоге: подделка хранилища проверяла бы подделку.
 */
const url = testDatabaseUrl();
const client = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => undefined });
const db = drizzle(client, { schema }) as unknown as Database;

const roots: string[] = [];

afterAll(async () => {
  await client.end();
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function freshStorage(): StorageProvider {
  const root = mkdtempSync(join(tmpdir(), 'nice-files-'));
  roots.push(root);

  return createLocalStorage(root);
}

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

const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0];

/** Настоящее начало JPEG плюс наполнитель до нужного размера. */
function jpegBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(JPEG_HEAD, 0);

  return bytes;
}

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `svc-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `svc-a-${suffix}` })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `svc-b-${suffix}` })
    .returning();

  const [userA] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+77091${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();
  const [userB] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+77092${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();
  const [adminUser] = await tx
    .insert(schema.users)
    .values({
      orgId,
      phone: `+77093${suffix}`,
      passwordHash: 'x',
      role: 'admin',
      houseId: houseA?.id ?? '',
    })
    .returning();

  const [residencyA] = await tx
    .insert(schema.residencies)
    .values({ orgId, userId: userA?.id ?? '', houseId: houseA?.id ?? '' })
    .returning();
  const [residencyB] = await tx
    .insert(schema.residencies)
    .values({ orgId, userId: userB?.id ?? '', houseId: houseB?.id ?? '' })
    .returning();

  const context = (role: AccessContext['role'], userId: string, houseId: string | null) => ({
    orgId,
    userId,
    role,
    houseId,
  });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });

  const [superUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+77094${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();

  return {
    orgId,
    houseA: houseA?.id ?? '',
    houseB: houseB?.id ?? '',
    residencyA: residencyA?.id ?? '',
    residencyB: residencyB?.id ?? '',
    residentA: actor(context('resident', userA?.id ?? '', null)),
    residentB: actor(context('resident', userB?.id ?? '', null)),
    adminA: actor(context('admin', adminUser?.id ?? '', houseA?.id ?? null)),
    adminB: actor(context('admin', adminUser?.id ?? '', houseB?.id ?? null)),
    superadmin: actor(context('superadmin', superUser?.id ?? '', null)),
    houseSlug: `svc-a-${suffix}`,
  };
}

function sessionInput(residencyId: string, sizeBytes = 4096) {
  return {
    residencyId,
    documentType: 'fluorography',
    mime: 'image/jpeg',
    sizeBytes,
    originalName: 'флюорография.jpg',
  };
}

describe('сессия загрузки', () => {
  it('создаёт запись pending и адрес для прямой загрузки', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3001');
      const storage = freshStorage();

      const session = await createUploadSession(
        fixture.residentA,
        sessionInput(fixture.residencyA),
        {
          executor: tx,
          storage,
        },
      );

      expect(session.upload.method).toBe('PUT');
      expect(session.upload.url).toBe(`/api/v1/files/${session.fileId}/blob`);

      const [row] = await tx
        .select()
        .from(schema.files)
        .where(eq(schema.files.orgId, fixture.orgId));
      expect(row).toMatchObject({ status: 'pending', provider: 'local', mime: 'image/jpeg' });
    });
  });

  /** Путь из архитектуры: /{house_slug}/{residency_id}/{document_type}/. */
  it('кладёт файл по пути из архитектуры, а не по имени от пользователя', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3002');
      const storage = freshStorage();

      const session = await createUploadSession(
        fixture.residentA,
        sessionInput(fixture.residencyA),
        {
          executor: tx,
          storage,
        },
      );

      const [row] = await tx
        .select()
        .from(schema.files)
        .where(eq(schema.files.orgId, fixture.orgId));
      expect(row?.path).toBe(
        `${fixture.houseSlug}/${fixture.residencyA}/fluorography/${session.fileId}.jpg`,
      );
      expect(row?.originalName).toBe('флюорография.jpg');
    });
  });

  it('чужое проживание неотличимо от несуществующего', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3003');
      const storage = freshStorage();

      await expect(
        createUploadSession(fixture.residentA, sessionInput(fixture.residencyB), {
          executor: tx,
          storage,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('админ загружает документ жильцу своего дома', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3004');
      const storage = freshStorage();

      await expect(
        createUploadSession(fixture.adminA, sessionInput(fixture.residencyA), {
          executor: tx,
          storage,
        }),
      ).resolves.toMatchObject({ upload: { method: 'PUT' } });
    });
  });

  it('запрещённый тип отклоняется до создания записи', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3005');
      const storage = freshStorage();

      await expect(
        createUploadSession(
          fixture.residentA,
          { ...sessionInput(fixture.residencyA), mime: 'text/html' },
          { executor: tx, storage },
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(
        await tx.select().from(schema.files).where(eq(schema.files.orgId, fixture.orgId)),
      ).toHaveLength(0);
    });
  });

  it('слишком крупный файл отклоняется до создания записи', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3006');
      const storage = freshStorage();

      await expect(
        createUploadSession(
          fixture.residentA,
          sessionInput(fixture.residencyA, MAX_UPLOAD_BYTES + 1),
          {
            executor: tx,
            storage,
          },
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(
        await tx.select().from(schema.files).where(eq(schema.files.orgId, fixture.orgId)),
      ).toHaveLength(0);
    });
  });
});

describe('приём байтов и подтверждение', () => {
  it('полный цикл доводит файл до ready с контрольной суммой', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3101');
      const storage = freshStorage();
      const bytes = jpegBytes(4096);

      const session = await createUploadSession(
        fixture.residentA,
        sessionInput(fixture.residencyA),
        {
          executor: tx,
          storage,
        },
      );

      await receiveUploadedBytes(fixture.residentA, session.fileId, bytes, {
        executor: tx,
        storage,
      });

      const ready = await completeUpload(fixture.residentA, session.fileId, {
        executor: tx,
        storage,
      });

      expect(ready.status).toBe('ready');
      expect(ready.sizeBytes).toBe(4096);
      expect(ready.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });

  it('подтверждение пишет событие в журнал', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3102');
      const storage = freshStorage();

      const session = await createUploadSession(
        fixture.residentA,
        sessionInput(fixture.residencyA),
        {
          executor: tx,
          storage,
        },
      );
      await receiveUploadedBytes(fixture.residentA, session.fileId, jpegBytes(4096), {
        executor: tx,
        storage,
      });
      await completeUpload(fixture.residentA, session.fileId, { executor: tx, storage });

      const entries = await tx
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.orgId, fixture.orgId));
      expect(entries.map((entry) => entry.action)).toContain('file.uploaded');
    });
  });

  /** Заявленный тип — слово клиента. Байты не врут. */
  it('подделка типа не проходит: заявлен jpeg, прислан html', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3103');
      const storage = freshStorage();

      const session = await createUploadSession(
        fixture.residentA,
        sessionInput(fixture.residencyA),
        {
          executor: tx,
          storage,
        },
      );

      await expect(
        receiveUploadedBytes(
          fixture.residentA,
          session.fileId,
          new TextEncoder().encode('<html><script>alert(1)</script></html>'),
          { executor: tx, storage },
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      const [row] = await tx
        .select()
        .from(schema.files)
        .where(eq(schema.files.orgId, fixture.orgId));
      expect(row?.status).toBe('failed');
    });
  });

  it('размер, не совпавший с заявленным, переводит файл в failed', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3104');
      const storage = freshStorage();

      const session = await createUploadSession(
        fixture.residentA,
        sessionInput(fixture.residencyA),
        {
          executor: tx,
          storage,
        },
      );

      await expect(
        receiveUploadedBytes(fixture.residentA, session.fileId, jpegBytes(8192), {
          executor: tx,
          storage,
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      const [row] = await tx
        .select()
        .from(schema.files)
        .where(eq(schema.files.orgId, fixture.orgId));
      expect(row?.status).toBe('failed');
    });
  });

  it('подтверждение без дошедших байтов переводит файл в failed', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3105');
      const storage = freshStorage();

      const session = await createUploadSession(
        fixture.residentA,
        sessionInput(fixture.residencyA),
        {
          executor: tx,
          storage,
        },
      );

      await expect(
        completeUpload(fixture.residentA, session.fileId, { executor: tx, storage }),
      ).rejects.toBeInstanceOf(ConflictError);

      const [row] = await tx
        .select()
        .from(schema.files)
        .where(eq(schema.files.orgId, fixture.orgId));
      expect(row?.status).toBe('failed');
    });
  });

  it('повторный приём байтов в готовый файл невозможен', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3106');
      const storage = freshStorage();

      const session = await createUploadSession(
        fixture.residentA,
        sessionInput(fixture.residencyA),
        {
          executor: tx,
          storage,
        },
      );
      await receiveUploadedBytes(fixture.residentA, session.fileId, jpegBytes(4096), {
        executor: tx,
        storage,
      });
      await completeUpload(fixture.residentA, session.fileId, { executor: tx, storage });

      await expect(
        receiveUploadedBytes(fixture.residentA, session.fileId, jpegBytes(4096), {
          executor: tx,
          storage,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  it('чужой жилец не дошлёт байты в чужую сессию', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3107');
      const storage = freshStorage();

      const session = await createUploadSession(
        fixture.residentA,
        sessionInput(fixture.residencyA),
        {
          executor: tx,
          storage,
        },
      );

      await expect(
        receiveUploadedBytes(fixture.residentB, session.fileId, jpegBytes(4096), {
          executor: tx,
          storage,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('отдача содержимого', () => {
  async function readyFile(tx: Transaction, suffix: string) {
    const fixture = await seed(tx, suffix);
    const storage = freshStorage();
    const session = await createUploadSession(fixture.residentA, sessionInput(fixture.residencyA), {
      executor: tx,
      storage,
    });

    await receiveUploadedBytes(fixture.residentA, session.fileId, jpegBytes(4096), {
      executor: tx,
      storage,
    });
    await completeUpload(fixture.residentA, session.fileId, { executor: tx, storage });

    return { fixture, storage, fileId: session.fileId };
  }

  it('владелец получает поток, тип и имя', async () => {
    await inRollback(async (tx) => {
      const { fixture, storage, fileId } = await readyFile(tx, '3201');

      const content = await readFileContent(fixture.residentA, fileId, { executor: tx, storage });

      expect(content.mime).toBe('image/jpeg');
      expect(content.sizeBytes).toBe(4096);
      expect(content.originalName).toBe('флюорография.jpg');
      expect(content.stream).toBeInstanceOf(ReadableStream);
      await content.stream.cancel();
    });
  });

  it('чужому жильцу содержимое неотличимо от несуществующего', async () => {
    await inRollback(async (tx) => {
      const { fixture, storage, fileId } = await readyFile(tx, '3202');

      await expect(
        readFileContent(fixture.residentB, fileId, { executor: tx, storage }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('админ своего дома получает содержимое, и это попадает в журнал', async () => {
    await inRollback(async (tx) => {
      const { fixture, storage, fileId } = await readyFile(tx, '3203');

      const content = await readFileContent(fixture.adminA, fileId, { executor: tx, storage });
      await content.stream.cancel();

      const entries = await tx
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.orgId, fixture.orgId));
      expect(entries.map((entry) => entry.action)).toContain('file.read');
    });
  });

  it('чтение собственного файла журнал не засоряет', async () => {
    await inRollback(async (tx) => {
      const { fixture, storage, fileId } = await readyFile(tx, '3204');

      const content = await readFileContent(fixture.residentA, fileId, { executor: tx, storage });
      await content.stream.cancel();

      const entries = await tx
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.orgId, fixture.orgId));
      expect(entries.map((entry) => entry.action)).not.toContain('file.read');
    });
  });

  /** Незавершённая загрузка содержимым не является: отдавать нечего. */
  it('файл в pending содержимого не отдаёт', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3205');
      const storage = freshStorage();

      const session = await createUploadSession(
        fixture.residentA,
        sessionInput(fixture.residencyA),
        {
          executor: tx,
          storage,
        },
      );

      await expect(
        readFileContent(fixture.residentA, session.fileId, { executor: tx, storage }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

/**
 * Чек к ущербу, расходу и строке коммуналки (T3.12). У него нет проживания:
 * он принадлежит дому, и видимость идёт по дому, а не по жильцу. Проверяется
 * именно это — иначе чек оказался бы у того, кому его никто не показывал.
 */
describe('чек дома', () => {
  async function uploadReceipt(
    tx: Transaction,
    fixture: Awaited<ReturnType<typeof seed>>,
    houseId: string | null,
  ) {
    const storage = freshStorage();
    const deps = { executor: tx, storage };

    const session = await createHouseUploadSession(
      fixture.adminA,
      {
        houseId,
        purpose: 'damage-receipt',
        mime: 'image/jpeg',
        sizeBytes: 4,
        originalName: 'чек.jpg',
      },
      deps,
    );

    await receiveUploadedBytes(fixture.adminA, session.fileId, new Uint8Array(JPEG_HEAD), deps);
    await completeUpload(fixture.adminA, session.fileId, deps);

    return { fileId: session.fileId, deps };
  }

  it('ложится в папку дома, без сегмента проживания', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4801');
      const { fileId } = await uploadReceipt(tx, fixture, fixture.houseA);

      const [file] = await tx.select().from(schema.files).where(eq(schema.files.id, fileId));

      expect(file?.residencyId).toBeNull();
      expect(file?.houseId).toBe(fixture.houseA);
      expect(file?.path).toBe(`${fixture.houseSlug}/damage-receipt/${fileId}.jpg`);
    });
  });

  it('читается админом своего дома и суперадмином', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4802');
      const { fileId, deps } = await uploadReceipt(tx, fixture, fixture.houseA);

      await expect(readFileContent(fixture.adminA, fileId, deps)).resolves.toBeDefined();
      await expect(readFileContent(fixture.superadmin, fileId, deps)).resolves.toBeDefined();
    });
  });

  it('жильцу не показывается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4803');
      const { fileId, deps } = await uploadReceipt(tx, fixture, fixture.houseA);

      await expect(readFileContent(fixture.residentA, fileId, deps)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  it('админу чужого дома тоже не показывается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4804');
      const { fileId, deps } = await uploadReceipt(tx, fixture, fixture.houseA);

      await expect(readFileContent(fixture.adminB, fileId, deps)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  it('чек уровня сети виден суперадмину и закрыт админу дома', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4805');
      const storage = freshStorage();
      const deps = { executor: tx, storage };

      const session = await createHouseUploadSession(
        fixture.superadmin,
        {
          houseId: null,
          purpose: 'expense-receipt',
          mime: 'image/jpeg',
          sizeBytes: 4,
          originalName: 'чек.jpg',
        },
        deps,
      );

      await receiveUploadedBytes(
        fixture.superadmin,
        session.fileId,
        new Uint8Array(JPEG_HEAD),
        deps,
      );
      await completeUpload(fixture.superadmin, session.fileId, deps);

      const [file] = await tx
        .select()
        .from(schema.files)
        .where(eq(schema.files.id, session.fileId));
      expect(file?.path).toBe(`_network/expense-receipt/${session.fileId}.jpg`);

      await expect(
        readFileContent(fixture.superadmin, session.fileId, deps),
      ).resolves.toBeDefined();
      await expect(readFileContent(fixture.adminA, session.fileId, deps)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  it('неизвестное назначение файла не принимается: перечень закрыт', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4806');
      const storage = freshStorage();

      await expect(
        createHouseUploadSession(
          fixture.adminA,
          {
            houseId: fixture.houseA,
            purpose: 'что-угодно',
            mime: 'image/jpeg',
            sizeBytes: 4,
            originalName: 'чек.jpg',
          },
          { executor: tx, storage },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
