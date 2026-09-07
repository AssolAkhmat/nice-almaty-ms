import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ConflictError } from '@/lib/errors';
import { parseBusinessDate } from '@/lib/time';

import {
  closeInventoryAudit,
  exportInventory,
  readAuditSheet,
  saveAuditFact,
  startAudit,
} from './inventory-audit';
import { readItemHistory, receiveItem } from './inventory';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Инвентаризация и выгрузка (docs/04-MODULES/10-accounting-inventory.md).
 *
 * Ведомость сверяет учёт с фактом; закрытие превращает расхождение
 * в движение, а не переписывает остаток.
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

const TODAY = parseBusinessDate('2026-09-07');

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `iva-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `iva-a-${suffix}` })
    .returning();
  const houseId = house?.id ?? '';

  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7707${suffix}`, passwordHash: 'x', role: 'admin', houseId })
    .returning();

  const context: AccessContext = {
    orgId,
    userId: adminUser?.id ?? '',
    role: 'admin',
    houseId,
  };

  return {
    orgId,
    houseId,
    admin: { context, requestId: `req-${suffix}` } satisfies UserActor,
  };
}

describe('ведомость', () => {
  it('составляется по всем позициям дома с учётным количеством', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6901');

      await receiveItem(
        fixture.admin,
        { houseId: fixture.houseId, name: 'Краска', unit: 'л', unitCost: 3_500, qty: '12.50' },
        { executor: tx, today: TODAY },
      );

      const sheet = await startAudit(fixture.admin, fixture.houseId, {
        executor: tx,
        today: TODAY,
      });

      expect(sheet.audit.status).toBe('draft');
      expect(sheet.lines).toHaveLength(1);
      expect(sheet.lines[0]?.expectedQty).toBe('12.50');
      // Непроверенная строка расхождения не даёт: «не считали» — не «ноль».
      expect(sheet.lines[0]?.actualQty).toBeNull();
      expect(sheet.lines[0]?.difference).toBeNull();
    });
  });

  it('факт считает расхождение в обе стороны', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6902');

      const item = await receiveItem(
        fixture.admin,
        { houseId: fixture.houseId, name: 'Краска', unit: 'л', unitCost: 3_500, qty: '12.50' },
        { executor: tx, today: TODAY },
      );

      const sheet = await startAudit(fixture.admin, fixture.houseId, {
        executor: tx,
        today: TODAY,
      });

      const short = await saveAuditFact(
        fixture.admin,
        sheet.audit.id,
        item.id,
        { actualQty: '10.00', comment: 'Часть израсходована' },
        { executor: tx, today: TODAY },
      );
      expect(short.difference).toBe('-2.50');

      const over = await saveAuditFact(
        fixture.admin,
        sheet.audit.id,
        item.id,
        { actualQty: '13.00' },
        { executor: tx, today: TODAY },
      );
      expect(over.difference).toBe('0.50');
    });
  });
});

