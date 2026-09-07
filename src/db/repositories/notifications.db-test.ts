import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ForbiddenError } from '@/lib/errors';

import {
  countUnread,
  createNotification,
  listNotifications,
  listOutbox,
  markNotificationRead,
  markOutboxSent,
  putPushSubscription,
  queueOutbox,
  revokePushSubscription,
  listPushSubscriptions,
} from './notifications';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';

/**
 * Уведомления, очередь доставки и подписки (docs/02-DATA-MODEL.md,
 * docs/01-ARCHITECTURE.md — адаптеры `notify/*`).
 *
 * Уведомление принадлежит человеку: читает его он сам, а из чужой сети
 * оно неотличимо от несуществующего.
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

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `ntf-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `ntf-a-${suffix}` })
    .returning();
  const houseId = house?.id ?? '';

  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7707${suffix}`, passwordHash: 'x', role: 'admin', houseId })
    .returning();
  const [firstUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+77091${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();
  const [secondUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+77092${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  const context = (role: AccessContext['role'], userId: string): AccessContext => ({
    orgId,
    userId,
    role,
    houseId: role === 'admin' ? houseId : null,
  });

  return {
    orgId,
    houseId,
    first: firstUser?.id ?? '',
    second: secondUser?.id ?? '',
    admin: context('admin', adminUser?.id ?? ''),
    dweller: context('resident', firstUser?.id ?? ''),
    neighbour: context('resident', secondUser?.id ?? ''),
  };
}

const TEXTS = {
  title: { ru: 'Уборка завтра', kk: 'Ертең жинау', en: 'Cleaning tomorrow' },
  body: { ru: 'Двор, 09:00', kk: 'Аула, 09:00', en: 'Yard, 09:00' },
};

describe('уведомления', () => {
  it('жилец читает свои и не видит чужих', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6101');

      await createNotification(
        fixture.admin,
        { userId: fixture.first, type: 'rotation.reminder', ...TEXTS },
        tx,
      );
      await createNotification(
        fixture.admin,
        { userId: fixture.second, type: 'rotation.reminder', ...TEXTS },
        tx,
      );

      const mine = await listNotifications(fixture.dweller, { userId: fixture.first }, tx);
      const foreign = await listNotifications(fixture.dweller, { userId: fixture.second }, tx);

      expect(mine).toHaveLength(1);
      expect(mine[0]?.titleI18n).toEqual(TEXTS.title);
      expect(foreign).toEqual([]);
    });
  });

  it('непрочитанное считается по адресату', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6102');

      const first = await createNotification(
        fixture.admin,
        { userId: fixture.first, type: 'invoice.issued', ...TEXTS },
        tx,
      );
      await createNotification(
        fixture.admin,
        { userId: fixture.first, type: 'invoice.due', ...TEXTS },
        tx,
      );

      expect(await countUnread(fixture.dweller, tx)).toBe(2);

      await markNotificationRead(fixture.dweller, first.id, tx);

      expect(await countUnread(fixture.dweller, tx)).toBe(1);
    });
  });

  it('чужое уведомление не помечается прочитанным', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6103');

      const foreign = await createNotification(
        fixture.admin,
        { userId: fixture.second, type: 'invoice.issued', ...TEXTS },
        tx,
      );

      await expect(markNotificationRead(fixture.dweller, foreign.id, tx)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });
});

describe('очередь доставки', () => {
  it('уведомление ставится в очередь по каналам и берётся разбором', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6111');

      const notification = await createNotification(
        fixture.admin,
        { userId: fixture.first, type: 'rotation.reminder', ...TEXTS },
        tx,
      );

      await queueOutbox(notification.id, ['inapp', 'webpush'], tx);

      /*
       * Очередь общая на всю базу, и прогон приёмки оставляет в ней свои
       * строки: смотреть надо на строки своего уведомления, а не на всю
       * таблицу — иначе тест зависит от того, что делали до него.
       */
      const queued = (await listOutbox({ status: 'queued', limit: 100 }, tx)).filter(
        (row) => row.notificationId === notification.id,
      );

      expect(queued.map((row) => row.channel).sort()).toEqual(['inapp', 'webpush']);
    });
  });

  it('отправленное из очереди больше не берётся', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6112');

      const notification = await createNotification(
        fixture.admin,
        { userId: fixture.first, type: 'rotation.reminder', ...TEXTS },
        tx,
      );
      await queueOutbox(notification.id, ['inapp'], tx);

      const mine = <Row extends { notificationId: string }>(rows: Row[]): Row[] =>
        rows.filter((row) => row.notificationId === notification.id);

      const [row] = mine(await listOutbox({ status: 'queued', limit: 100 }, tx));
      await markOutboxSent(row?.id ?? '', tx);

      expect(mine(await listOutbox({ status: 'queued', limit: 100 }, tx))).toEqual([]);
      const sent = mine(await listOutbox({ status: 'sent', limit: 100 }, tx));
      expect(sent[0]?.sentAt).not.toBeNull();
      expect(sent[0]?.attempts).toBe(1);
    });
  });

  it('один канал на уведомление: повтор постановки не удваивает очередь', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6113');

      const notification = await createNotification(
        fixture.admin,
        { userId: fixture.first, type: 'rotation.reminder', ...TEXTS },
        tx,
      );

      await queueOutbox(notification.id, ['inapp'], tx);
      await queueOutbox(notification.id, ['inapp'], tx);

      const queued = (await listOutbox({ status: 'queued', limit: 100 }, tx)).filter(
        (row) => row.notificationId === notification.id,
      );

      expect(queued).toHaveLength(1);
    });
  });
});

describe('подписки на push', () => {
  it('подписка заводится и переписывается по адресу', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6121');

      await putPushSubscription(
        fixture.dweller,
        { endpoint: 'https://push.example/1', p256dh: 'k1', auth: 'a1', userAgent: 'Chrome' },
        tx,
      );
      await putPushSubscription(
        fixture.dweller,
        { endpoint: 'https://push.example/1', p256dh: 'k2', auth: 'a2', userAgent: 'Firefox' },
        tx,
      );

      const subscriptions = await listPushSubscriptions(fixture.first, tx);

      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0]?.p256dh).toBe('k2');
    });
  });

  it('отозванная подписка в рассылку не попадает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6122');

      await putPushSubscription(
        fixture.dweller,
        { endpoint: 'https://push.example/2', p256dh: 'k1', auth: 'a1' },
        tx,
      );
      await revokePushSubscription('https://push.example/2', tx);

      expect(await listPushSubscriptions(fixture.first, tx)).toEqual([]);
    });
  });

  it('чужую подписку жилец не заводит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6123');

      await putPushSubscription(
        fixture.neighbour,
        { endpoint: 'https://push.example/3', p256dh: 'k1', auth: 'a1' },
        tx,
      );

      // Подписка привязана к тому, кто её завёл, а не к переданному адресату.
      expect(await listPushSubscriptions(fixture.first, tx)).toEqual([]);
      expect(await listPushSubscriptions(fixture.second, tx)).toHaveLength(1);
    });
  });
});
