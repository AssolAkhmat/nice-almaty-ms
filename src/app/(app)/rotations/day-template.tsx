'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { buildDayTemplate, type TemplateEntry } from '@/domain/rotation-template';

import type { BusinessDate } from '@/lib/time';

/**
 * Текст дня для группы (§6.7): шапка, дата, зоны с исполнителями, футер.
 *
 * Собирается тем же расчётным ядром, что и на сервере: второй сборщик
 * разошёлся бы с первым, и человек копировал бы не то, что видит (P3-8).
 * Формат plain text — текст уходит в мессенджер, где разметки нет.
 */
export function DayTemplate({
  date,
  entries,
  footer,
  header,
}: {
  date: string;
  entries: readonly TemplateEntry[];
  footer: string;
  header: string;
}) {
  const t = useTranslations('rotationTemplates');
  const [copied, setCopied] = useState(false);

  const text = buildDayTemplate({
    header,
    footer,
    date: date as BusinessDate,
    entries,
    labels: { empty: t('empty'), unassigned: t('unassigned') },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('templateTitle')}</CardTitle>
      </CardHeader>

      <div className="flex flex-col gap-3">
        <Textarea
          className="font-mono"
          data-testid="day-template-text"
          readOnly
          rows={Math.min(12, text.split('\n').length + 1)}
          value={text}
        />

        <div className="flex items-center gap-3">
          <Button
            data-testid="day-template-copy"
            onClick={() => {
              void navigator.clipboard.writeText(text).then(() => {
                setCopied(true);
              });
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            {t('copy')}
          </Button>

          {copied && (
            <span className="text-success text-[13px]" data-testid="day-template-copied">
              {t('copied')}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}
