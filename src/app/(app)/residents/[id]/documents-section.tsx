import { getLocale, getTranslations } from 'next-intl/server';

import { FileLinks } from '@/components/files/file-links';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';

import type { DocumentCard } from '@/services/documents';

/**
 * Документы жильца в карточке (модуль 1; указание владельца,
 * 25 сентября 2026).
 *
 * Прежде из карточки вела ссылка на общий экран «Документы», и открывалась
 * там очередь всего дома: перейти к документам конкретного жильца было
 * нельзя. Здесь видно и уже проверенное — со сроком, причиной отказа
 * и ссылкой на просмотр.
 *
 * Решения по документу принимаются в очереди проверки: кнопки «Принять»
 * и «Отклонить» живут там, и двух мест для одного решения быть не должно.
 */
const TONES: Readonly<Record<string, BadgeTone>> = {
  missing: 'neutral',
  uploaded: 'info',
  approved: 'success',
  rejected: 'danger',
};

function localizedName(card: DocumentCard, locale: string): string {
  const names = card.type.nameI18n as Record<string, string> | null;

  return names?.[locale] ?? names?.ru ?? card.type.code;
}

export async function DocumentsSection({ cards }: { cards: readonly DocumentCard[] }) {
  const t = await getTranslations();
  const locale = await getLocale();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('documents.title')}</CardTitle>
      </CardHeader>

      <div className="flex flex-col gap-2 p-4 pt-0 text-[13px]">
        {cards.length === 0 ? (
          <p className="text-text-muted">{t('documents.noDocumentTypes')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {cards.map((card) => {
              const status = card.document?.status ?? 'missing';

              return (
                <li
                  className="flex flex-wrap items-center justify-between gap-3"
                  key={card.type.id}
                >
                  <span className="flex items-center gap-2">
                    {localizedName(card, locale)}
                    <Badge tone={TONES[status] ?? 'neutral'}>
                      {t(`documents.status.${status}`)}
                    </Badge>
                    {card.document?.validUntil != null && (
                      <span className="text-text-muted">
                        {t('documents.validUntil', {
                          date: card.document.validUntil.split('-').reverse().join('.'),
                        })}
                      </span>
                    )}
                  </span>

                  <span className="flex items-center gap-3">
                    {card.document?.rejectReason != null && (
                      <span className="text-danger">{card.document.rejectReason}</span>
                    )}
                    {card.document?.fileId != null && (
                      <FileLinks fileId={card.document.fileId} label={t('documents.openFile')} />
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
