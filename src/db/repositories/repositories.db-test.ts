import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { ForbiddenError, NotFoundError } from '@/lib/errors';
import { minusMilliseconds, now } from '@/lib/time';

import * as schema from '../schema';

import type { AccessContext } from '../access';
import type { Database, Transaction } from '../client';
import { appendAuditEntry, listAuditEntries } from './audit-log';
import { createHouse, findHouse, listHouses, requireHouse, updateHouse } from './houses';
import { hitRateLimit, resetRateLimit } from './rate-limits';
import { getSetting, putSetting } from './settings';
import { createUser, findUserByPhone, listUsers, requireUser } from './users';

/**
 * Интеграционные тесты идут на настоящем PostgreSQL: инварианты схемы
 * и фильтрация по org_id и house_id проверяются там, где они действуют,
 * а не в подделке. Запуск — `pnpm test:db`, в CI — в job с postgres.
 */
const url = process.env.TEST_DATABASE_URL ?? 'postgres://nice:nice@localhost:5432/nice_almaty';
// Быстрый отказ: без этого каждый упавший тест ждал бы повторов подключения.
const client = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => undefined });
const db = drizzle(client, { schema }) as unknown as Database;

afterAll(async () => {
  await client.end();
});

class Rollback extends Error {}

/** Каждый тест работает в транзакции, которая откатывается: база остаётся чистой. */
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

/** Текст ошибки вместе с причиной: имя ограничения приходит в cause, а не в message. */
function errorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;

  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }

  return parts.join(' | ');
}

/**
 * Ожидаемо падающий запрос выполняется во вложенной транзакции: упавший
 * оператор рвёт транзакцию целиком, а точка сохранения оставляет внешнюю живой.
 */
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

interface Fixture {
  orgId: string;
  otherOrgId: string;
  houseA: string;
  houseB: string;
  superadmin: AccessContext;
  adminA: AccessContext;
  resident: AccessContext;
}

