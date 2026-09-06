import { useTranslations } from 'next-intl';

import { EmptyState } from '@/components/ui/empty-state';

/**
 * Заглушка раздела на время каркаса: сам модуль появляется в своей фазе
 * по docs/07-ROADMAP.md.
 */
export function ModuleStub({ navKey }: { navKey: string }) {
  const t = useTranslations('nav');
  const tCommon = useTranslations('common');

  return (
    <section className="flex flex-col gap-4">
      <h1>{t(navKey)}</h1>
      <EmptyState description={tCommon('moduleNotReadyHint')} title={tCommon('moduleNotReady')} />
    </section>
  );
}
