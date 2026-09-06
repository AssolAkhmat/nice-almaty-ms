import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { parseBusinessDate, parseInstant } from '@/lib/time';

import { assignBedToResidency } from './beds';
import {
  archiveResidency,
  createRefundInvoice,
  readTerminationView,
  settleRefund,
  terminateResidency,
} from './terminations';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Расторжение договора и возврат депозита (§2.2–2.3).
 *
 * Арифметика полных месяцев и решение «возврат или сгорание» проверены
 * числами в `src/domain/deposit.test.ts`, срок 30 дней — в
 * `src/domain/termination.test.ts`. Здесь проверяется другое: что статус,
 * занятость места и деньги меняются вместе и в одну сторону.
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

/** Момент действия: из него сервис выводит и «сегодня», и дату расторжения. */
const INSTANT = parseInstant('2026-12-15T11:00:00+05:00');
const TODAY = parseBusinessDate('2026-12-15');
/** Заезд 1 июня: к середине декабря полных месяцев заведомо больше трёх. */
const MOVE_IN = parseBusinessDate('2026-06-01');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `term-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [houseA] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `term-a-${suffix}` })
    .returning();
  const [houseB] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом B', slug: `term-b-${suffix}` })
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
      label: '1 низ',
      defaultPrice: 90_000,
    })
    .returning();

  async function resident(index: number, houseId: string, moveIn: string | null) {
    const [user] = await tx
      .insert(schema.users)
      .values({ orgId, phone: `+7705${index}${suffix}`, passwordHash: 'x', role: 'resident' })
      .returning();

    const [residency] = await tx
      .insert(schema.residencies)
      .values({
        orgId,
        userId: user?.id ?? '',
        houseId,
        status: moveIn === null ? 'deposit_pending' : 'active',
        moveInDate: moveIn,
      })
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

  const a = await resident(1, houseA?.id ?? '', MOVE_IN);
  const b = await resident(2, houseB?.id ?? '', MOVE_IN);
  const next = await resident(3, houseA?.id ?? '', null);

  const context = (
    role: AccessContext['role'],
    userId: string,
    houseId: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId });

  const actor = (ctx: AccessContext): UserActor => ({ context: ctx, requestId: `req-${suffix}` });

  return {
    orgId,
    bedId: bed?.id ?? '',
    residencyA: a.residencyId,
    residencyB: b.residencyId,
    residencyNext: next.residencyId,
    residentA: actor(context('resident', a.userId, null)),
    admin: actor(context('admin', adminUser?.id ?? '', houseA?.id ?? null)),
    adminOfB: actor(context('admin', adminUser?.id ?? '', houseB?.id ?? null)),
  };
}

/** Депозит на счёте: движение со знаком, как его заводит оплата счёта. */
async function chargeDeposit(
  tx: Transaction,
  orgId: string,
  residencyId: string,
  amount: number,
): Promise<void> {
  await tx
    .insert(schema.depositTransactions)
    .values({ orgId, residencyId, type: 'charge', amount, note: 'Оплата депозита' });
}

describe('расторжение договора', () => {
  it('переводит проживание в terminating и запоминает дату выезда (§2.3 п.1–2)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8001');

      const residency = await terminateResidency(
        fixture.admin,
        fixture.residencyA,
        { moveOutDate: parseBusinessDate('2026-12-31'), reason: 'Уезжает в другой город' },
        { executor: tx, instant: INSTANT },
      );

      expect(residency.status).toBe('terminating');
      expect(residency.moveOutDate).toBe('2026-12-31');
      expect(residency.terminationRequestedAt).not.toBeNull();
    });
  });

  it('причина попадает в журнал: отдельного поля для неё в модели нет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8002');

      await terminateResidency(
        fixture.admin,
        fixture.residencyA,
        { moveOutDate: TODAY, reason: 'Нашёл жильё ближе к университету' },
        { executor: tx, instant: INSTANT },
      );

      const entries = await tx
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.entityId, fixture.residencyA));

      const terminated = entries.find((entry) => entry.action === 'residency.terminated');
      expect(terminated?.after).toMatchObject({ reason: 'Нашёл жильё ближе к университету' });
    });
  });

  it('освобождает место с даты выезда: новый жилец заезжает в тот же день (§2.3 п.3)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8003');
      const moveOut = parseBusinessDate('2026-12-31');

      await assignBedToResidency(
        fixture.admin,
        { residencyId: fixture.residencyA, bedId: fixture.bedId, from: MOVE_IN },
        { executor: tx, today: TODAY },
      );

      await terminateResidency(
        fixture.admin,
        fixture.residencyA,
        { moveOutDate: moveOut, reason: 'Съезжает' },
        { executor: tx, instant: INSTANT },
      );

      // Смена жильцов день в день — штатный случай, ограничение занятости не мешает.
      const assignment = await assignBedToResidency(
        fixture.admin,
        { residencyId: fixture.residencyNext, bedId: fixture.bedId, from: moveOut },
        { executor: tx, today: TODAY },
      );

      expect(assignment.bedId).toBe(fixture.bedId);
    });
  });

  it('до даты выезда место остаётся занятым', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8004');

      await assignBedToResidency(
        fixture.admin,
        { residencyId: fixture.residencyA, bedId: fixture.bedId, from: MOVE_IN },
        { executor: tx, today: TODAY },
      );

      await terminateResidency(
        fixture.admin,
        fixture.residencyA,
        { moveOutDate: parseBusinessDate('2026-12-31'), reason: 'Съезжает' },
        { executor: tx, instant: INSTANT },
      );

      await expect(
        assignBedToResidency(
          fixture.admin,
          { residencyId: fixture.residencyNext, bedId: fixture.bedId, from: TODAY },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toThrow();
    });
  });

  it('дата выезда в прошлом не принимается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8005');

      await expect(
        terminateResidency(
          fixture.admin,
          fixture.residencyA,
          { moveOutDate: parseBusinessDate('2026-12-14'), reason: 'Задним числом' },
          { executor: tx, instant: INSTANT },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('дважды расторгнуть нельзя', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8006');

      await terminateResidency(
        fixture.admin,
        fixture.residencyA,
        { moveOutDate: TODAY, reason: 'Съезжает' },
        { executor: tx, instant: INSTANT },
      );

      await expect(
        terminateResidency(
          fixture.admin,
          fixture.residencyA,
          { moveOutDate: TODAY, reason: 'Ещё раз' },
          { executor: tx, instant: INSTANT },
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  it('жилец не расторгает договор сам', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8007');

      await expect(
        terminateResidency(
          fixture.residentA,
          fixture.residencyA,
          { moveOutDate: TODAY, reason: 'Хочу съехать' },
          { executor: tx, instant: INSTANT },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('проживание чужого дома неотличимо от несуществующего', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8008');

      await expect(
        terminateResidency(
          fixture.admin,
          fixture.residencyB,
          { moveOutDate: TODAY, reason: 'Чужой дом' },
          { executor: tx, instant: INSTANT },
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('счёт возврата депозита', () => {
  it('при трёх и более полных месяцах — «В ожидании» на остаток (§2.2)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8010');
      await chargeDeposit(tx, fixture.orgId, fixture.residencyA, 45_000);

      await terminateResidency(
        fixture.admin,
        fixture.residencyA,
        { moveOutDate: TODAY, reason: 'Съезжает' },
        { executor: tx, instant: INSTANT },
      );

      const invoice = await createRefundInvoice(fixture.admin, fixture.residencyA, {
        executor: tx,
        instant: INSTANT,
      });

      expect(invoice?.type).toBe('deposit_refund');
      expect(invoice?.status).toBe('pending');
      expect(invoice?.total).toBe(45_000);

      // Деньги ещё не выплачены: остаток депозита не тронут.
      const view = await readTerminationView(fixture.admin, fixture.residencyA, {
        executor: tx,
        instant: INSTANT,
      });
      expect(view.balance).toBe(45_000);
    });
  });

  it('при менее чем трёх полных месяцах — «Сожжён», остаток списывается сразу', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8011');
      await chargeDeposit(tx, fixture.orgId, fixture.residencyA, 45_000);

      // Заезд 1 декабря: до выезда 31 декабря ни одного полного месяца.
      await tx
        .update(schema.residencies)
        .set({ moveInDate: '2026-12-01' })
        .where(eq(schema.residencies.id, fixture.residencyA));

      await terminateResidency(
        fixture.admin,
        fixture.residencyA,
        { moveOutDate: parseBusinessDate('2026-12-31'), reason: 'Съезжает' },
        { executor: tx, instant: INSTANT },
      );

      const invoice = await createRefundInvoice(fixture.admin, fixture.residencyA, {
        executor: tx,
        instant: INSTANT,
      });

      expect(invoice?.status).toBe('burned');
      expect(invoice?.total).toBe(45_000);

      const view = await readTerminationView(fixture.admin, fixture.residencyA, {
        executor: tx,
        instant: INSTANT,
      });
      expect(view.balance).toBe(0);
      expect(view.transactions.some((movement) => movement.type === 'burn')).toBe(true);
    });
  });

  it('второй счёт возврата не выставляется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8012');
      await chargeDeposit(tx, fixture.orgId, fixture.residencyA, 45_000);

      await terminateResidency(
        fixture.admin,
        fixture.residencyA,
        { moveOutDate: TODAY, reason: 'Съезжает' },
        { executor: tx, instant: INSTANT },
      );

      await createRefundInvoice(fixture.admin, fixture.residencyA, {
        executor: tx,
        instant: INSTANT,
      });

      await expect(
        createRefundInvoice(fixture.admin, fixture.residencyA, { executor: tx, instant: INSTANT }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  it('без расторжения счёт возврата не создать', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8013');
      await chargeDeposit(tx, fixture.orgId, fixture.residencyA, 45_000);

      await expect(
        createRefundInvoice(fixture.admin, fixture.residencyA, { executor: tx, instant: INSTANT }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  it('при отрицательном остатке возвращать нечего: счёта нет, долг виден (§2.4)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8014');
      await chargeDeposit(tx, fixture.orgId, fixture.residencyA, 45_000);
      await tx.insert(schema.depositTransactions).values({
        orgId: fixture.orgId,
        residencyId: fixture.residencyA,
        type: 'damage_share',
        amount: -60_000,
        note: 'Ущерб',
      });

      await terminateResidency(
        fixture.admin,
        fixture.residencyA,
        { moveOutDate: TODAY, reason: 'Съезжает' },
        { executor: tx, instant: INSTANT },
      );

      const invoice = await createRefundInvoice(fixture.admin, fixture.residencyA, {
        executor: tx,
        instant: INSTANT,
      });

      expect(invoice).toBeNull();

      const view = await readTerminationView(fixture.admin, fixture.residencyA, {
        executor: tx,
        instant: INSTANT,
      });
      expect(view.outcome.kind).toBe('debt');
      expect(view.outcome.debt).toBe(15_000);
      expect(view.damages).toBe(60_000);
    });
  });

  it('выплата закрывает счёт статусом «Возвращён» и обнуляет депозит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8015');
      await chargeDeposit(tx, fixture.orgId, fixture.residencyA, 45_000);

      await terminateResidency(
        fixture.admin,
        fixture.residencyA,
        { moveOutDate: TODAY, reason: 'Съезжает' },
        { executor: tx, instant: INSTANT },
      );

      const invoice = await createRefundInvoice(fixture.admin, fixture.residencyA, {
        executor: tx,
        instant: INSTANT,
      });

      const settled = await settleRefund(fixture.admin, invoice?.id ?? '', {
        executor: tx,
        instant: INSTANT,
      });

      expect(settled.status).toBe('returned');

      const view = await readTerminationView(fixture.admin, fixture.residencyA, {
        executor: tx,
        instant: INSTANT,
      });
      expect(view.balance).toBe(0);
      expect(view.transactions.some((movement) => movement.type === 'refund')).toBe(true);
    });
  });

  it('выплаченный счёт второй раз не закрывается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8016');
      await chargeDeposit(tx, fixture.orgId, fixture.residencyA, 45_000);

      await terminateResidency(
        fixture.admin,
        fixture.residencyA,
        { moveOutDate: TODAY, reason: 'Съезжает' },
        { executor: tx, instant: INSTANT },
      );

      const invoice = await createRefundInvoice(fixture.admin, fixture.residencyA, {
        executor: tx,
        instant: INSTANT,
      });

      await settleRefund(fixture.admin, invoice?.id ?? '', { executor: tx, instant: INSTANT });

      await expect(
        settleRefund(fixture.admin, invoice?.id ?? '', { executor: tx, instant: INSTANT }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });
});

describe('экран расчёта', () => {
  it('показывает срок 30 дней и остаток дней от даты расторжения (§2.3 п.4)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8020');
      await chargeDeposit(tx, fixture.orgId, fixture.residencyA, 45_000);

      await terminateResidency(
        fixture.admin,
        fixture.residencyA,
        { moveOutDate: TODAY, reason: 'Съезжает' },
        { executor: tx, instant: INSTANT },
      );

      const view = await readTerminationView(fixture.admin, fixture.residencyA, {
        executor: tx,
        instant: INSTANT,
      });

      expect(view.deadline).toBe('2027-01-14');
      expect(view.daysLeft).toBe(30);
      // Июнь — ноябрь покрыты целиком, декабрь оборван выездом 15 числа.
      expect(view.fullMonths).toBe(6);
      expect(view.outcome.kind).toBe('refund');
    });
  });

  it('жилец видит свой расчёт, но не чужой', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8021');
      await chargeDeposit(tx, fixture.orgId, fixture.residencyA, 45_000);

      await terminateResidency(
        fixture.admin,
        fixture.residencyA,
        { moveOutDate: TODAY, reason: 'Съезжает' },
        { executor: tx, instant: INSTANT },
      );

      const own = await readTerminationView(fixture.residentA, fixture.residencyA, {
        executor: tx,
        instant: INSTANT,
      });
      expect(own.balance).toBe(45_000);

      await expect(
        readTerminationView(fixture.residentA, fixture.residencyB, {
          executor: tx,
          instant: INSTANT,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('архивация проживания', () => {
  it('до наступления даты выезда проживание не архивируется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8030');

      await terminateResidency(
        fixture.admin,
        fixture.residencyA,
        { moveOutDate: parseBusinessDate('2026-12-31'), reason: 'Съезжает' },
        { executor: tx, instant: INSTANT },
      );

      await expect(
        archiveResidency(fixture.admin, fixture.residencyA, { executor: tx, instant: INSTANT }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  it('пока депозит не разобран, проживание не архивируется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8031');
      await chargeDeposit(tx, fixture.orgId, fixture.residencyA, 45_000);

      await terminateResidency(
        fixture.admin,
        fixture.residencyA,
        { moveOutDate: TODAY, reason: 'Съезжает' },
        { executor: tx, instant: INSTANT },
      );

      await expect(
        archiveResidency(fixture.admin, fixture.residencyA, { executor: tx, instant: INSTANT }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  it('после выплаты возврата и даты выезда проживание уходит в архив', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8032');
      await chargeDeposit(tx, fixture.orgId, fixture.residencyA, 45_000);

      await terminateResidency(
        fixture.admin,
        fixture.residencyA,
        { moveOutDate: TODAY, reason: 'Съезжает' },
        { executor: tx, instant: INSTANT },
      );

      const invoice = await createRefundInvoice(fixture.admin, fixture.residencyA, {
        executor: tx,
        instant: INSTANT,
      });
      await settleRefund(fixture.admin, invoice?.id ?? '', { executor: tx, instant: INSTANT });

      const archived = await archiveResidency(fixture.admin, fixture.residencyA, {
        executor: tx,
        instant: INSTANT,
      });

      expect(archived.status).toBe('archived');
    });
  });

  it('долг архивации не мешает: возвращать нечего (§2.4)', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '8033');
      await chargeDeposit(tx, fixture.orgId, fixture.residencyA, 45_000);
      await tx.insert(schema.depositTransactions).values({
        orgId: fixture.orgId,
        residencyId: fixture.residencyA,
        type: 'damage_share',
        amount: -60_000,
        note: 'Ущерб',
      });

      await terminateResidency(
        fixture.admin,
        fixture.residencyA,
        { moveOutDate: TODAY, reason: 'Съезжает' },
        { executor: tx, instant: INSTANT },
      );

      const archived = await archiveResidency(fixture.admin, fixture.residencyA, {
        executor: tx,
        instant: INSTANT,
      });

      expect(archived.status).toBe('archived');
    });
  });
});
