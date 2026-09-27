import type { NavItem } from '@/lib/navigation';

/**
 * Оставить в меню только разделы, положенные этой роли (находка P0-2,
 * 27 сентября 2026).
 *
 * Список считается на сервере правами (`visibleNavItems`) и приходит сюда
 * адресами. Пусто — показываются все: так компонент остаётся пригодным там,
 * где сессии нет вовсе, и не делает вид, что знает права.
 *
 * Фильтр здесь, а не в каждом меню: две копии одного правила разошлись бы,
 * а прятать пункт стилями нельзя — скрытый пункт всё равно в разметке.
 */
export function visibleItems(
  items: readonly NavItem[],
  sections: readonly string[] | undefined,
): readonly NavItem[] {
  if (sections === undefined) {
    return items;
  }

  const allowed = new Set(sections);

  return items.filter((item) => allowed.has(item.href));
}
