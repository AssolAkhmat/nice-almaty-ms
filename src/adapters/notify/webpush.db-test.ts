import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';

import { createWebPushSender } from './webpush';

import type { DeliveryMessage } from './types';
import type { Database, Transaction } from '@/db/client';

/**
 * Канал Web Push (docs/01-ARCHITECTURE.md, адаптеры `notify/*`).
 *
 * Живого push-сервиса у прогона нет, поэтому `fetch` подменяется: важно
 * не то, как сервис отвечает, а что канал делает с его ответом.
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

/**
 * Ключи подписки — настоящие: канал их шифрует, и подделка длиной
 * в пару байт не прошла бы дальше первого вызова WebCrypto.
 */
async function subscriptionKeys(): Promise<{ p256dh: string; auth: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));

  return {
    p256dh: Buffer.from(raw).toString('base64url'),
    auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
  };
}

const VAPID = {
  publicKey: '',
  privateKey: '',
  subject: 'mailto:admin@nice-almaty.kz',
};

/** Пара VAPID заводится один раз на файл: генерация ключа не бесплатна. */
async function vapidKeys() {
  if (VAPID.publicKey !== '') {
    return VAPID;
  }

  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

  VAPID.publicKey = Buffer.from(raw).toString('base64url');
  VAPID.privateKey = jwk.d ?? '';

  return VAPID;
}

async function seed(tx: Transaction, suffix: string, endpoints: readonly string[]) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `wpu-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [user] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+77093${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();
  const userId = user?.id ?? '';

  for (const endpoint of endpoints) {
    const keys = await subscriptionKeys();
    await tx.insert(schema.pushSubscriptions).values({ userId, endpoint, ...keys });
  }

  const [notification] = await tx
    .insert(schema.notifications)
    .values({
      orgId,
      userId,
      type: 'rotation.reminder',
      titleI18n: { ru: 'Уборка завтра', kk: 'Ертең жинау', en: 'Cleaning tomorrow' },
      bodyI18n: { ru: 'Двор, 09:00', kk: 'Аула, 09:00', en: 'Yard, 09:00' },
      payload: { day: '2026-09-08' },
    })
    .returning();

  const message: DeliveryMessage = {
    notificationId: notification?.id ?? '',
    userId,
    type: 'rotation.reminder',
    title: { ru: 'Уборка завтра', kk: 'Ертең жинау', en: 'Cleaning tomorrow' },
    body: { ru: 'Двор, 09:00', kk: 'Аула, 09:00', en: 'Yard, 09:00' },
    payload: { day: '2026-09-08' },
    locale: 'ru',
  };

  return { orgId, userId, message };
}

async function subscriptionOf(tx: Transaction, endpoint: string) {
  const [row] = await tx
    .select()
    .from(schema.pushSubscriptions)
    .where(eq(schema.pushSubscriptions.endpoint, endpoint));

  return row;
}

describe('доставка push', () => {
  it('принятое push-сервисом закрывает строку', async () => {
    await inRollback(async (tx) => {
      const endpoint = 'https://push.example.com/send/6301';
      const fixture = await seed(tx, '6301', [endpoint]);
      const requests: Request[] = [];

      const sender = createWebPushSender(await vapidKeys(), {
        fetch: (input, init) => {
          requests.push(new Request(input, init));

          return Promise.resolve(new Response(null, { status: 201 }));
        },
      });

      const outcome = await sender.deliver(fixture.message, { executor: tx });

      expect(outcome).toEqual({ kind: 'sent' });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(endpoint);
      expect(requests[0]?.headers.get('Content-Encoding')).toBe('aes128gcm');
      expect(requests[0]?.headers.get('Authorization')?.startsWith('vapid t=')).toBe(true);
      expect(requests[0]?.headers.get('TTL')).toBe('86400');
    });
  });

  it('снятая подписка отзывается, и повторять доставку незачем', async () => {
    await inRollback(async (tx) => {
      const endpoint = 'https://push.example.com/send/6302';
      const fixture = await seed(tx, '6302', [endpoint]);

      const sender = createWebPushSender(await vapidKeys(), {
        fetch: () => Promise.resolve(new Response(null, { status: 410 })),
      });

      const outcome = await sender.deliver(fixture.message, { executor: tx });

      expect(outcome.kind).toBe('permanent');
      expect((await subscriptionOf(tx, endpoint))?.revokedAt).not.toBeNull();
    });
  });

  it('занятый push-сервис даёт повтор, а не потерю уведомления', async () => {
    await inRollback(async (tx) => {
      const endpoint = 'https://push.example.com/send/6303';
      const fixture = await seed(tx, '6303', [endpoint]);

      const sender = createWebPushSender(await vapidKeys(), {
        fetch: () => Promise.resolve(new Response(null, { status: 503 })),
      });

      const outcome = await sender.deliver(fixture.message, { executor: tx });

      expect(outcome).toEqual({ kind: 'retry', error: 'push-сервис ответил 503' });
      expect((await subscriptionOf(tx, endpoint))?.revokedAt).toBeNull();
    });
  });

  it('отклонённое сообщение не тратит попытки', async () => {
    await inRollback(async (tx) => {
      const endpoint = 'https://push.example.com/send/6304';
      const fixture = await seed(tx, '6304', [endpoint]);

      const sender = createWebPushSender(await vapidKeys(), {
        fetch: () => Promise.resolve(new Response(null, { status: 403 })),
      });

      const outcome = await sender.deliver(fixture.message, { executor: tx });

      expect(outcome.kind).toBe('permanent');
      expect((await subscriptionOf(tx, endpoint))?.revokedAt).toBeNull();
    });
  });

  it('оборванная сеть — временная помеха', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6305', ['https://push.example.com/send/6305']);

      const sender = createWebPushSender(await vapidKeys(), {
        fetch: () => Promise.reject(new Error('соединение сброшено')),
      });

      const outcome = await sender.deliver(fixture.message, { executor: tx });

      expect(outcome).toEqual({ kind: 'retry', error: 'соединение сброшено' });
    });
  });

  it('доставка на один из двух браузеров закрывает строку', async () => {
    await inRollback(async (tx) => {
      const alive = 'https://push.example.com/send/6306-alive';
      const dead = 'https://push.example.com/send/6306-dead';
      const fixture = await seed(tx, '6306', [dead, alive]);

      const sender = createWebPushSender(await vapidKeys(), {
        fetch: (input) =>
          Promise.resolve(
            new Response(null, { status: new Request(input).url === alive ? 201 : 410 }),
          ),
      });

      const outcome = await sender.deliver(fixture.message, { executor: tx });

      expect(outcome).toEqual({ kind: 'sent' });
      expect((await subscriptionOf(tx, dead))?.revokedAt).not.toBeNull();
      expect((await subscriptionOf(tx, alive))?.revokedAt).toBeNull();
    });
  });

  it('без подписки канал честно пропускает, а не ошибается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '6307', []);

      const sender = createWebPushSender(await vapidKeys(), {
        fetch: () => Promise.reject(new Error('сюда не дойдёт')),
      });

      const outcome = await sender.deliver(fixture.message, { executor: tx });

      expect(outcome).toEqual({ kind: 'skipped', reason: 'У адресата нет подписки на push' });
    });
  });
});
