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

export const PRIMARY_NAV_ITEMS = NAV_ITEMS.filter((item) => item.primary === true);

/** Активен раздел, чей путь совпадает или является префиксом текущего. */
export function isActiveHref(href: string, pathname: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}
