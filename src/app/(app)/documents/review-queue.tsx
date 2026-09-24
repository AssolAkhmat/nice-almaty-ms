'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { FileLinks } from '@/components/files/file-links';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Field, Textarea } from '@/components/ui/input';
import { parseBusinessDate, parseInstant, startOfDayUtc } from '@/lib/time';

import { reviewDocumentAction, type DocumentActionState } from './actions';

/** Документ в очереди проверки: без содержимого, только то, что решает админ. */
export interface ReviewItemView {
  id: string;
  typeName: string;
  residentName: string;
  fileId: string;
  status: 'uploaded' | 'approved' | 'rejected';
  issueDate: string | null;
  validUntil: string | null;
  rejectReason: string | null;
  createdAt: string;
}

const INITIAL: DocumentActionState = {};

const TONES: Readonly<Record<ReviewItemView['status'], BadgeTone>> = {
  uploaded: 'info',
  approved: 'success',
  rejected: 'danger',
};

function ReviewItem({ item }: { item: ReviewItemView }) {
  const t = useTranslations();
  const format = useFormatter();
  const [state, action, isPending] = useActionState(reviewDocumentAction, INITIAL);
  const [isRejecting, setRejecting] = useState(false);

  return (
    <Card data-testid="review-item">
      <CardHeader>
        <CardTitle>{item.typeName}</CardTitle>
        <span className="flex items-center gap-2">
          <span className="text-text-muted text-[13px]">{item.residentName}</span>
          <Badge tone={TONES[item.status]}>{t(`documents.status.${item.status}`)}</Badge>
        </span>
      </CardHeader>

      <div className="flex flex-col gap-3 p-4 pt-0">
        <p className="text-text-muted text-[13px]">
          {t('documents.uploadedAt', {
            date: format.dateTime(parseInstant(item.createdAt), {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
            }),
          })}
        </p>

        {item.validUntil !== null && (
          <p className="text-text-muted text-[13px]">
            {t('documents.validUntil', {
              date: format.dateTime(startOfDayUtc(parseBusinessDate(item.validUntil)), {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
              }),
            })}
          </p>
        )}

        {item.rejectReason !== null && (
          <p className="text-danger text-[13px]">
            {t('documents.rejectedBecause', { reason: item.rejectReason })}
          </p>
        )}

        <FileLinks fileId={item.fileId} label={t('documents.openFile')} />

        {/*
          Проверенный документ остаётся видимым и открывается — прежде он
          исчезал с экрана навсегда, и вернуться к справке было нечем
          (указание владельца, 23 сентября 2026). Решение по нему уже принято,
          поэтому кнопок у него нет: пересмотр идёт пересдачей документа.
        */}
        {item.status !== 'uploaded' ? null : (
          <form action={action} className="flex flex-col gap-3">
            <input name="documentId" type="hidden" value={item.id} />

            {isRejecting && (
              <Field htmlFor={`reason-${item.id}`} label={t('documents.rejectReason')}>
                <Textarea id={`reason-${item.id}`} name="reason" required rows={2} />
              </Field>
            )}

            {state.error !== undefined && (
              <p className="text-danger text-[13px]" role="alert">
                {t(state.error)}
              </p>
            )}

            <div className="flex gap-2">
              {isRejecting ? (
                <>
                  <Button disabled={isPending} name="decision" type="submit" value="reject">
                    {t('documents.confirmReject')}
                  </Button>
                  <Button
                    onClick={() => {
                      setRejecting(false);
                    }}
                    type="button"
                    variant="ghost"
                  >
                    {t('common.close')}
                  </Button>
                </>
              ) : (
                <>
                  <Button disabled={isPending} name="decision" type="submit" value="approve">
                    {t('documents.approve')}
                  </Button>
                  <Button
                    onClick={() => {
                      setRejecting(true);
                    }}
                    type="button"
                    variant="secondary"
                  >
                    {t('documents.reject')}
                  </Button>
                </>
              )}
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

export function ReviewQueue({ items }: { items: readonly ReviewItemView[] }) {
  const t = useTranslations();

  if (items.length === 0) {
    return (
      <EmptyState description={t('documents.queueEmptyHint')} title={t('documents.queueEmpty')} />
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {items.map((item) => (
        <ReviewItem item={item} key={item.id} />
      ))}
    </div>
  );
}
