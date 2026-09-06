import { describe, expect, it } from 'vitest';

import type { AccessContext, AccessRole } from '@/db/access';

import { assertCan, can, scopeOf } from './authz';
import { ForbiddenError, NotFoundError } from './errors';
import { ACTIONS, PERMISSIONS, type Action } from './permissions';

const ORG = 'org-1';
const HOUSE_A = 'house-a';
const HOUSE_B = 'house-b';

const superadmin: AccessContext = {
  orgId: ORG,
  userId: 'u-super',
  role: 'superadmin',
  houseId: null,
};
const admin: AccessContext = { orgId: ORG, userId: 'u-admin', role: 'admin', houseId: HOUSE_A };
const resident: AccessContext = {
  orgId: ORG,
  userId: 'u-resident',
  role: 'resident',
  houseId: null,
};

const contexts: Record<AccessRole, AccessContext> = { superadmin, admin, resident };

/** Цель, заведомо попадающая в область видимости роли. */
function allowedTarget(context: AccessContext) {
  return { houseId: context.houseId ?? HOUSE_A, userId: context.userId };
}

describe('матрица прав', () => {
  it('покрывает все роли и все действия без дыр', () => {
    for (const role of Object.keys(PERMISSIONS) as AccessRole[]) {
      for (const action of ACTIONS) {
        expect(PERMISSIONS[role][action], `${role} × ${action}`).toBeDefined();
      }
    }
  });

  it('в матрице нет действий сверх объявленного перечня', () => {
    for (const role of Object.keys(PERMISSIONS) as AccessRole[]) {
      expect(Object.keys(PERMISSIONS[role]).sort()).toEqual([...ACTIONS].sort());
    }
  });

  it('scopeOf читает матрицу, а не собственную логику', () => {
    for (const role of Object.keys(PERMISSIONS) as AccessRole[]) {
      for (const action of ACTIONS) {
        expect(scopeOf(role, action)).toBe(PERMISSIONS[role][action]);
      }
    }
  });
});

/**
 * Тесты пишутся на запреты (P1-4): на каждую отрицательную ячейку матрицы —
 * отдельная проверка. Разрешения проверяются e2e-сценариями фазы.
 */
describe('запреты по матрице', () => {
  const denied: [AccessRole, Action][] = [];

  for (const role of Object.keys(PERMISSIONS) as AccessRole[]) {
    for (const action of ACTIONS) {
      if (PERMISSIONS[role][action] === 'none') {
        denied.push([role, action]);
      }
    }
  }

  it('отрицательных ячеек в матрице достаточно, чтобы тесты были осмысленны', () => {
    expect(denied.length).toBeGreaterThan(10);
  });

  for (const [role, action] of denied) {
    it(`${role} не может ${action}`, () => {
      const context = contexts[role];

      expect(can(context, action, allowedTarget(context))).toBe(false);
      expect(() => {
        assertCan(context, action, allowedTarget(context));
      }).toThrow(ForbiddenError);
    });
  }
});

describe('различие 403 и 404', () => {
  it('действие запрещено роли — это 403', () => {
    // Аудит админу не положен вовсе, объект тут ни при чём.
    expect(() => {
      assertCan(admin, 'audit.read');
    }).toThrow(ForbiddenError);
  });

  it('объект вне области видимости — это 404', () => {
    // Читать дома админ вправе, но чужой дом обязан быть неотличим от несуществующего.
    expect(() => {
      assertCan(admin, 'house.read', { houseId: HOUSE_B });
    }).toThrow(NotFoundError);
  });

  it('чужая запись пользователя для жильца — тоже 404', () => {
    expect(() => {
      assertCan(resident, 'user.read', { userId: 'u-someone-else' });
    }).toThrow(NotFoundError);
  });

  it('своя запись жильцу доступна', () => {
    expect(can(resident, 'user.read', { userId: resident.userId })).toBe(true);
  });

  it('суперадмину доступен любой дом своей сети', () => {
    expect(can(superadmin, 'house.read', { houseId: HOUSE_B })).toBe(true);
  });
});

describe('следствия правила «роль и проживание — разные сущности» (D11)', () => {
  it('админ без дома не видит ни одного дома', () => {
    const orphan: AccessContext = { ...admin, houseId: null };

    expect(can(orphan, 'house.read', { houseId: HOUSE_A })).toBe(false);
    expect(() => {
      assertCan(orphan, 'house.read', { houseId: HOUSE_A });
    }).toThrow(NotFoundError);
  });

  it('админ распоряжается настройками своего дома и не видит чужие', () => {
    expect(can(admin, 'settings.house.write', { houseId: HOUSE_A })).toBe(true);
    expect(() => {
      assertCan(admin, 'settings.house.write', { houseId: HOUSE_B });
    }).toThrow(NotFoundError);
  });

  it('смену пароля себе может каждый', () => {
    for (const context of [superadmin, admin, resident]) {
      expect(can(context, 'self.changePassword', { userId: context.userId })).toBe(true);
    }
  });

  it('сменить пароль другому через это действие нельзя', () => {
    expect(() => {
      assertCan(admin, 'self.changePassword', { userId: 'u-someone-else' });
    }).toThrow(NotFoundError);
  });
});

describe('цель действия', () => {
  it('действие уровня сети цели не требует', () => {
    expect(can(superadmin, 'house.create')).toBe(true);
  });

  it('действие уровня дома без указания дома не разрешается', () => {
    expect(can(admin, 'house.read')).toBe(false);
  });

  it('действие уровня записи без указания записи не разрешается', () => {
    expect(can(resident, 'user.read')).toBe(false);
  });
});
