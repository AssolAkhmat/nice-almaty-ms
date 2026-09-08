import { afterEach, describe, expect, it, vi } from 'vitest';

import { actionErrorKey } from './action-failure';
import { ConflictError, NotFoundError } from './errors';
import { logger } from './logger';

/**
 * Итог неудачного server action (инцидент I12).
 *
 * Ошибка сервисного слоя несёт ключ перевода сама и в журнал не идёт:
 * это отказ по правилам, а не сбой. Всё остальное — сбой, о котором экран
 * сказать не может, а журнал обязан: до I12 сборка договора на боевой
 * отвечала `contract.errors.unknown`, и причина не попадала никуда.
 */
describe('ключ ошибки для экрана', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ошибка сервисного слоя отдаёт свой ключ и в журнал не пишется', () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    expect(
      actionErrorKey(new ConflictError('contracts.alreadySigned'), 'contract.errors.unknown'),
    ).toBe('contracts.alreadySigned');
    expect(actionErrorKey(new NotFoundError(), 'contract.errors.unknown')).toBe('Не найдено');
    expect(error).not.toHaveBeenCalled();
  });

  it('любая другая ошибка отдаёт запасной ключ и попадает в журнал целиком', () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const cause = new Error('Для DEPLOY_TARGET=vercel нужен пакет @sparticuz/chromium');

    expect(actionErrorKey(cause, 'contract.errors.unknown')).toBe('contract.errors.unknown');

    expect(error).toHaveBeenCalledTimes(1);
    const [payload, message] = error.mock.calls[0] ?? [];
    expect(payload).toMatchObject({ err: cause, key: 'contract.errors.unknown' });
    expect(message).toContain('server action');
  });

  it('брошенное не-исключение тоже попадает в журнал', () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    expect(actionErrorKey('строка вместо ошибки', 'beds.errors.unknown')).toBe(
      'beds.errors.unknown',
    );
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toMatchObject({ err: 'строка вместо ошибки' });
  });
});
