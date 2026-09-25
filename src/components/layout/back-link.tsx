'use client';

import { ChevronLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';

import { AppLink } from '@/components/ui/app-link';

/**
 * Возврат на уровень выше (отзыв жильца, 25 сентября 2026: «свайп на телефоне
 * срабатывает не всегда, в предпросмотре документа особенно»).
 *
 * Ссылка, а не `history.back()`: во-первых, она работает без JavaScript
 * и после перехода с внешней ссылки, когда истории нет вовсе; во-вторых,
 * ведёт туда, куда человек ожидает, а не туда, откуда он пришёл, — из карточки
 * жильца это список жильцов, даже если открыли её из поиска.
 *
 * Живёт в раскладке, а не на экранах: экраны добавляются, и забытая кнопка
 * на новом экране — вопрос времени, а не аккуратности.
 */
export function BackLink() {
  const t = useTranslations('common');
  const pathname = usePathname();

  const segments = pathname.split('/').filter((part) => part !== '');

  /* Верхний уровень: возвращаться некуда, кнопки нет. */
  if (segments.length < 2) {
    return null;
  }

  const parent = `/${segments.slice(0, -1).join('/')}`;

  return (
    <AppLink
      className="text-text-muted hover:text-text mb-3 inline-flex items-center gap-1 text-[13px]"
      data-testid="back-link"
      href={parent}
    >
      <ChevronLeft aria-hidden className="size-4" />
      {t('back')}
    </AppLink>
  );
}
