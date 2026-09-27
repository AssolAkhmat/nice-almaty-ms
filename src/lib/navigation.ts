import {
  BedDouble,
  Bell,
  CalendarDays,
  CalendarX,
  FileCheck,
  FileSignature,
  Gauge,
  PiggyBank,
  Hammer,
  Landmark,
  LayoutDashboard,
  Package,
  Receipt,
  Settings,
  TrendingUp,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { accessOf } from './access-map';
import { can } from './authz';

import type { AccessContext } from '@/db/access';
import type { Route } from 'next';

export interface NavItem {
  /** Ключ в разделе `nav` файлов локализации. */
  key: string;
  href: Route;
  icon: LucideIcon;
  /**
   * Попадает в нижнюю навигацию на мобильном (четыре пункта + «Ещё»).
   * Набор задан по дэшборду жильца из docs/04-MODULES/09-dashboards.md;
   * с появлением ролей в фазе 1 он станет зависеть от роли.
   */
  primary?: boolean;
}

/** Разделы соответствуют одиннадцати модулям из docs/04-MODULES. */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'dashboard', href: '/', icon: LayoutDashboard, primary: true },
  { key: 'rotations', href: '/rotations', icon: CalendarDays, primary: true },
  { key: 'invoices', href: '/invoices', icon: Receipt, primary: true },
  { key: 'absences', href: '/absences', icon: CalendarX, primary: true },
  { key: 'notifications', href: '/notifications', icon: Bell },
  { key: 'contract', href: '/contract', icon: FileSignature },
  { key: 'deposit', href: '/deposit', icon: PiggyBank },
  { key: 'documents', href: '/documents', icon: FileCheck },
  { key: 'residents', href: '/residents', icon: Users },
  { key: 'beds', href: '/beds', icon: BedDouble },
  { key: 'utilities', href: '/utilities', icon: Gauge },
  { key: 'damages', href: '/damages', icon: Hammer },
  { key: 'rating', href: '/rating', icon: TrendingUp },
  { key: 'accounting', href: '/accounting', icon: Landmark },
  { key: 'inventory', href: '/inventory', icon: Package },
  { key: 'settings', href: '/settings', icon: Settings },
];

/**
 * Разделы, которые видит эта роль (находка P0-2, 27 сентября 2026).
 *
 * До этого список был один на всех, и админ дома видел в меню бухгалтерию —
 * роут отказывал, а пункт показывался. Право берётся из `src/lib/access-map.ts`,
 * проверяет его единственная точка `can`: в компонентах проверок роли нет
 * и быть не должно (CLAUDE.md §3).
 */
export function visibleNavItems(context: AccessContext): readonly NavItem[] {
  return NAV_ITEMS.filter((item) => {
    const access = accessOf(item.href);

    if (access === undefined || access.action === null) {
      return true;
    }

    return can(context, access.action, {
      ...(context.houseId === null ? {} : { houseId: context.houseId }),
      ...(access.target === 'self' ? { userId: context.userId } : {}),
    });
  });
}

export const PRIMARY_NAV_ITEMS = NAV_ITEMS.filter((item) => item.primary === true);

/** Активен раздел, чей путь совпадает или является префиксом текущего. */
export function isActiveHref(href: string, pathname: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}
