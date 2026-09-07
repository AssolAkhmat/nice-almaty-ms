import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { MAX_DELIVERY_ATTEMPTS, type DeliveryOutcome } from '@/domain/notifications';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { parseInstant } from '@/lib/time';

import {
  dispatchNotifications,
  listInbox,
  listOwnPushSubscriptions,
  markRead,
  notify,
  subscribeToPush,
  unsubscribeFromPush,
} from './notifications';

import type { SenderRegistry } from '@/adapters/notify/types';
import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';

/**
 * Ядро очереди уведомлений (docs/01-ARCHITECTURE.md, «Планировщик»;
 * docs/02-DATA-MODEL.md — «Файлы, уведомления, система»).
 *
 * Постановка уведомления, разбор очереди и правило попыток. Каналов
 * доставки здесь нет: в разбор они приходят снаружи, как и в жизни.
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
    .values({ name: 'Nice Almaty', slug: `nsv-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `nsv-a-${suffix}` })
    .returning();
  const houseId = house?.id ?? '';

  const [superadminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+77001${suffix}`, passwordHash: 'x', role: 'superadmin' })
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
    network: context('superadmin', superadminUser?.id ?? ''),
    dweller: context('resident', firstUser?.id ?? ''),
    neighbour: context('resident', secondUser?.id ?? ''),
  };
}

/** Чужая сеть: адресат существует, но у него другой `org_id`. */
async function seedOtherOrg(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Другая сеть', slug: `nsv-x-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [user] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+77771${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  return { orgId, userId: user?.id ?? '' };
}

const TEXTS = {
  title: { ru: 'Уборка завтра', kk: 'Ертең жинау', en: 'Cleaning tomorrow' },
  body: { ru: 'Двор, 09:00', kk: 'Аула, 09:00', en: 'Yard, 09:00' },
};

/** Канал-двойник: считает вызовы и отвечает тем, что ему велели. */
function sender(outcome: DeliveryOutcome) {
  const calls: string[] = [];

  const registry: SenderRegistry = {
    inapp: {
      channel: 'inapp',
      deliver: (message) => {
        calls.push(message.notificationId);

        return Promise.resolve(outcome);
      },
    },
  };

  return { registry, calls };
}

async function outboxOf(tx: Transaction, notificationId: string) {
  return tx
    .select()
    .from(schema.notificationOutbox)
    .where(eq(schema.notificationOutbox.notificationId, notificationId));
}

