import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { parseBusinessDate } from '@/lib/time';

import { listHouseResidents, readResidentCard } from './residents';
import { changeAccountRole } from './users';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Список жильцов дома и карточка. Это же закрывает долг фазы 1: видимость
 * идёт через проживание, а не через `users.house_id`, поэтому у админа
 * наконец есть кого показывать (D11).
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

const TODAY = parseBusinessDate('2026-09-15');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `res-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `res-a-${suffix}` })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `res-b-${suffix}` })
    .returning();

  const [area] = await tx
    .insert(schema.areas)
    .values({ houseId: houseA?.id ?? '', name: 'Комната 1', type: 'living' })
    .returning();

  const [bed] = await tx
    .insert(schema.beds)
    .values({
      houseId: houseA?.id ?? '',
      areaId: area?.id ?? '',
      number: 1,
      tier: 'lower',
      label: 'Место 1',
      defaultPrice: 120_000,
    })
    .returning();

  async function resident(index: number, houseId: string, lastName: string) {
    const [user] = await tx
      .insert(schema.users)
      .values({ orgId, phone: `+7709${index}${suffix}`, passwordHash: 'x', role: 'resident' })
      .returning();

    await tx
      .insert(schema.residentProfiles)
      .values({ userId: user?.id ?? '', lastName, firstName: 'Имя' });

    const [residency] = await tx
      .insert(schema.residencies)
      .values({ orgId, userId: user?.id ?? '', houseId, status: 'active' })
      .returning();

    return { userId: user?.id ?? '', residencyId: residency?.id ?? '' };
  }

  const [adminUser] = await tx
    .insert(schema.users)
    .values({
      orgId,
      phone: `+7706${suffix}`,
      passwordHash: 'x',
      role: 'admin',
      houseId: houseA?.id ?? '',
    })
    .returning();

  const [superadminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7705${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();

  const own = await resident(1, houseA?.id ?? '', 'Абдуллаев');
  const foreign = await resident(2, houseB?.id ?? '', 'Борисов');

  await tx.insert(schema.bedAssignments).values({
    residencyId: own.residencyId,
    bedId: bed?.id ?? '',
    price: 115_000,
    period: '[2026-09-01,)',
  });

  const context = (
    role: AccessContext['role'],
    userId: string,
    houseId: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });

  return {
    orgId,
    houseA: houseA?.id ?? '',
    houseB: houseB?.id ?? '',
    areaId: area?.id ?? '',
    own,
    foreign,
    admin: actor(context('admin', adminUser?.id ?? '', houseA?.id ?? null)),
    superadmin: actor(context('superadmin', superadminUser?.id ?? '', null)),
    resident: actor(context('resident', own.userId, null)),
  };
}

describe('список жильцов дома', () => {
  it('админ видит жильцов своего дома и не видит чужих', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1101');

      const rows = await listHouseResidents(fixture.admin, {}, { executor: tx, today: TODAY });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.fullName).toBe('Абдуллаев Имя');
    });
  });

  it('показывает комнату, место и цену из назначения', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1102');

      const [row] = await listHouseResidents(fixture.admin, {}, { executor: tx, today: TODAY });

      expect(row?.room).toBe('Комната 1');
      expect(row?.bed).toBe('Место 1');
      expect(row?.price).toBe(115_000);
    });
  });

  it('фильтр по комнате оставляет только её жильцов', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1103');

      const inRoom = await listHouseResidents(
        fixture.admin,
        { areaId: fixture.areaId },
        { executor: tx, today: TODAY },
      );
      const inNowhere = await listHouseResidents(
        fixture.admin,
        { areaId: '00000000-0000-0000-0000-000000000000' },
        { executor: tx, today: TODAY },
      );

      expect(inRoom).toHaveLength(1);
      expect(inNowhere).toHaveLength(0);
    });
  });

  it('поиск идёт по ФИО и телефону', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1104');

      expect(
        await listHouseResidents(fixture.admin, { query: 'абдул' }, { executor: tx, today: TODAY }),
      ).toHaveLength(1);
      expect(
        await listHouseResidents(fixture.admin, { query: 'сидор' }, { executor: tx, today: TODAY }),
      ).toHaveLength(0);
    });
  });

  it('фильтр долга находит просроченный неоплаченный счёт', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1105');

      expect(
        await listHouseResidents(fixture.admin, { withDebt: true }, { executor: tx, today: TODAY }),
      ).toHaveLength(0);

      await tx.insert(schema.invoices).values({
        orgId: fixture.orgId,
        houseId: fixture.houseA,
        userId: fixture.own.userId,
        residencyId: fixture.own.residencyId,
        type: 'monthly',
        status: 'issued',
        total: 120_000,
        dueDate: '2026-09-01',
      });

      const rows = await listHouseResidents(
        fixture.admin,
        { withDebt: true },
        { executor: tx, today: TODAY },
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.hasDebt).toBe(true);
    });
  });

  it('счёт с будущим сроком долгом не считается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1106');

      await tx.insert(schema.invoices).values({
        orgId: fixture.orgId,
        houseId: fixture.houseA,
        userId: fixture.own.userId,
        residencyId: fixture.own.residencyId,
        type: 'monthly',
        status: 'issued',
        total: 120_000,
        dueDate: '2026-10-01',
      });

      const [row] = await listHouseResidents(fixture.admin, {}, { executor: tx, today: TODAY });

      expect(row?.hasDebt).toBe(false);
    });
  });

  it('отсутствие обязательного документа — проблема с документами', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1107');
      await tx.insert(schema.documentTypes).values({
        orgId: fixture.orgId,
        code: 'photo_3x4',
        nameI18n: { ru: 'Фото 3×4' },
        isRequired: true,
      });

      const rows = await listHouseResidents(
        fixture.admin,
        { withDocumentProblems: true },
        { executor: tx, today: TODAY },
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.hasDocumentProblem).toBe(true);
    });
  });

  it('жилец списка дома не получает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1108');

      const rows = await listHouseResidents(fixture.resident, {}, { executor: tx, today: TODAY });

      // Видно только собственное проживание — это и есть правило видимости.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.residencyId).toBe(fixture.own.residencyId);
    });
  });
});

describe('карточка жильца', () => {
  it('открывается админу своего дома', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1110');

      const card = await readResidentCard(fixture.admin, fixture.own.residencyId, {
        executor: tx,
        today: TODAY,
      });

      expect(card.row.fullName).toBe('Абдуллаев Имя');
      expect(card.residency.status).toBe('active');
    });
  });

  it('чужая карточка неотличима от несуществующей', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1111');

      await expect(
        readResidentCard(fixture.admin, fixture.foreign.residencyId, {
          executor: tx,
          today: TODAY,
        }),
      ).rejects.toThrow(NotFoundError);
    });
  });
});

describe('смена роли', () => {
  it('суперадмин переводит жильца в админы вместе с домом', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1120');

      const updated = await changeAccountRole(
        fixture.superadmin,
        fixture.own.userId,
        'admin',
        fixture.houseA,
        tx,
      );

      expect(updated.role).toBe('admin');
      expect(updated.houseId).toBe(fixture.houseA);
    });
  });

  it('админу без дома роль не меняют: инвариант «один админ — один дом»', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1121');

      await expect(
        changeAccountRole(fixture.superadmin, fixture.own.userId, 'admin', null, tx),
      ).rejects.toThrow(ValidationError);
    });
  });

  it('при переводе в жильцы дом обнуляется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1122');

      await changeAccountRole(fixture.superadmin, fixture.own.userId, 'admin', fixture.houseA, tx);
      const updated = await changeAccountRole(
        fixture.superadmin,
        fixture.own.userId,
        'resident',
        null,
        tx,
      );

      expect(updated.role).toBe('resident');
      expect(updated.houseId).toBeNull();
    });
  });

  it('админ роли не меняет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1123');

      await expect(
        changeAccountRole(fixture.admin, fixture.own.userId, 'admin', fixture.houseA, tx),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  it('смена роли отзывает сессии и пишется в журнал', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '1124');

      await tx.insert(schema.sessions).values({
        userId: fixture.own.userId,
        tokenHash: `hash-${fixture.own.userId}`,
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      });

      await changeAccountRole(fixture.superadmin, fixture.own.userId, 'admin', fixture.houseA, tx);

      // Только сессии этого пользователя: в базе живут и чужие, от сида сети.
      const sessions = await tx
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, fixture.own.userId));

      expect(sessions).toHaveLength(1);
      expect(sessions.every((session) => session.revokedAt !== null)).toBe(true);

      const actions = (await tx.select().from(schema.auditLog)).map((entry) => entry.action);
      expect(actions).toContain('user.role_changed');
    });
  });
});
