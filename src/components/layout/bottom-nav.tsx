'use client';

import { AppLink } from '@/components/ui/app-link';
import { MoreHorizontal } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { cn } from '@/lib/cn';
import { isActiveHref, NAV_ITEMS, PRIMARY_NAV_ITEMS } from '@/lib/navigation';

const ITEM_CLASSES =
  'flex h-14 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] transition-colors duration-150';

export interface BottomNavProps {
  unread: number;
}

/** Мобильная навигация: четыре пункта и «Ещё» с полным списком. */
export function BottomNav({ unread }: BottomNavProps) {
  const t = useTranslations('nav');
  const tCommon = useTranslations('common');
  const pathname = usePathname();
  const [isMoreOpen, setMoreOpen] = useState(false);

  return (
    <>
      <nav
        aria-label={t('label')}
        className="border-border bg-surface sticky bottom-0 z-20 flex border-t md:hidden"
        data-testid="bottom-nav"
      >
        {PRIMARY_NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = isActiveHref(item.href, pathname);

          return (
            <AppLink
              aria-current={isActive ? 'page' : undefined}
              className={cn(ITEM_CLASSES, isActive ? 'text-primary' : 'text-text-muted')}
              href={item.href}
              key={item.key}
            >
              <Icon aria-hidden="true" size={20} strokeWidth={1.5} />
              <span className="max-w-full truncate">{t(item.key)}</span>
            </AppLink>
          );
        })}

        <button
          className={cn(ITEM_CLASSES, 'text-text-muted')}
          data-testid="nav-more"
          onClick={() => {
            setMoreOpen(true);
          }}
          type="button"
        >
          <MoreHorizontal aria-hidden="true" size={20} strokeWidth={1.5} />
          <span>{tCommon('more')}</span>
        </button>
      </nav>

      <Modal onOpenChange={setMoreOpen} open={isMoreOpen} title={tCommon('menu')}>
        <ul className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = isActiveHref(item.href, pathname);

            return (
              <li key={item.key}>
                <AppLink
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'rounded-control flex h-11 items-center gap-3 px-3 text-[15px]',
                    isActive ? 'bg-primary/10 text-primary font-medium' : 'text-text',
                  )}
                  href={item.href}
                  onClick={() => {
                    setMoreOpen(false);
                  }}
                >
                  <Icon aria-hidden="true" size={20} strokeWidth={1.5} />
                  {t(item.key)}
                  {item.key === 'notifications' && unread > 0 && (
                    <Badge className="ml-auto" data-testid="unread-badge-mobile" tone="accent">
                      {unread}
                    </Badge>
                  )}
                </AppLink>
              </li>
            );
          })}
        </ul>
      </Modal>
    </>
  );
}
