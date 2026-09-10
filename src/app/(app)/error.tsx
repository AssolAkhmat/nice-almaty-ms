'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Падение серверного компонента раздела (docs/tasks/MAINTENANCE.md, T9.13).
 *
 * До этой страницы человек видел стандартный экран Next без единой зацепки
 * для разбора. Сюда приходит `digest` — тот же, что Next кладёт в журнал
 * сервера, а `instrumentation.ts` — в наш; по нему сбой находится в журнале
 * так же, как server action — по `request_id`.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('app.error');

  return (
    <section className="flex flex-col gap-6">
      <h1>{t('title')}</h1>

      <Card data-testid="app-error">
        <CardHeader>
          <CardTitle>{t('subtitle')}</CardTitle>
        </CardHeader>

        <p className="text-text-muted text-[13px]">{t('hint')}</p>

        {error.digest !== undefined && (
          <p className="tabular mt-2 text-[13px]" data-testid="app-error-digest">
            {t('digest', { digest: error.digest })}
          </p>
        )}

        <Button className="mt-4" onClick={reset} size="sm" type="button">
          {t('retry')}
        </Button>
      </Card>
    </section>
  );
}