async function seed(tx: Transaction, suffix: string): Promise<Fixture> {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `nice-${suffix}` })
    .returning();
  const [otherOrg] = await tx
    .insert(schema.organizations)
    .values({ name: 'Другая сеть', slug: `other-${suffix}` })
    .returning();

  const orgId = org?.id ?? '';
  const otherOrgId = otherOrg?.id ?? '';

  const [a] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `dom-a-${suffix}` })
    .returning();
  const [b] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `dom-b-${suffix}` })
    .returning();

  const houseA = a?.id ?? '';
  const houseB = b?.id ?? '';

  const [superadminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7701${suffix}1`, passwordHash: 'x', role: 'superadmin' })
    .returning();
  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7701${suffix}2`, passwordHash: 'x', role: 'admin', houseId: houseA })
    .returning();
  const [residentUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7701${suffix}3`, passwordHash: 'x', role: 'resident' })
    .returning();

  return {
    orgId,
    otherOrgId,
    houseA,
    houseB,
    superadmin: { orgId, userId: superadminUser?.id ?? '', role: 'superadmin', houseId: null },
    adminA: { orgId, userId: adminUser?.id ?? '', role: 'admin', houseId: houseA },
    resident: { orgId, userId: residentUser?.id ?? '', role: 'resident', houseId: null },
  };
}

describe('инварианты схемы', () => {
  it('админ без дома отвергается на уровне БД', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1001');

      const failure = await failureText(tx, (inner) =>
        inner.insert(schema.users).values({
          orgId: fixture.orgId,
          phone: '+77019990001',
          passwordHash: 'x',
          role: 'admin',
        }),
      );

      expect(failure).toMatch(/users_admin_has_house/);
    });
  });

  it('жилец с домом отвергается на уровне БД', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1002');

      const failure = await failureText(tx, (inner) =>
        inner.insert(schema.users).values({
          orgId: fixture.orgId,
          phone: '+77019990002',
          passwordHash: 'x',
          role: 'resident',
          houseId: fixture.houseA,
        }),
      );

      expect(failure).toMatch(/users_admin_has_house/);
    });
  });

  it('телефон уникален во всей системе', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1003');

      const failure = await failureText(tx, (inner) =>
        inner.insert(schema.users).values({
          orgId: fixture.otherOrgId,
          phone: '+770110031',
          passwordHash: 'x',
          role: 'resident',
        }),
      );

      expect(failure).toMatch(/users_phone_unique/);
    });
  });

  it('слаг дома уникален внутри сети, но не между сетями', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1004');

      const failure = await failureText(tx, (inner) =>
        inner.insert(schema.houses).values({
          orgId: fixture.orgId,
          name: 'Дубль',
          slug: 'dom-a-1004',
        }),
      );

      expect(failure).toMatch(/houses_org_slug_unique/);

      // Тот же слаг в другой сети — не конфликт: уникальность действует внутри сети.
      await expect(
        tx
          .insert(schema.houses)
          .values({ orgId: fixture.otherOrgId, name: 'Тёзка', slug: 'dom-a-1004' }),
      ).resolves.toBeDefined();
    });
  });
});

describe('видимость домов', () => {
  it('админ видит только свой дом', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2001');
      const visible = await listHouses(fixture.adminA, {}, tx);

      expect(visible.map((house) => house.id)).toEqual([fixture.houseA]);
    });
  });

  it('чужой дом неотличим от несуществующего', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2002');

      await expect(requireHouse(fixture.adminA, fixture.houseB, tx)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(findHouse(fixture.adminA, fixture.houseB, tx)).resolves.toBeNull();
    });
  });

  it('чужой дом нельзя изменить', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2003');

      await expect(
        updateHouse(fixture.adminA, fixture.houseB, { name: 'Захвачен' }, tx),
      ).rejects.toBeInstanceOf(NotFoundError);

      const [untouched] = await listHouses(fixture.superadmin, {}, tx);
      expect(untouched?.name).not.toBe('Захвачен');
    });
  });

  it('суперадмин видит все дома сети и не видит чужую сеть', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2004');
      await tx
        .insert(schema.houses)
        .values({ orgId: fixture.otherOrgId, name: 'Чужой', slug: 'chuzhoy-2004' });

      const visible = await listHouses(fixture.superadmin, {}, tx);

      expect(visible).toHaveLength(2);
      expect(visible.every((house) => house.orgId === fixture.orgId)).toBe(true);
    });
  });

  it('жилец в фазе 1 не привязан к дому и списка не получает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2005');

      await expect(listHouses(fixture.resident, {}, tx)).resolves.toEqual([]);
      await expect(requireHouse(fixture.resident, fixture.houseA, tx)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  it('созданный дом попадает в свою сеть, а не в чужую', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2006');
      const house = await createHouse(fixture.superadmin, { name: 'Новый', slug: 'novy-2006' }, tx);

      expect(house.orgId).toBe(fixture.orgId);
    });
  });
});

describe('видимость пользователей', () => {
  it('жилец видит только себя', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3001');
      const visible = await listUsers(fixture.resident, tx);

      expect(visible.map((user) => user.id)).toEqual([fixture.resident.userId]);
    });
  });

  it('админ не видит суперадмина', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3002');
      const visible = await listUsers(fixture.adminA, tx);

      expect(visible.map((user) => user.id)).not.toContain(fixture.superadmin.userId);
    });
  });

  it('пользователь чужой сети невидим и неотличим от несуществующего', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3003');
      const [stranger] = await tx
        .insert(schema.users)
        .values({
          orgId: fixture.otherOrgId,
          phone: '+77019993003',
          passwordHash: 'x',
          role: 'resident',
        })
        .returning();

      await expect(requireUser(fixture.superadmin, stranger?.id ?? '', tx)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  it('созданный пользователь попадает в сеть создателя', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3004');
      const user = await createUser(
        fixture.superadmin,
        { phone: '+77019993004', passwordHash: 'x', role: 'resident' },
        tx,
      );

      expect(user.orgId).toBe(fixture.orgId);
    });
  });

  it('поиск по телефону идёт мимо контекста — им пользуется вход', async () => {
    await inRollback(async (tx) => {
      await seed(tx, '3005');

      await expect(findUserByPhone('+770130051', tx)).resolves.not.toBeNull();
      await expect(findUserByPhone('+77000000000', tx)).resolves.toBeNull();
    });
  });
});

describe('настройки', () => {
  it('настройки сети доступны только суперадмину', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4001');

      await expect(
        putSetting(fixture.adminA, 'org', fixture.orgId, 'rating.visible', true, tx),
      ).rejects.toBeInstanceOf(ForbiddenError);

      await expect(
        putSetting(fixture.superadmin, 'org', fixture.orgId, 'rating.visible', true, tx),
      ).resolves.toBeDefined();
    });
  });

  it('админ ведёт настройки своего дома и не видит чужие', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4002');

      await putSetting(fixture.adminA, 'house', fixture.houseA, 'curfew.note', 'своё', tx);
      const own = await getSetting(fixture.adminA, 'house', fixture.houseA, 'curfew.note', tx);
      expect(own?.value).toBe('своё');

      await expect(
        getSetting(fixture.adminA, 'house', fixture.houseB, 'curfew.note', tx),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('повторная запись ключа обновляет значение, а не плодит строки', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '4003');

      await putSetting(fixture.adminA, 'house', fixture.houseA, 'k', 1, tx);
      await putSetting(fixture.adminA, 'house', fixture.houseA, 'k', 2, tx);

      const setting = await getSetting(fixture.adminA, 'house', fixture.houseA, 'k', tx);
      expect(setting?.value).toBe(2);
    });
  });
});

describe('журнал аудита', () => {
  it('читает только суперадмин', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5001');

      await expect(listAuditEntries(fixture.adminA, {}, tx)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listAuditEntries(fixture.resident, {}, tx)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(listAuditEntries(fixture.superadmin, {}, tx)).resolves.toEqual([]);
    });
  });

  it('записи чужой сети в выдачу не попадают', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5002');

      await appendAuditEntry(
        { orgId: fixture.orgId, action: 'house.create', entityType: 'house' },
        tx,
      );
      await appendAuditEntry(
        { orgId: fixture.otherOrgId, action: 'house.create', entityType: 'house' },
        tx,
      );

      const entries = await listAuditEntries(fixture.superadmin, {}, tx);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.orgId).toBe(fixture.orgId);
    });
  });

  it('фильтр по сущности сужает выдачу', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '5003');

      await appendAuditEntry(
        { orgId: fixture.orgId, action: 'house.create', entityType: 'house' },
        tx,
      );
      await appendAuditEntry(
        { orgId: fixture.orgId, action: 'user.create', entityType: 'user' },
        tx,
      );

      const entries = await listAuditEntries(fixture.superadmin, { entityType: 'user' }, tx);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.action).toBe('user.create');
    });
  });
});

describe('ограничение попыток входа', () => {
  const WINDOW_MS = 15 * 60 * 1000;

  it('считает попытки в пределах окна', async () => {
    await inRollback(async (tx) => {
      const key = 'login:phone:+77010006001';

      for (let attempt = 1; attempt <= 10; attempt += 1) {
        const state = await hitRateLimit(key, WINDOW_MS, tx);
        expect(state.count).toBe(attempt);
      }

      const eleventh = await hitRateLimit(key, WINDOW_MS, tx);
      expect(eleventh.count).toBe(11);
    });
  });

  it('окно старше пятнадцати минут начинается заново', async () => {
    await inRollback(async (tx) => {
      const key = 'login:ip:203.0.113.7';

      await tx
        .insert(schema.rateLimits)
        .values({ key, windowStart: minusMilliseconds(now(), WINDOW_MS + 1000), count: 9 });

      const state = await hitRateLimit(key, WINDOW_MS, tx);
      expect(state.count).toBe(1);
    });
  });

  it('успешный вход обнуляет счётчик', async () => {
    await inRollback(async (tx) => {
      const key = 'login:phone:+77010006003';

      await hitRateLimit(key, WINDOW_MS, tx);
      await resetRateLimit(key, tx);

      const state = await hitRateLimit(key, WINDOW_MS, tx);
      expect(state.count).toBe(1);
    });
  });

  it('ключи телефона и адреса считаются независимо', async () => {
    await inRollback(async (tx) => {
      await hitRateLimit('login:phone:+77010006004', WINDOW_MS, tx);
      await hitRateLimit('login:phone:+77010006004', WINDOW_MS, tx);
      const byIp = await hitRateLimit('login:ip:203.0.113.9', WINDOW_MS, tx);

      expect(byIp.count).toBe(1);
    });
  });
});