describe('постановка уведомления', () => {
  it('создаёт факт и ставит очередь в приложение', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6201');

      const notification = await notify(
        fixture.network,
        {
          userId: fixture.first,
          type: 'rotation.reminder',
          ...TEXTS,
          payload: { day: '2026-09-08' },
        },
        tx,
      );

      expect(notification.userId).toBe(fixture.first);
      expect(notification.titleI18n).toEqual(TEXTS.title);
      expect(notification.payload).toEqual({ day: '2026-09-08' });

      const queue = await outboxOf(tx, notification.id);
      expect(queue.map((row) => row.channel)).toEqual(['inapp']);
      expect(queue[0]?.status).toBe('queued');
    });
  });

  it('добавляет push, когда у адресата есть живая подписка', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6202');

      await tx.insert(schema.pushSubscriptions).values({
        userId: fixture.first,
        endpoint: 'https://push.example/6202',
        p256dh: 'k',
        auth: 'a',
      });

      const notification = await notify(
        fixture.network,
        { userId: fixture.first, type: 'rotation.reminder', ...TEXTS },
        tx,
      );

      const queue = await outboxOf(tx, notification.id);
      expect(queue.map((row) => row.channel).sort()).toEqual(['inapp', 'webpush']);
    });
  });

  it('отозванная подписка канал не добавляет', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6203');

      await tx.insert(schema.pushSubscriptions).values({
        userId: fixture.first,
        endpoint: 'https://push.example/6203',
        p256dh: 'k',
        auth: 'a',
        revokedAt: parseInstant('2026-09-01T00:00:00+05:00'),
      });

      const notification = await notify(
        fixture.network,
        { userId: fixture.first, type: 'rotation.reminder', ...TEXTS },
        tx,
      );

      const queue = await outboxOf(tx, notification.id);
      expect(queue.map((row) => row.channel)).toEqual(['inapp']);
    });
  });

  it('текст без казахской локали не ставится', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6204');

      await expect(
        notify(
          fixture.network,
          {
            userId: fixture.first,
            type: 'rotation.reminder',
            title: { ru: 'Уборка', kk: '', en: 'Cleaning' },
            body: TEXTS.body,
          },
          tx,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('адресат из чужой сети уведомления не получает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6205');
      const stranger = await seedOtherOrg(tx, '6205');

      await expect(
        notify(
          fixture.network,
          { userId: stranger.userId, type: 'rotation.reminder', ...TEXTS },
          tx,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('чтение уведомлений', () => {
  it('уведомление чужого жильца не читается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6206');

      const foreign = await notify(
        fixture.network,
        { userId: fixture.second, type: 'rotation.reminder', ...TEXTS },
        tx,
      );

      expect(await listInbox(fixture.dweller, {}, tx)).toEqual([]);
      await expect(markRead(fixture.dweller, foreign.id, tx)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });

  it('свои читаются и помечаются прочитанными', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6207');

      const mine = await notify(
        fixture.network,
        { userId: fixture.first, type: 'rotation.reminder', ...TEXTS },
        tx,
      );

      expect(await listInbox(fixture.dweller, { unreadOnly: true }, tx)).toHaveLength(1);

      const read = await markRead(fixture.dweller, mine.id, tx);
      expect(read.readAt).not.toBeNull();
      expect(await listInbox(fixture.dweller, { unreadOnly: true }, tx)).toEqual([]);
    });
  });
});

describe('разбор очереди', () => {
  it('доставленное закрывается, а повторный разбор не отправляет дважды', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6208');
      const channel = sender({ kind: 'sent' });

      const notification = await notify(
        fixture.network,
        { userId: fixture.first, type: 'rotation.reminder', ...TEXTS },
        tx,
      );

      const first = await dispatchNotifications({ executor: tx, senders: channel.registry });
      expect(first.sent).toBe(1);

      const second = await dispatchNotifications({ executor: tx, senders: channel.registry });
      expect(second.taken).toBe(0);
      expect(channel.calls).toEqual([notification.id]);

      const queue = await outboxOf(tx, notification.id);
      expect(queue[0]?.status).toBe('sent');
      expect(queue[0]?.attempts).toBe(1);
      expect(queue[0]?.sentAt).not.toBeNull();
    });
  });

  it('временная помеха возвращает строку в очередь и сдаётся на пятой попытке', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6209');
      const channel = sender({ kind: 'retry', error: 'таймаут' });

      const notification = await notify(
        fixture.network,
        { userId: fixture.first, type: 'rotation.reminder', ...TEXTS },
        tx,
      );

      for (let attempt = 1; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
        const result = await dispatchNotifications({ executor: tx, senders: channel.registry });
        expect(result.retried).toBe(1);

        const pending = await outboxOf(tx, notification.id);
        expect(pending[0]?.status).toBe('queued');
        expect(pending[0]?.attempts).toBe(attempt);
      }

      const last = await dispatchNotifications({ executor: tx, senders: channel.registry });
      expect(last.failed).toBe(1);

      const queue = await outboxOf(tx, notification.id);
      expect(queue[0]?.status).toBe('failed');
      expect(queue[0]?.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
      expect(queue[0]?.error).toBe('таймаут');
    });
  });

  it('окончательная ошибка канала закрывает строку сразу', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6210');
      const channel = sender({ kind: 'permanent', error: '410 Gone' });

      const notification = await notify(
        fixture.network,
        { userId: fixture.first, type: 'rotation.reminder', ...TEXTS },
        tx,
      );

      const result = await dispatchNotifications({ executor: tx, senders: channel.registry });
      expect(result.failed).toBe(1);

      const queue = await outboxOf(tx, notification.id);
      expect(queue[0]?.status).toBe('failed');
      expect(queue[0]?.attempts).toBe(1);
    });
  });

  it('исключение канала считается временной помехой, а не потерей строки', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6211');

      const registry: SenderRegistry = {
        inapp: {
          channel: 'inapp',
          deliver: () => {
            throw new Error('сеть недоступна');
          },
        },
      };

      const notification = await notify(
        fixture.network,
        { userId: fixture.first, type: 'rotation.reminder', ...TEXTS },
        tx,
      );

      const result = await dispatchNotifications({ executor: tx, senders: registry });
      expect(result.retried).toBe(1);

      const queue = await outboxOf(tx, notification.id);
      expect(queue[0]?.status).toBe('queued');
      expect(queue[0]?.error).toContain('сеть недоступна');
    });
  });

  it('канал без отправителя честно помечается пропущенным', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6212');

      const notification = await notify(
        fixture.network,
        { userId: fixture.first, type: 'rotation.reminder', ...TEXTS },
        tx,
      );

      const result = await dispatchNotifications({ executor: tx, senders: {} });
      expect(result.skipped).toBe(1);

      const queue = await outboxOf(tx, notification.id);
      expect(queue[0]?.status).toBe('skipped');
      expect(queue[0]?.attempts).toBe(0);
    });
  });

  it('канал получает тексты во всех локалях, адресата и payload', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6213');
      const seen: unknown[] = [];

      const registry: SenderRegistry = {
        inapp: {
          channel: 'inapp',
          deliver: (message) => {
            seen.push(message);

            return Promise.resolve({ kind: 'sent' });
          },
        },
      };

      await notify(
        fixture.network,
        { userId: fixture.first, type: 'rotation.reminder', ...TEXTS, payload: { id: 7 } },
        tx,
      );
      await dispatchNotifications({ executor: tx, senders: registry });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        userId: fixture.first,
        type: 'rotation.reminder',
        title: TEXTS.title,
        body: TEXTS.body,
        payload: { id: 7 },
        locale: 'ru',
      });
    });
  });

  it('канал получает язык адресата, а не язык отправителя', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6214');
      const locales: unknown[] = [];

      await tx.update(schema.users).set({ locale: 'kk' }).where(eq(schema.users.id, fixture.first));

      const registry: SenderRegistry = {
        inapp: {
          channel: 'inapp',
          deliver: (message) => {
            locales.push(message.locale);

            return Promise.resolve({ kind: 'sent' });
          },
        },
      };

      await notify(
        fixture.network,
        { userId: fixture.first, type: 'rotation.reminder', ...TEXTS },
        tx,
      );
      await dispatchNotifications({ executor: tx, senders: registry });

      expect(locales).toEqual(['kk']);
    });
  });
});

describe('подписка на push', () => {
  it('жилец подписывает свой браузер и отключает его сам', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6215');
      const endpoint = 'https://push.example.com/send/6215';

      const subscription = await subscribeToPush(
        fixture.dweller,
        { endpoint, p256dh: 'k', auth: 'a', userAgent: 'Firefox' },
        tx,
      );

      expect(subscription.userId).toBe(fixture.first);
      expect(await listOwnPushSubscriptions(fixture.dweller, tx)).toHaveLength(1);

      await unsubscribeFromPush(fixture.dweller, endpoint, tx);

      expect(await listOwnPushSubscriptions(fixture.dweller, tx)).toEqual([]);
    });
  });

  it('чужую подписку сосед не отключает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6216');
      const endpoint = 'https://push.example.com/send/6216';

      await subscribeToPush(fixture.dweller, { endpoint, p256dh: 'k', auth: 'a' }, tx);

      await expect(unsubscribeFromPush(fixture.neighbour, endpoint, tx)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect(await listOwnPushSubscriptions(fixture.dweller, tx)).toHaveLength(1);
    });
  });
});
