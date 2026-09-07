import { describe, expect, it } from 'vitest';

import { assertCronSecret } from './cron';
import { ForbiddenError, UnauthorizedError } from '../errors';

/**
 * Негативная фикстура к защите заданий планировщика
 * (docs/01-ARCHITECTURE.md, «Планировщик»).
 *
 * Задание выставляет счета всей сети и ходит по деньгам. Открытый эндпоинт
 * дал бы любому желающему запускать месячную генерацию когда угодно,
 * поэтому проверка секрета обязана срабатывать, а не только существовать.
 */
const SECRET = 'sekret-raspisaniya-16';

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://example.test/api/v1/cron/invoices-monthly', {
    method: 'POST',
    headers,
  });
}

describe('секрет расписания', () => {
  it('верный секрет пропускает задание', () => {
    expect(() => {
      assertCronSecret(request({ 'x-cron-secret': SECRET }), SECRET);
    }).not.toThrow();
  });

  it('без заголовка — 401: неизвестно, кто пришёл', () => {
    expect(() => {
      assertCronSecret(request(), SECRET);
    }).toThrow(UnauthorizedError);
  });

  it('пустой заголовок заголовком не считается', () => {
    expect(() => {
      assertCronSecret(request({ 'x-cron-secret': '' }), SECRET);
    }).toThrow(UnauthorizedError);
  });

  it('чужой секрет — 403: пришли, но не те', () => {
    expect(() => {
      assertCronSecret(request({ 'x-cron-secret': 'chuzhoy-sekret-1616' }), SECRET);
    }).toThrow(ForbiddenError);
  });

  it('совпавший префикс не пропускает: сравнение идёт целиком', () => {
    expect(() => {
      assertCronSecret(request({ 'x-cron-secret': SECRET.slice(0, -1) }), SECRET);
    }).toThrow(ForbiddenError);
  });

  it('секрет с добавленным хвостом тоже не подходит', () => {
    expect(() => {
      assertCronSecret(request({ 'x-cron-secret': `${SECRET}x` }), SECRET);
    }).toThrow(ForbiddenError);
  });
});
