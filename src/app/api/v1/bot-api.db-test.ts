import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { parseInstant } from '@/lib/time';

import type * as DbClientModule from '@/db/client';
import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from '@/services/users';

/**
 * Чтения для ботов (docs/06-API.md, T7.3).
 *
 * Проверяется HTTP-слой: что открывает скоуп, что он закрывает и в каком
 * виде уходит ответ. Расчёты проверены в сервисных тестах и здесь
 * не дублируются.
 *
 * Роуты ходят в базу через `getDb()`, а тест обязан идти в транзакции
 * с откатом — поэтому точка подменяется на транзакцию теста.
 */
const url = testDatabaseUrl();
const client = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => undefined });
const db = drizzle(client, { schema }) as unknown as Database;

let currentExecutor: Transaction | null = null;

vi.mock('@/db/client', async (importOriginal) => {
  const original = await importOriginal<typeof DbClientModule>();

  return { ...original, getDb: () => currentExecutor ?? original.getDb() };
});

const { GET: getHouses } = await import('./houses/route');
const { GET: getBeds } = await import('./houses/[id]/beds/route');
const { GET: getRotations } = await import('./rotations/route');
const { GET: getInvoices } = await import('./invoices/route');
const { issueApiToken } = await import('@/services/api-tokens');

afterAll(async () => {
  await client.end();
});

class Rollback extends Error {}

async function inRollback(body: (tx: Transaction) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      currentExecutor = tx;
      await body(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error;
    }
  } finally {
    currentExecutor = null;
  }
}

const NOW = parseInstant('2026-09-07T12:00:00+05:00');

function request(path: string, token: string): Request {
  return new Request(`https://nice.local${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `bot-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `bot-a-${suffix}`, address: 'Алматы, улица' })
    .returning();
  const houseId = house?.id ?? '';

  const [room] = await tx
    .insert(schema.areas)
    .values({ houseId, type: 'living', name: 'Комната 1' })
    .returning();

  const [freeBed] = await tx
    .insert(schema.beds)
    .values({
      houseId,
      areaId: room?.id ?? '',
      label: 'М1',
      tier: 'lower',
      number: 1,
      defaultPrice: 70_000,
    })
    .returning();
  const [takenBed] = await tx
    .insert(schema.beds)
    .values({
      houseId,
      areaId: room?.id ?? '',
      label: 'М2',
      tier: 'upper',
      number: 2,
      defaultPrice: 70_000,
    })
    .returning();

  const [superUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7700${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();
  const [dwellerUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7709${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  const [residency] = await tx
    .insert(schema.residencies)
    .values({
      orgId,
      userId: dwellerUser?.id ?? '',
      houseId,
      status: 'active',
      moveInDate: '2026-09-01',
    })
    .returning();

  await tx.insert(schema.bedAssignments).values({
    residencyId: residency?.id ?? '',
    bedId: takenBed?.id ?? '',
    price: 70_000,
    period: '[2026-09-01,)',
  });

  const context: AccessContext = {
    orgId,
    userId: superUser?.id ?? '',
    role: 'superadmin',
    houseId: null,
  };

  const network: UserActor = { context, requestId: `req-${suffix}` };

  const tokenWith = async (scopes: string[]): Promise<string> =>
    (
      await issueApiToken(
        network,
        { name: `Бот ${suffix}`, scopes },
        { executor: tx, instant: NOW },
      )
    ).value;

  return {
    orgId,
    houseId,
    freeBedId: freeBed?.id ?? '',
    takenBedId: takenBed?.id ?? '',
    residencyId: residency?.id ?? '',
    network,
    tokenWith,
  };
}

describe('места и дома', () => {
  it('бот видит дома сети', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7201');
      const token = await fixture.tokenWith(['houses:read']);

      const response = await getHouses(request('/api/v1/houses', token));
      const body = (await response.json()) as { data: { id: string; name: string }[] };

      expect(response.status).toBe(200);
      expect(body.data.some((house) => house.id === fixture.houseId)).toBe(true);
    });
  });

  it('бот отличает свободное место от занятого', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7202');
      const token = await fixture.tokenWith(['beds:read']);

      const response = await getBeds(
        request(`/api/v1/houses/${fixture.houseId}/beds?date=2026-09-07`, token),
        { params: Promise.resolve({ id: fixture.houseId }) },
      );
      const body = (await response.json()) as {
        data: { id: string; occupied: boolean }[];
      };

      expect(response.status).toBe(200);
      expect(body.data.find((bed) => bed.id === fixture.freeBedId)?.occupied).toBe(false);
      expect(body.data.find((bed) => bed.id === fixture.takenBedId)?.occupied).toBe(true);
    });
  });

  it('в ответе о местах нет жильцов: это другой скоуп', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7203');
      const token = await fixture.tokenWith(['beds:read']);

      const response = await getBeds(request(`/api/v1/houses/${fixture.houseId}/beds`, token), {
        params: Promise.resolve({ id: fixture.houseId }),
      });

      expect(await response.text()).not.toContain('user_id');
    });
  });
});

describe('ротации', () => {
  it('день дома читается по своему скоупу', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7204');
      const token = await fixture.tokenWith(['rotations:read']);

      const response = await getRotations(
        request(`/api/v1/rotations?house_id=${fixture.houseId}&date=2026-09-07`, token),
      );
      const body = (await response.json()) as { data: unknown[]; house_id: string };

      expect(response.status).toBe(200);
      expect(body.house_id).toBe(fixture.houseId);
      expect(Array.isArray(body.data)).toBe(true);
    });
  });

  it('оценки в ответ не идут: их видит только админ', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7205');
      const token = await fixture.tokenWith(['rotations:read']);

      const response = await getRotations(
        request(`/api/v1/rotations?house_id=${fixture.houseId}`, token),
      );

      expect(await response.text()).not.toContain('score');
    });
  });
});

describe('деньги закрыты своим скоупом', () => {
  it('токен на места счетов не видит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7206');
      const token = await fixture.tokenWith(['beds:read', 'houses:read']);

      const response = await getInvoices(request('/api/v1/invoices', token));
      const body = (await response.json()) as { error: { code: string } };

      expect(response.status).toBe(403);
      expect(body.error.code).toBe('forbidden');
    });
  });

  it('токен со своим скоупом счета читает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7207');
      const token = await fixture.tokenWith(['invoices:read']);

      const response = await getInvoices(request('/api/v1/invoices', token));

      expect(response.status).toBe(200);
    });
  });

  it('места закрыты для токена без своего скоупа', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7208');
      const token = await fixture.tokenWith(['invoices:read']);

      const response = await getBeds(request(`/api/v1/houses/${fixture.houseId}/beds`, token), {
        params: Promise.resolve({ id: fixture.houseId }),
      });

      expect(response.status).toBe(403);
    });
  });

  it('без токена и без сессии — «не авторизован»', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '7209');
      void fixture;

      const response = await getHouses(new Request('https://nice.local/api/v1/houses'));

      expect(response.status).toBe(401);
    });
  });
});
