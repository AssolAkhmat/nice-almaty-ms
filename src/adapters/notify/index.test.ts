import { describe, expect, it } from 'vitest';

import { parseEnv } from '@/lib/env/schema';

import {
  classifyPushResponse,
  inappSender,
  pushPublicKey,
  resolveSenders,
  whatsappStubSender,
} from '.';

import type { DeliveryMessage } from './types';

/**
 * Реестр каналов доставки (docs/01-ARCHITECTURE.md, адаптеры `notify/*`).
 *
 * Канал без ключей не подключается: пусть лучше строка очереди честно
 * скажет «канал не подключён», чем сломается на подписи у каждого
 * уведомления.
 */
const PUSH_KEYS = {
  WEBPUSH_PUBLIC_KEY: 'BPublicKeyOfTheNetwork',
  WEBPUSH_PRIVATE_KEY: 'PrivateScalarOfTheNetwork',
  WEBPUSH_SUBJECT: 'mailto:admin@nice-almaty.kz',
};

function env(overrides: Record<string, string | undefined> = {}) {
  return parseEnv({
    DEPLOY_TARGET: 'docker',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/nice',
    APP_URL: 'http://localhost:3000',
    SESSION_SECRET: 's'.repeat(32),
    FIELD_ENCRYPTION_KEY: 'A'.repeat(43) + '=',
    CRON_SECRET: 'c'.repeat(16),
    STORAGE_DRIVER: 'local',
    ...overrides,
  });
}

const MESSAGE: DeliveryMessage = {
  notificationId: '00000000-0000-0000-0000-000000000001',
  userId: '00000000-0000-0000-0000-000000000002',
  type: 'rotation.reminder',
  title: { ru: 'Уборка завтра', kk: 'Ертең жинау', en: 'Cleaning tomorrow' },
  body: { ru: 'Двор, 09:00', kk: 'Аула, 09:00', en: 'Yard, 09:00' },
  payload: {},
  locale: 'ru',
};

describe('реестр каналов', () => {
  it('без ключей push канал не подключается', () => {
    const senders = resolveSenders(env());

    expect(Object.keys(senders).sort()).toEqual(['inapp', 'whatsapp']);
  });

  it('с ключами push канал появляется', () => {
    const senders = resolveSenders(env(PUSH_KEYS));

    expect(senders.webpush?.channel).toBe('webpush');
  });

  it('публичный ключ отдаётся браузеру, а без настройки его нет', () => {
    expect(pushPublicKey(env(PUSH_KEYS))).toBe(PUSH_KEYS.WEBPUSH_PUBLIC_KEY);
    expect(pushPublicKey(env())).toBeNull();
  });
});

describe('канал в приложении', () => {
  it('доставка сводится к записи, которая уже есть', async () => {
    const executor = null as never;

    expect(await inappSender.deliver(MESSAGE, { executor })).toEqual({ kind: 'sent' });
  });
});

describe('заглушка WhatsApp', () => {
  it('честно пропускает и называет причину', async () => {
    const executor = null as never;
    const outcome = await whatsappStubSender.deliver(MESSAGE, { executor });

    expect(outcome.kind).toBe('skipped');
    expect(outcome.kind === 'skipped' && outcome.reason).toContain('не подключён');
  });
});

describe('ответы push-сервиса', () => {
  it('успех — это любой двухсотый', () => {
    expect(classifyPushResponse(200)).toBe('delivered');
    expect(classifyPushResponse(201)).toBe('delivered');
    expect(classifyPushResponse(202)).toBe('delivered');
  });

  it('404 и 410 значат, что подписки больше нет', () => {
    expect(classifyPushResponse(404)).toBe('gone');
    expect(classifyPushResponse(410)).toBe('gone');
  });

  it('таймаут, перегрузка и отказ сервиса — повод повторить', () => {
    expect(classifyPushResponse(408)).toBe('retry');
    expect(classifyPushResponse(429)).toBe('retry');
    expect(classifyPushResponse(500)).toBe('retry');
    expect(classifyPushResponse(503)).toBe('retry');
  });

  it('остальные отказы повтором не исправить', () => {
    expect(classifyPushResponse(400)).toBe('permanent');
    expect(classifyPushResponse(403)).toBe('permanent');
    expect(classifyPushResponse(413)).toBe('permanent');
  });
});
