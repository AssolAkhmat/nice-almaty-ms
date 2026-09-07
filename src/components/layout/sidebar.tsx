'use client';

import { AppLink } from '@/components/ui/app-link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import { isActiveHref, NAV_ITEMS } from '@/lib/navigation';

/**
 * Десктоп (>= 1024): постоянное меню 240px с подписями.
 * Планшет (768-1023): те же пункты, свёрнутые в иконки.
 * Мобильный (< 768): меню скрыто, работает нижняя навигация.
 */
export interface SidebarProps {
  /** Непрочитанные уведомления: число рядом с пунктом, а не сам список. */
  unread: number;
}

export function Sidebar({ unread }: SidebarProps) {
  const t = useTranslations('nav');
  const pathname = usePathname();

  return (
    <nav
      aria-label={t('label')}
      className="border-border bg-surface hidden shrink-0 border-r md:block md:w-16 lg:w-60"
      data-testid="sidebar"
    >
      <ul className="flex flex-col gap-0.5 p-2">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = isActiveHref(item.href, pathname);

          return (
            <li key={item.key}>
              <AppLink
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'rounded-control flex h-11 items-center gap-3 px-3 text-[15px] transition-colors duration-150',
                  'md:justify-center lg:justify-start',
                  isActive
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-text-muted hover:bg-surface-2 hover:text-text',
                )}
                href={item.href}
                title={t(item.key)}
              >
                <Icon aria-hidden="true" className="shrink-0" size={20} strokeWidth={1.5} />
                <span className="hidden lg:inline">{t(item.key)}</span>
                {item.key === 'notifications' && unread > 0 && (
                  <Badge className="ml-auto" data-testid="unread-badge" tone="accent">
                    {unread}
                  </Badge>
                )}
              </AppLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
