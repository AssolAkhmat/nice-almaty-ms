import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ROUTE_ACCESS, accessOf, type RouteAccess } from './access-map';
import { renderAccessMatrix } from './access-matrix-doc';
import { can } from './authz';
import { NAV_ITEMS } from './navigation';

import type { AccessContext, AccessRole } from '@/db/access';

/**
 * Матрица «роут → роль» проверяется таблицей, а не по одному разделу
 * (находка P0-2, 27 сентября 2026).
 *
 * Админ дома видел раздел бухгалтерии: право `accounting.read` у него `none`,
 * но меню не спрашивало прав вовсе. Проверка ниже ловит обе стороны — и что
 * матрица говорит «нет», и что меню это «нет» слышит.
 *
 * Тест табличный намеренно: он падает не только на бухгалтерии, а на любой
 * паре, где фактическая проверка расходится с ТЗ. Роли в карте взяты
 * из `docs/00-PRD.md`.
 */
const ROLES: readonly AccessRole[] = ['resident', 'admin', 'superadmin'];

const HOUSE = '00000000-0000-0000-0000-0000000000aa';
const USER = '00000000-0000-0000-0000-0000000000bb';

function contextFor(role: AccessRole): AccessContext {
  return {
    orgId: '00000000-0000-0000-0000-0000000000cc',
    userId: USER,
    role,
    houseId: role === 'admin' ? HOUSE : null,
  };
}

/**
 * Как экран спрашивает право у себя. Раздел про свои данные спрашивает
 * «про меня» — у жильца область `self` и он проходит. Раздел про других
 * спрашивает только про дом: иначе `user.read` с областью `self` открыл бы
 * жильцу список жильцов дома.
 */
function targetFor(entry: RouteAccess, context: AccessContext) {
  return {
    ...(context.houseId === null ? {} : { houseId: context.houseId }),
    ...(entry.target === 'self' ? { userId: context.userId } : {}),
  };
}

function allowed(entry: RouteAccess, role: AccessRole): boolean {
  const context = contextFor(role);

  return entry.action === null ? true : can(context, entry.action, targetFor(entry, context));
}

/** Экраны приложения на диске: карта обязана знать про каждый. */
function appRoutes(): string[] {
  const root = join(process.cwd(), 'src', 'app', '(app)');
  const found: string[] = [];

  function walk(directory: string, prefix: string): void {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);

      if (statSync(path).isDirectory()) {
        walk(path, `${prefix}/${entry}`);
        continue;
      }

      if (entry === 'page.tsx') {
        found.push(prefix === '' ? '/' : prefix);
      }
    }
  }

  walk(root, '');

  return found.sort();
}

describe('карта доступа к экранам', () => {
  it.each(ROUTE_ACCESS.flatMap((entry) => ROLES.map((role) => ({ entry, role }))))(
    '$entry.route для $role',
    ({ entry, role }) => {
      const expected = entry.roles.includes(role);

      expect(
        allowed(entry, role),
        expected
          ? `${entry.route}: роль ${role} должна проходить (${entry.why})`
          : `${entry.route}: роль ${role} не должна проходить (${entry.why})`,
      ).toBe(expected);
    },
  );

  it('каждый экран приложения объявлен в карте', () => {
    const missing = appRoutes().filter((route) => accessOf(route) === undefined);

    expect(missing, 'экран без записи в карте доступа — это забытая проверка прав').toEqual([]);
  });

  it('в карте нет записей о несуществующих экранах', () => {
    const routes = new Set(appRoutes());
    const stale = ROUTE_ACCESS.filter((entry) => !routes.has(entry.route)).map(
      (entry) => entry.route,
    );

    expect(stale).toEqual([]);
  });

  it('каждый пункт меню объявлен в карте', () => {
    const missing = NAV_ITEMS.filter((item) => accessOf(item.href) === undefined).map(
      (item) => item.href,
    );

    expect(missing).toEqual([]);
  });

  it('таблица в документации собрана из карты и не разошлась с ней', () => {
    /*
     * Документ генерируется `pnpm access:matrix`. Проверка держит его свежим:
     * таблица прав, набранная руками отдельно от кода, врёт убедительнее,
     * чем отсутствие таблицы.
     */
    const onDisk = readFileSync(join(process.cwd(), 'docs', '09-ACCESS-MATRIX.md'), 'utf8');

    expect(onDisk, 'запустите `pnpm access:matrix`').toBe(renderAccessMatrix());
  });

  it('раздел бухгалтерии закрыт админу дома и жильцу', () => {
    /*
     * Та самая находка, названная отдельно: таблица выше поймала бы её
     * и без этой проверки, но названная строка объясняет, что случилось
     * на боевой 27 сентября.
     */
    const accounting = accessOf('/accounting');

    expect(accounting?.roles).toEqual(['superadmin']);
    expect(allowed(accounting as RouteAccess, 'admin')).toBe(false);
    expect(allowed(accounting as RouteAccess, 'resident')).toBe(false);
  });
});
