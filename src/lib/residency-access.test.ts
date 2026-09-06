import { describe, expect, it } from 'vitest';

import { accessScopeOf, isPathAllowed } from './residency-access';

/**
 * Блокировка модулей до оплаты депозита (§1.2) и после расторжения (§2.3 п.2).
 *
 * Правило проверяется с обеих сторон: и что открыто нужное, и что закрыто
 * остальное. Список закрытых путей — не выдумка теста, а перечень разделов
 * из `src/lib/navigation.ts`.
 */
describe('область доступа по статусу проживания', () => {
  it('заселённый жилец не ограничен', () => {
    expect(accessScopeOf('active')).toBe('full');
  });

  it('до оплаты депозита — область заселения, в любом из ранних статусов', () => {
    for (const status of [
      'created',
      'profile_pending',
      'docs_pending',
      'deposit_pending',
    ] as const) {
      expect(accessScopeOf(status)).toBe('onboarding');
    }
  });

  it('расторжение и архив — область выселения', () => {
    expect(accessScopeOf('terminating')).toBe('termination');
    expect(accessScopeOf('archived')).toBe('termination');
  });

  it('без проживания вовсе действует блокировка заселения', () => {
    expect(accessScopeOf(null)).toBe('onboarding');
  });
});

describe('до оплаты депозита открыты только заявленные разделы', () => {
  it('дэшборд открыт: на нём живёт сам мастер', () => {
    expect(isPathAllowed('onboarding', '/')).toBe(true);
  });

  it('профиль, документы и счета открыты', () => {
    expect(isPathAllowed('onboarding', '/profile')).toBe(true);
    expect(isPathAllowed('onboarding', '/documents')).toBe(true);
    expect(isPathAllowed('onboarding', '/invoices')).toBe(true);
  });

  it('договор и депозит открыты: без них шаги 5 и 8 не закрыть', () => {
    expect(isPathAllowed('onboarding', '/contract')).toBe(true);
    expect(isPathAllowed('onboarding', '/deposit')).toBe(true);
  });

  it('личные настройки открыты: смена языка и темы блокировкой не ограничена', () => {
    expect(isPathAllowed('onboarding', '/settings/personal')).toBe(true);
  });
});

describe('остальные модули закрыты', () => {
  it('ротации, отсутствия и рейтинг недоступны', () => {
    expect(isPathAllowed('onboarding', '/rotations')).toBe(false);
    expect(isPathAllowed('onboarding', '/absences')).toBe(false);
    expect(isPathAllowed('onboarding', '/rating')).toBe(false);
  });

  it('места, коммуналка, ущерб, инвентарь и бухгалтерия недоступны', () => {
    for (const path of ['/beds', '/utilities', '/damages', '/inventory', '/accounting']) {
      expect(isPathAllowed('onboarding', path)).toBe(false);
    }
  });

  it('общие настройки закрыты, хотя личные открыты', () => {
    expect(isPathAllowed('onboarding', '/settings')).toBe(false);
    expect(isPathAllowed('onboarding', '/settings/houses')).toBe(false);
  });

  it('вложенные пути закрытого раздела тоже закрыты', () => {
    expect(isPathAllowed('onboarding', '/rotations/2026-09-01')).toBe(false);
  });

  it('путь, начинающийся так же, но другой раздел, не открывается', () => {
    // `/documents-archive` — не `/documents`.
    expect(isPathAllowed('onboarding', '/documents-archive')).toBe(false);
  });
});

describe('после расторжения остаются только профиль и депозит (§2.3 п.2)', () => {
  it('профиль и депозит открыты', () => {
    expect(isPathAllowed('termination', '/profile')).toBe(true);
    expect(isPathAllowed('termination', '/deposit')).toBe(true);
  });

  it('дэшборд и личные настройки открыты: вход сохраняется', () => {
    expect(isPathAllowed('termination', '/')).toBe(true);
    expect(isPathAllowed('termination', '/settings/personal')).toBe(true);
  });

  it('документы, договор и счета закрываются вместе с остальным', () => {
    expect(isPathAllowed('termination', '/documents')).toBe(false);
    expect(isPathAllowed('termination', '/contract')).toBe(false);
    expect(isPathAllowed('termination', '/invoices')).toBe(false);
  });

  it('ротации, отсутствия и рейтинг закрыты и здесь', () => {
    for (const path of ['/rotations', '/absences', '/rating', '/beds']) {
      expect(isPathAllowed('termination', path)).toBe(false);
    }
  });
});
