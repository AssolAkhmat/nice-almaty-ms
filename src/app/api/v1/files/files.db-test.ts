import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLocalStorage } from '@/adapters/storage/local';
import * as schema from '@/db/schema';
import { MAX_UPLOAD_BYTES } from '@/domain/files';
import { hashSessionToken, SESSION_COOKIE_NAME } from '@/lib/session-token';

import type * as StorageModule from '@/adapters/storage';
import type { StorageProvider } from '@/adapters/storage';
import type * as DbClientModule from '@/db/client';
import type { Database, Transaction } from '@/db/client';

/**
 * REST-обёртка двухшаговой загрузки (docs/06-API.md, docs/01-ARCHITECTURE.md).
 *
 * Проверяется именно HTTP-слой: коды ответов, формат ошибки из §«Соглашения»,
 * аутентификация по cookie и то, что содержимое не отдаётся никому, кроме
 * тех, кому его отдаёт сервисный слой. Логика загрузки проверена отдельно
 * в `src/services/files.db-test.ts` и здесь не дублируется.
 *
 * Роут ходит в базу и в хранилище через `getDb()` и `getStorageProvider()`,
 * а тест обязан идти в транзакции с откатом — поэтому обе точки подменяются
 * на транзакцию теста и на временный каталог.
 */
const url = process.env.TEST_DATABASE_URL ?? 'postgres://nice:nice@localhost:5432/nice_almaty';
const client = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => undefined });
const db = drizzle(client, { schema }) as unknown as Database;

let currentExecutor: Transaction | null = null;
let currentStorage: StorageProvider | null = null;

vi.mock('@/db/client', async (importOriginal) => {
  const original = await importOriginal<typeof DbClientModule>();

  return { ...original, getDb: () => currentExecutor ?? original.getDb() };
});

vi.mock('@/adapters/storage', async (importOriginal) => {
  const original = await importOriginal<typeof StorageModule>();

  return { ...original, getStorageProvider: () => currentStorage ?? original.getStorageProvider() };
});

const { PUT: putBlob } = await import('./[id]/blob/route');
const { POST: postComplete } = await import('./[id]/complete/route');
const { GET: getContent } = await import('./[id]/content/route');
const { POST: postUploadSession } = await import('./upload-session/route');

const roots: string[] = [];

afterAll(async () => {
  await client.end();
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

beforeEach(() => {
  currentStorage = null;
  currentExecutor = null;
});

class Rollback extends Error {}

async function inRollback(body: (tx: Transaction) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      currentExecutor = tx;
      const root = mkdtempSync(join(tmpdir(), 'nice-api-files-'));
      roots.push(root);
      currentStorage = createLocalStorage(root);

      await body(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error;
    }
  } finally {
    currentExecutor = null;
    currentStorage = null;
  }
}

const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0];

function jpegBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(JPEG_HEAD, 0);

  return bytes;
}

