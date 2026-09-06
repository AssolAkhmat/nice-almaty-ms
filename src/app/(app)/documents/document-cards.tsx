'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { parseBusinessDate, startOfDayUtc } from '@/lib/time';

import { submitDocumentAction, type DocumentActionState } from './actions';

/** Карточка типа документа в том виде, в каком её показывает страница. */
export interface DocumentCardView {
  typeId: string;
  code: string;
  name: string;
  requiresIssueDate: boolean;
  status: 'missing' | 'uploaded' | 'approved' | 'rejected';
  validity: 'permanent' | 'valid' | 'expiring' | 'expired' | null;
  validUntil: string | null;
  daysLeft: number | null;
  rejectReason: string | null;
  fileId: string | null;
}

const INITIAL: DocumentActionState = {};

const TONES: Readonly<Record<DocumentCardView['status'], BadgeTone>> = {
  missing: 'neutral',
  uploaded: 'info',
  approved: 'success',
  rejected: 'danger',
};

interface UploadSessionResponse {
  file_id: string;
  upload: { url: string; method: 'PUT' | 'POST'; headers: Record<string, string> };
}

/**
 * Загрузка идёт двумя шагами через `/api/v1/files/*` (D4): сессия, затем байты
 * прямо в хранилище, затем подтверждение. Ни один байт не проходит через
 * server action — на Vercel он бы туда и не поместился.
 */
async function uploadFile(residencyId: string, documentType: string, file: File): Promise<string> {
  const session = await fetch('/api/v1/files/upload-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      residency_id: residencyId,
      document_type: documentType,
      mime: file.type,
      size_bytes: file.size,
      original_name: file.name,
    }),
  });

  if (!session.ok) {
    const body = (await session.json()) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? 'documents.errors.upload');
  }

  const target = (await session.json()) as UploadSessionResponse;

  const sent = await fetch(target.upload.url, {
    method: target.upload.method,
    headers: { ...target.upload.headers, 'content-type': file.type },
    body: file,
  });

  if (!sent.ok) {
    throw new Error('documents.errors.upload');
  }

  const completed = await fetch(`/api/v1/files/${target.file_id}/complete`, { method: 'POST' });
  if (!completed.ok) {
    const body = (await completed.json()) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? 'documents.errors.upload');
  }

  return target.file_id;
}

function DocumentCard({ card, residencyId }: { card: DocumentCardView; residencyId: string }) {
  const t = useTranslations();
  const format = useFormatter();
  const [state, action, isPending] = useActionState(submitDocumentAction, INITIAL);
  const [fileId, setFileId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setUploading] = useState(false);

  async function onFileChange(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (file === undefined) {
      return;
    }

    setUploadError(null);
    setUploading(true);

    try {
      setFileId(await uploadFile(residencyId, card.code, file));
    } catch (error) {
      setFileId(null);
      setUploadError(error instanceof Error ? error.message : 'documents.errors.upload');
    } finally {
      setUploading(false);
    }
  }

  const expiry =
    card.validUntil === null
      ? null
      : format.dateTime(startOfDayUtc(parseBusinessDate(card.validUntil)), {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{card.name}</CardTitle>
        <Badge tone={TONES[card.status]}>{t(`documents.status.${card.status}`)}</Badge>
      </CardHeader>

      <div className="flex flex-col gap-3 p-4 pt-0">
        {expiry !== null && (
          <p className="text-text-muted text-[13px]" data-testid="document-expiry">
            {card.validity === 'expired'
              ? t('documents.expiredOn', { date: expiry })
              : t('documents.validUntil', { date: expiry })}
            {card.validity === 'expiring' && card.daysLeft !== null
              ? ` · ${t('documents.daysLeft', { days: card.daysLeft })}`
              : ''}
          </p>
        )}

        {card.validity === 'permanent' && (
          <p className="text-text-muted text-[13px]">{t('documents.permanent')}</p>
        )}

        {card.rejectReason !== null && (
          <p className="text-danger text-[13px]" data-testid="document-reject-reason">
            {t('documents.rejectedBecause', { reason: card.rejectReason })}
          </p>
        )}

        <form action={action} className="flex flex-col gap-3">
          <input name="residencyId" type="hidden" value={residencyId} />
          <input name="documentTypeId" type="hidden" value={card.typeId} />
          <input name="fileId" type="hidden" value={fileId ?? ''} />

          <Field htmlFor={`file-${card.typeId}`} label={t('documents.file')}>
            <Input
              accept="image/jpeg,image/png,image/webp,application/pdf"
              id={`file-${card.typeId}`}
              onChange={(event) => {
                void onFileChange(event);
              }}
              type="file"
            />
          </Field>

          {card.requiresIssueDate && (
            <Field
              hint={t('documents.issueDateHint')}
              htmlFor={`issue-${card.typeId}`}
              label={t('documents.issueDate')}
            >
              <Input id={`issue-${card.typeId}`} name="issueDate" required type="date" />
            </Field>
          )}

          {uploadError !== null && (
            <p className="text-danger text-[13px]" role="alert">
              {t(uploadError)}
            </p>
          )}
          {state.error !== undefined && (
            <p className="text-danger text-[13px]" role="alert">
              {t(state.error)}
            </p>
          )}
          {state.done !== undefined && <p className="text-success text-[13px]">{t(state.done)}</p>}

          <Button disabled={fileId === null || isUploading || isPending} type="submit">
            {isUploading ? t('documents.uploading') : t('documents.send')}
          </Button>
        </form>
      </div>
    </Card>
  );
}

export function DocumentCards({
  cards,
  residencyId,
}: {
  cards: readonly DocumentCardView[];
  residencyId: string;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {cards.map((card) => (
        <DocumentCard card={card} key={card.typeId} residencyId={residencyId} />
      ))}
    </div>
  );
}