describe('закрытие ведомости', () => {
  it('расхождение становится движением, а не правкой остатка', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6903');

      const item = await receiveItem(
        fixture.admin,
        { houseId: fixture.houseId, name: 'Краска', unit: 'л', unitCost: 3_500, qty: '12.50' },
        { executor: tx, today: TODAY },
      );

      const sheet = await startAudit(fixture.admin, fixture.houseId, {
        executor: tx,
        today: TODAY,
      });
      await saveAuditFact(
        fixture.admin,
        sheet.audit.id,
        item.id,
        { actualQty: '10.00' },
        { executor: tx, today: TODAY },
      );

      const result = await closeInventoryAudit(fixture.admin, sheet.audit.id, { executor: tx });

      expect(result.adjusted).toBe(1);
      expect(result.audit.status).toBe('closed');

      const { item: after, movements } = await readItemHistory(fixture.admin, item.id, {
        executor: tx,
      });

      expect(after.qty).toBe('10.00');
      const adjust = movements.find((movement) => movement.type === 'audit_adjust');
      expect(adjust?.qty).toBe('-2.50');
      expect(adjust?.docRef).toBe(sheet.audit.id);
    });
  });

  it('непроверенная строка остаток не трогает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6904');

      const item = await receiveItem(
        fixture.admin,
        { houseId: fixture.houseId, name: 'Швабра', unit: 'шт', unitCost: 2_000, qty: '3' },
        { executor: tx, today: TODAY },
      );

      const sheet = await startAudit(fixture.admin, fixture.houseId, {
        executor: tx,
        today: TODAY,
      });
      const result = await closeInventoryAudit(fixture.admin, sheet.audit.id, { executor: tx });

      expect(result.adjusted).toBe(0);

      const { item: after } = await readItemHistory(fixture.admin, item.id, { executor: tx });
      expect(after.qty).toBe('3.00');
    });
  });

  it('закрытую ведомость второй раз не закрыть и не править', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6905');

      const item = await receiveItem(
        fixture.admin,
        { houseId: fixture.houseId, name: 'Швабра', unit: 'шт', unitCost: 2_000, qty: '3' },
        { executor: tx, today: TODAY },
      );

      const sheet = await startAudit(fixture.admin, fixture.houseId, {
        executor: tx,
        today: TODAY,
      });
      await closeInventoryAudit(fixture.admin, sheet.audit.id, { executor: tx });

      await expect(
        closeInventoryAudit(fixture.admin, sheet.audit.id, { executor: tx }),
      ).rejects.toBeInstanceOf(ConflictError);

      await expect(
        saveAuditFact(
          fixture.admin,
          sheet.audit.id,
          item.id,
          { actualQty: '2' },
          { executor: tx, today: TODAY },
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  it('ведомость читается со строками и расхождениями', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6906');

      const item = await receiveItem(
        fixture.admin,
        { houseId: fixture.houseId, name: 'Краска', unit: 'л', unitCost: 3_500, qty: '5.00' },
        { executor: tx, today: TODAY },
      );

      const sheet = await startAudit(fixture.admin, fixture.houseId, {
        executor: tx,
        today: TODAY,
      });
      await saveAuditFact(
        fixture.admin,
        sheet.audit.id,
        item.id,
        { actualQty: '4.50', comment: 'Разлили' },
        { executor: tx, today: TODAY },
      );

      const reread = await readAuditSheet(fixture.admin, sheet.audit.id, { executor: tx });

      expect(reread.lines[0]?.name).toBe('Краска');
      expect(reread.lines[0]?.difference).toBe('-0.50');
      expect(reread.lines[0]?.comment).toBe('Разлили');
    });
  });
});

describe('выгрузка', () => {
  it('CSV содержит заголовки и количества строкой', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6907');

      await receiveItem(
        fixture.admin,
        {
          houseId: fixture.houseId,
          name: 'Краска; белая',
          unit: 'л',
          unitCost: 3_500,
          qty: '12.50',
        },
        { executor: tx, today: TODAY },
      );

      const file = await exportInventory(fixture.admin, fixture.houseId, 'csv', {
        executor: tx,
        today: TODAY,
      });

      expect(file.filename).toBe('inventory-2026-09-07.csv');
      expect(typeof file.body).toBe('string');
      expect(file.body).toContain('Наименование;Количество');
      // Точка с запятой внутри названия не должна разрывать строку.
      expect(file.body).toContain('"Краска; белая";12.50');
    });
  });

  it('XLSX собирается архивом с данными', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6908');

      await receiveItem(
        fixture.admin,
        { houseId: fixture.houseId, name: 'Краска', unit: 'л', unitCost: 3_500, qty: '12.50' },
        { executor: tx, today: TODAY },
      );

      const file = await exportInventory(fixture.admin, fixture.houseId, 'xlsx', {
        executor: tx,
        today: TODAY,
      });

      expect(file.filename).toBe('inventory-2026-09-07.xlsx');
      const body = file.body as Uint8Array;
      expect([...body.subarray(0, 2)]).toEqual([0x50, 0x4b]);
      expect(new TextDecoder().decode(body)).toContain('Краска');
    });
  });
});
