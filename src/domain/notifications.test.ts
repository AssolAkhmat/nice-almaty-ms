import { describe, expect, it } from 'vitest';

import {
  MAX_DELIVERY_ATTEMPTS,
  channelsFor,
  missingLocales,
  nextDeliveryState,
} from './notifications';

/**
 * Ядро очереди уведомлений (docs/01-ARCHITECTURE.md, «Планировщик»,
 * docs/02-DATA-MODEL.md — «Файлы, уведомления, система»).
 *
 * Числа здесь — решение P6-4: пять попыток, пауза длиной в шаг задания.
 */
describe('состояние строки очереди', () => {
  it('доставленное закрывается и считает попытку', () => {
    expect(nextDeliveryState(0, { kind: 'sent' })).toEqual({
      status: 'sent',
      attempts: 1,
      error: null,
    });
  });

  it('временная помеха возвращает строку в очередь', () => {
    expect(nextDeliveryState(0, { kind: 'retry', error: 'таймаут' })).toEqual({
      status: 'queued',
      attempts: 1,
      error: 'таймаут',
    });
  });

  it('последняя попытка закрывает строку окончательно', () => {
    const state = nextDeliveryState(MAX_DELIVERY_ATTEMPTS - 1, { kind: 'retry', error: '503' });

    expect(state).toEqual({ status: 'failed', attempts: MAX_DELIVERY_ATTEMPTS, error: '503' });
  });

  it('исчерпанная строка не оживает от лишнего прогона', () => {
    const state = nextDeliveryState(MAX_DELIVERY_ATTEMPTS + 3, { kind: 'retry', error: '503' });

    expect(state.status).toBe('failed');
  });

  it('окончательная ошибка не ждёт остатка попыток', () => {
    expect(nextDeliveryState(0, { kind: 'permanent', error: '410 Gone' })).toEqual({
      status: 'failed',
      attempts: 1,
      error: '410 Gone',
    });
  });

  it('пропуск не тратит попытку: доставки не было', () => {
    expect(nextDeliveryState(2, { kind: 'skipped', reason: 'канал не подключён' })).toEqual({
      status: 'skipped',
      attempts: 2,
      error: 'канал не подключён',
    });
  });
});

describe('каналы уведомления', () => {
  it('без подписки остаётся только приложение', () => {
    expect(channelsFor({ hasPushSubscription: false })).toEqual(['inapp']);
  });

  it('с подпиской добавляется push', () => {
    expect(channelsFor({ hasPushSubscription: true })).toEqual(['inapp', 'webpush']);
  });
});

describe('тексты в трёх локалях', () => {
  it('полный набор проходит', () => {
    expect(missingLocales({ ru: 'Уборка', kk: 'Жинау', en: 'Cleaning' })).toEqual([]);
  });

  it('недостающая локаль называется поимённо', () => {
    expect(missingLocales({ ru: 'Уборка', en: 'Cleaning' })).toEqual(['kk']);
  });

  it('пустая строка — это отсутствие текста, а не текст', () => {
    expect(missingLocales({ ru: 'Уборка', kk: '   ', en: 'Cleaning' })).toEqual(['kk']);
  });
});
