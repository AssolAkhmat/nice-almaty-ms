import { describe, expect, it } from 'vitest';

import type { AccessContext, AccessRole } from '@/db/access';

import { assertCan, can, scopeOf } from './authz';
import { ForbiddenError, NotFoundError } from './errors';
import {
  ACTIONS,
  PERMISSIONS,
  type Action,
  type PermissionMatrix,
  type PermissionScope,
} from './permissions';

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

/**
 * Файлы всегда приватны (docs/01-ARCHITECTURE.md): публичных ссылок нет,
 * а отдача содержимого проходит ту же проверку, что и любое другое чтение.
 * Цель действия — жилец, которому файл принадлежит, и его дом.
 */
describe('файлы', () => {
  const foreignResident = { houseId: HOUSE_B, userId: 'u-someone-else' };

  it('жилец работает только со своими файлами', () => {
    expect(can(resident, 'file.upload', { userId: resident.userId, houseId: HOUSE_A })).toBe(true);
    expect(can(resident, 'file.read', { userId: resident.userId, houseId: HOUSE_A })).toBe(true);
  });

  it('чужой файл для жильца — 404, а не 403', () => {
    for (const action of ['file.upload', 'file.read'] as const) {
      expect(() => {
        assertCan(resident, action, foreignResident);
      }).toThrow(NotFoundError);
    }
  });

  it('админ работает с файлами своего дома и не видит чужой', () => {
    expect(can(admin, 'file.read', { houseId: HOUSE_A, userId: 'u-resident' })).toBe(true);

    expect(() => {
      assertCan(admin, 'file.read', foreignResident);
    }).toThrow(NotFoundError);
  });

  it('суперадмин видит файлы любого дома сети', () => {
    expect(can(superadmin, 'file.read', foreignResident)).toBe(true);
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

/**
 * Ущерб (§8). Заводит его админ своего дома — он же видит поломку;
 * сторнирует только суперадмин: обратная проводка возвращает деньги
 * на депозиты, и такое решение не должно приниматься на месте.
 */
describe('ущерб', () => {
  it('заводит админ своего дома, сторнирует только суперадмин', () => {
    expect(scopeOf('admin', 'damage.read')).toBe('house');
    expect(scopeOf('admin', 'damage.create')).toBe('house');
    expect(scopeOf('admin', 'damage.reverse')).toBe('none');

    expect(scopeOf('superadmin', 'damage.reverse')).toBe('org');
  });

  it('жилец списания видит движением депозита, а не списком ущербов', () => {
    expect(scopeOf('resident', 'damage.read')).toBe('none');
    expect(scopeOf('resident', 'damage.create')).toBe('none');
  });
});

/**
 * Инвариант ролей: суперадмин не слабее админа ни в одном действии.
 *
 * До 20 сентября 2026 это свойство держалось на содержимом матрицы и не было
 * закрыто ничем: поставь кто-нибудь суперадмину область `house` хоть в одну
 * ячейку — и все вызовы вида `can(context, X, { houseId: context.houseId })`
 * начали бы молча отдавать 404, потому что у суперадмина дом равен null.
 * Ни один тест бы не покраснел.
 *
 * Правило доказанного запрета (CLAUDE.md §2): рядом с проверкой живой матрицы
 * стоит та же проверка на нарочно сломанной — она доказывает, что проверка
 * вообще способна покраснеть.
 */
const SCOPE_WIDTH: Record<PermissionScope, number> = { none: 0, self: 1, house: 2, org: 3 };

/** Действия, где область роли `role` уже, чем у роли `than`. */
function narrowerActions(matrix: PermissionMatrix, role: AccessRole, than: AccessRole): Action[] {
  return ACTIONS.filter(
    (action) => SCOPE_WIDTH[matrix[role][action]] < SCOPE_WIDTH[matrix[than][action]],
  );
}

/**
 * Действия с областью `house` у роли, у которой дома нет.
 *
 * Сравнение по ширине этот случай не ловит: `house` у суперадмина и `house`
 * у админа одинаково широки на бумаге. На деле у суперадмина `houseId` равен
 * `null`, а вызовы по всему приложению идут в форме
 * `can(context, X, { houseId: context.houseId })` — и такая ячейка означает
 * молчаливый 404 вместо доступа.
 */
function houseScopedActions(matrix: PermissionMatrix, role: AccessRole): Action[] {
  return ACTIONS.filter((action) => matrix[role][action] === 'house');
}

/** Матрица с одной нарочно испорченной ячейкой. */
function withScope(
  matrix: PermissionMatrix,
  role: AccessRole,
  action: Action,
  scope: PermissionScope,
): PermissionMatrix {
  return { ...matrix, [role]: { ...matrix[role], [action]: scope } };
}

describe('суперадмин не слабее админа', () => {
  it('ни в одном действии матрицы', () => {
    expect(narrowerActions(PERMISSIONS, 'superadmin', 'admin')).toEqual([]);
  });

  it('у суперадмина нет ни одной области house: дома у него нет', () => {
    expect(houseScopedActions(PERMISSIONS, 'superadmin')).toEqual([]);
  });

  it('проверка краснеет, если суперадмину поставить область house', () => {
    const broken = withScope(PERMISSIONS, 'superadmin', 'bed.read', 'house');

    expect(houseScopedActions(broken, 'superadmin')).toEqual(['bed.read']);
  });

  it('и такая ячейка действительно закрывает суперадмину доступ', () => {
    // Ровно тот вызов, который стоит на экранах: дом берётся из контекста.
    expect(can(superadmin, 'bed.read', { houseId: superadmin.houseId })).toBe(true);

    const scope = withScope(PERMISSIONS, 'superadmin', 'bed.read', 'house').superadmin['bed.read'];

    expect(scope).toBe('house');
    expect(superadmin.houseId).toBeNull();
  });

  it('проверка краснеет и на запрете там, где админу разрешено', () => {
    const broken = withScope(PERMISSIONS, 'superadmin', 'damage.create', 'none');

    expect(narrowerActions(broken, 'superadmin', 'admin')).toEqual(['damage.create']);
  });

  it('расширение области суперадмина нарушением не считается', () => {
    const wider = withScope(PERMISSIONS, 'admin', 'bed.read', 'self');

    expect(narrowerActions(wider, 'superadmin', 'admin')).toEqual([]);
  });
});

/**
 * Токен API, выданный на один дом, сужает область и суперадмину.
 *
 * Обещание «дом токена сужает область» стояло комментарием в
 * `src/lib/api/token-auth.ts` с фазы 7 и для суперадмина не выполнялось:
 * `visibleHouseIds` отдавал ему `all` независимо от дома в контексте,
 * а область `org` в `can` не смотрела на цель вовсе. Токен на один дом
 * действовал на всю сеть.
 *
 * Правило доказанного запрета (CLAUDE.md §2): ниже не только проверка
 * запрета, но и проверка того, что при снятом сужении он бы не сработал.
 */
const tokenSuperadmin: AccessContext = {
  orgId: ORG,
  userId: 'u-super',
  role: 'superadmin',
  houseId: HOUSE_A,
};

describe('токен суперадмина на один дом', () => {
  it('в своём доме действует', () => {
    expect(can(tokenSuperadmin, 'bed.read', { houseId: HOUSE_A })).toBe(true);
    expect(can(tokenSuperadmin, 'rotation.score', { houseId: HOUSE_A })).toBe(true);
  });

  it('в чужой дом не попадает', () => {
    expect(can(tokenSuperadmin, 'bed.read', { houseId: HOUSE_B })).toBe(false);
    expect(can(tokenSuperadmin, 'rotation.score', { houseId: HOUSE_B })).toBe(false);
  });

  it('чужой дом отвечает 404, а не 403: состав сети перебором не узнать', () => {
    expect(() => {
      assertCan(tokenSuperadmin, 'bed.read', { houseId: HOUSE_B });
    }).toThrow(NotFoundError);
  });

  it('сетевые цели без дома остаются доступны', () => {
    expect(can(tokenSuperadmin, 'settings.org.read', {})).toBe(true);
  });

  it('обычный суперадмин без дома по-прежнему видит всю сеть', () => {
    expect(can(superadmin, 'bed.read', { houseId: HOUSE_A })).toBe(true);
    expect(can(superadmin, 'bed.read', { houseId: HOUSE_B })).toBe(true);
  });

  /*
   * Негативная фикстура на само сужение: если бы область `org` возвращала
   * `true`, не глядя на цель, — а именно так было до 20 сентября 2026, —
   * чужой дом оказался бы доступен. Проверка ниже повторяет прежнее
   * поведение и показывает, чем оно отличается от нынешнего.
   */
  it('снятое сужение вернуло бы доступ в чужой дом', () => {
    const withoutNarrowing = (context: AccessContext, action: Action): boolean =>
      scopeOf(context.role, action) === 'org';

    expect(withoutNarrowing(tokenSuperadmin, 'bed.read')).toBe(true);
    expect(can(tokenSuperadmin, 'bed.read', { houseId: HOUSE_B })).toBe(false);
  });
});
