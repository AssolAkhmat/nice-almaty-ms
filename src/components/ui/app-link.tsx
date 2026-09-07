import Link from 'next/link';

/**
 * Ссылка приложения.
 *
 * Предзагрузка выключена по умолчанию. `Link` из Next заранее забирает
 * страницу и кладёт ответ в кеш маршрутизатора; после действия на такой
 * странице экран показывает снимок, снятый до правки, — и ни `revalidatePath`,
 * ни `router.refresh()` его не сменяют. Все экраны здесь `force-dynamic`,
 * и выигрыш предзагрузки не стоит показа устаревших данных.
 *
 * Явное `prefetch` остаётся возможным: если экран только читают, его можно
 * вернуть осознанно.
 */
export function AppLink({
  prefetch = false,
  ...props
}: React.ComponentProps<typeof Link>): React.ReactElement {
  return <Link prefetch={prefetch} {...props} />;
}
