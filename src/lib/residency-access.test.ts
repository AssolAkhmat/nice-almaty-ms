import { describe, expect, it } from 'vitest';

import { isAllowedDuringOnboarding } from './onboarding-access';

/**
 * Блокировка модулей до оплаты депозита (§1.2).
 *
 * Правило проверяется с обеих сторон: и что открыто нужное, и что закрыто
 * остальное. Список закрытых путей — не выдумка теста, а перечень разделов
 * из `src/lib/navigation.ts`.
 */
describe('до оплаты депозита открыты только заявленные разделы', () => {
  it('дэшборд открыт: на нём живёт сам мастер', () => {
    expect(isAllowedDuringOnboarding('/')).toBe(true);
  });

  it('профиль, документы и счета открыты', () => {
    expect(isAllowedDuringOnboarding('/profile')).toBe(true);
    expect(isAllowedDuringOnboarding('/documents')).toBe(true);
    expect(isAllowedDuringOnboarding('/invoices')).toBe(true);
  });

  it('договор и депозит открыты: без них шаги 5 и 8 не закрыть', () => {
    expect(isAllowedDuringOnboarding('/contract')).toBe(true);
    expect(isAllowedDuringOnboarding('/deposit')).toBe(true);
  });

  it('личные настройки открыты: смена языка и темы блокировкой не ограничена', () => {
    expect(isAllowedDuringOnboarding('/settings/personal')).toBe(true);
  });
});

describe('остальные модули закрыты', () => {
  it('ротации, отсутствия и рейтинг недоступны', () => {
    expect(isAllowedDuringOnboarding('/rotations')).toBe(false);
    expect(isAllowedDuringOnboarding('/absences')).toBe(false);
    expect(isAllowedDuringOnboarding('/rating')).toBe(false);
  });

  it('места, коммуналка, ущерб, инвентарь и бухгалтерия недоступны', () => {
    for (const path of ['/beds', '/utilities', '/damages', '/inventory', '/accounting']) {
      expect(isAllowedDuringOnboarding(path)).toBe(false);
    }
  });

  it('общие настройки закрыты, хотя личные открыты', () => {
    expect(isAllowedDuringOnboarding('/settings')).toBe(false);
    expect(isAllowedDuringOnboarding('/settings/houses')).toBe(false);
  });

  it('вложенные пути закрытого раздела тоже закрыты', () => {
    expect(isAllowedDuringOnboarding('/rotations/2026-09-01')).toBe(false);
  });

  it('путь, начинающийся так же, но другой раздел, не открывается', () => {
    // `/documents-archive` — не `/documents`.
    expect(isAllowedDuringOnboarding('/documents-archive')).toBe(false);
  });
});