/** Учётная запись с действующей сессией: cookie — единственный вход в API. */
async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `api-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `api-a-${suffix}` })
    .returning();
  const [otherHouse] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `api-b-${suffix}` })
    .returning();

  async function resident(index: number, houseId: string) {
    const [user] = await tx
      .insert(schema.users)
      .values({ orgId, phone: `+7709${index}${suffix}`, passwordHash: 'x', role: 'resident' })
      .returning();

    const [residency] = await tx
      .insert(schema.residencies)
      .values({ orgId, userId: user?.id ?? '', houseId })
      .returning();

    const token = `token-${index}-${suffix}`;
    await tx.insert(schema.sessions).values({
      userId: user?.id ?? '',
      tokenHash: await hashSessionToken(token),
      expiresAt: new Date(Date.now() + 60_000),
    });

    return { residencyId: residency?.id ?? '', token };
  }

  return {
    a: await resident(1, house?.id ?? ''),
    b: await resident(2, otherHouse?.id ?? ''),
  };
}

function authorized(token: string, init: RequestInit = {}): Request {
  return new Request('http://localhost/api/v1/files', {
    ...init,
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

function sessionBody(residencyId: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    residency_id: residencyId,
    document_type: 'fluorography',
    mime: 'image/jpeg',
    size_bytes: 4096,
    original_name: 'флюорография.jpg',
    ...overrides,
  });
}

function route(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** Сессия загрузки, дошедшие байты и подтверждение — исходное состояние для чтения. */
async function uploadReadyFile(token: string, residencyId: string, size = 4096): Promise<string> {
  const created = await postUploadSession(
    authorized(token, { method: 'POST', body: sessionBody(residencyId, { size_bytes: size }) }),
  );
  const { file_id: fileId } = (await created.json()) as { file_id: string };

  await putBlob(
    authorized(token, {
      method: 'PUT',
      body: jpegBytes(size) as unknown as BodyInit,
      headers: { 'content-type': 'image/jpeg' },
    }),
    route(fileId),
  );

  await postComplete(authorized(token, { method: 'POST' }), route(fileId));

  return fileId;
}

describe('вход в API', () => {
  it('без cookie отвечает 401 в формате из docs/06-API.md', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4001');

      const response = await postUploadSession(
        new Request('http://localhost/api/v1/files/upload-session', {
          method: 'POST',
          body: sessionBody(fixture.a.residencyId),
        }),
      );

      expect(response.status).toBe(401);

      const body = (await response.json()) as {
        error: { code: string; message: string };
        request_id: string;
      };

      expect(body.error.code).toBe('unauthorized');
      expect(body.error.message).not.toBe('');
      expect(body.request_id).not.toBe('');
    });
  });

  it('bearer-токен пока не выпускается и не пускает молча', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4002');

      const response = await postUploadSession(
        new Request('http://localhost/api/v1/files/upload-session', {
          method: 'POST',
          body: sessionBody(fixture.a.residencyId),
          headers: { authorization: 'Bearer whatever' },
        }),
      );

      expect(response.status).toBe(401);
    });
  });

  it('отозванная сессия не пускает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4003');
      await tx.update(schema.sessions).set({ revokedAt: new Date() });

      const response = await postUploadSession(
        authorized(fixture.a.token, {
          method: 'POST',
          body: sessionBody(fixture.a.residencyId),
        }),
      );

      expect(response.status).toBe(401);
    });
  });
});

describe('POST /api/v1/files/upload-session', () => {
  it('создаёт сессию и отвечает адресом загрузки в snake_case', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4010');

      const response = await postUploadSession(
        authorized(fixture.a.token, {
          method: 'POST',
          body: sessionBody(fixture.a.residencyId),
        }),
      );

      expect(response.status).toBe(201);

      const body = (await response.json()) as {
        file_id: string;
        upload: { url: string; method: string; headers: Record<string, string> };
        max_bytes: number;
      };

      expect(body.file_id).not.toBe('');
      expect(body.upload.method).toBe('PUT');
      expect(body.upload.url).toBe(`/api/v1/files/${body.file_id}/blob`);
      expect(body.max_bytes).toBe(MAX_UPLOAD_BYTES);
    });
  });

  it('запрещённый тип отвечает validation_error, а не 500', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4011');

      const response = await postUploadSession(
        authorized(fixture.a.token, {
          method: 'POST',
          body: sessionBody(fixture.a.residencyId, { mime: 'text/html' }),
        }),
      );

      expect(response.status).toBe(422);

      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('validation_error');
      expect(body.error.message).toBe('files.mimeNotAllowed');
    });
  });

  it('тело не по схеме отвечает validation_error', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4012');

      const response = await postUploadSession(
        authorized(fixture.a.token, { method: 'POST', body: '{"residency_id":123}' }),
      );

      expect(response.status).toBe(422);
    });
  });

  it('чужое проживание неотличимо от несуществующего', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4013');

      const response = await postUploadSession(
        authorized(fixture.a.token, {
          method: 'POST',
          body: sessionBody(fixture.b.residencyId),
        }),
      );

      expect(response.status).toBe(404);
    });
  });
});

describe('PUT /api/v1/files/{id}/blob', () => {
  it('принимает байты и оставляет файл в pending до подтверждения', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4020');

      const created = await postUploadSession(
        authorized(fixture.a.token, {
          method: 'POST',
          body: sessionBody(fixture.a.residencyId),
        }),
      );
      const { file_id: fileId } = (await created.json()) as { file_id: string };

      const response = await putBlob(
        authorized(fixture.a.token, {
          method: 'PUT',
          body: jpegBytes(4096) as unknown as BodyInit,
        }),
        route(fileId),
      );

      expect(response.status).toBe(200);

      const body = (await response.json()) as { id: string; status: string };
      expect(body).toMatchObject({ id: fileId, status: 'pending' });
    });
  });

  it('заявленный размер сверх предела отклоняется до чтения тела', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4021');

      const created = await postUploadSession(
        authorized(fixture.a.token, {
          method: 'POST',
          body: sessionBody(fixture.a.residencyId),
        }),
      );
      const { file_id: fileId } = (await created.json()) as { file_id: string };

      const response = await putBlob(
        authorized(fixture.a.token, {
          method: 'PUT',
          body: jpegBytes(4096) as unknown as BodyInit,
          headers: { 'content-length': String(MAX_UPLOAD_BYTES + 1) },
        }),
        route(fileId),
      );

      expect(response.status).toBe(422);

      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toBe('files.tooLarge');
    });
  });

  it('чужой жилец в чужую сессию не дошлёт', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4022');

      const created = await postUploadSession(
        authorized(fixture.a.token, {
          method: 'POST',
          body: sessionBody(fixture.a.residencyId),
        }),
      );
      const { file_id: fileId } = (await created.json()) as { file_id: string };

      const response = await putBlob(
        authorized(fixture.b.token, {
          method: 'PUT',
          body: jpegBytes(4096) as unknown as BodyInit,
        }),
        route(fileId),
      );

      expect(response.status).toBe(404);
    });
  });
});

describe('POST /api/v1/files/{id}/complete', () => {
  it('переводит файл в ready', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4030');
      const fileId = await uploadReadyFile(fixture.a.token, fixture.a.residencyId);

      const [row] = await tx.select().from(schema.files);
      expect(row).toMatchObject({ id: fileId, status: 'ready' });
    });
  });

  it('подтверждение без дошедших байтов отвечает conflict', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4031');

      const created = await postUploadSession(
        authorized(fixture.a.token, {
          method: 'POST',
          body: sessionBody(fixture.a.residencyId),
        }),
      );
      const { file_id: fileId } = (await created.json()) as { file_id: string };

      const response = await postComplete(
        authorized(fixture.a.token, { method: 'POST' }),
        route(fileId),
      );

      expect(response.status).toBe(409);

      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('conflict');
    });
  });
});

describe('GET /api/v1/files/{id}/content', () => {
  it('отдаёт содержимое владельцу и запрещает его кэшировать', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4040');
      const fileId = await uploadReadyFile(fixture.a.token, fixture.a.residencyId);

      const response = await getContent(authorized(fixture.a.token), route(fileId));

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/jpeg');
      expect(response.headers.get('content-length')).toBe('4096');
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(response.headers.get('cache-control')).toContain('private');

      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.byteLength).toBe(4096);
      expect([...bytes.slice(0, 4)]).toEqual(JPEG_HEAD);
    });
  });

  it('имя файла отдаётся вложением, а не открывается в браузере', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4041');
      const fileId = await uploadReadyFile(fixture.a.token, fixture.a.residencyId);

      const response = await getContent(authorized(fixture.a.token), route(fileId));
      const disposition = response.headers.get('content-disposition') ?? '';

      expect(disposition).toContain('attachment');
      // Кириллица в имени не должна ломать заголовок.
      expect(disposition).toContain("filename*=UTF-8''");
    });
  });

  it('чужому содержимое неотличимо от несуществующего', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4042');
      const fileId = await uploadReadyFile(fixture.a.token, fixture.a.residencyId);

      const response = await getContent(authorized(fixture.b.token), route(fileId));

      expect(response.status).toBe(404);
    });
  });

  it('неподтверждённый файл содержимого не отдаёт', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4043');

      const created = await postUploadSession(
        authorized(fixture.a.token, {
          method: 'POST',
          body: sessionBody(fixture.a.residencyId),
        }),
      );
      const { file_id: fileId } = (await created.json()) as { file_id: string };

      const response = await getContent(authorized(fixture.a.token), route(fileId));

      expect(response.status).toBe(404);
    });
  });

  it('без cookie содержимое недоступно: публичных ссылок нет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4044');
      const fileId = await uploadReadyFile(fixture.a.token, fixture.a.residencyId);

      const response = await getContent(
        new Request(`http://localhost/api/v1/files/${fileId}/content`),
        route(fileId),
      );

      expect(response.status).toBe(401);
    });
  });
});
