'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Field, Input } from '@/components/ui/input';

/**
 * Загрузка чека к объекту дома: ущерб, расход, строка коммуналки (T3.12).
 *
 * Двухшаговая, как и загрузка документов (D4): сначала сессия — права, тип
 * и размер проверяются до того, как байты куда-либо пойдут, — потом сами
 * байты. Идентификатор готового файла кладётся в скрытое поле формы,
 * поэтому обычная отправка формы работает без изменений.
 */
export interface ReceiptUploadProps {
  /** Дом, которому принадлежит чек; `null` — файл уровня сети. */
  houseId: string | null;
  /** `damage-receipt`, `expense-receipt`, `utility-receipt`. */
  purpose: string;
  /** Имя скрытого поля, в которое ляжет идентификатор файла. */
  name: string;
  id: string;
}

interface SessionResponse {
  file_id: string;
  upload: { url: string; method: 'PUT' | 'POST'; headers: Record<string, string> };
  error?: { message?: string };
}

async function uploadReceipt(houseId: string | null, purpose: string, file: File): Promise<string> {
  const session = await fetch('/api/v1/files/upload-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      house_id: houseId,
      purpose,
      mime: file.type,
      size_bytes: file.size,
      original_name: file.name,
    }),
  });

  const target = (await session.json()) as SessionResponse;

  if (!session.ok) {
    throw new Error(target.error?.message ?? 'files.errors.upload');
  }

  const sent = await fetch(target.upload.url, {
    method: target.upload.method,
    headers: { ...target.upload.headers, 'content-type': file.type },
    body: file,
  });

  if (!sent.ok) {
    throw new Error('files.errors.upload');
  }

  const completed = await fetch(`/api/v1/files/${target.file_id}/complete`, { method: 'POST' });

  if (!completed.ok) {
    const body = (await completed.json()) as SessionResponse;
    throw new Error(body.error?.message ?? 'files.errors.upload');
  }

  return target.file_id;
}

export function ReceiptUpload({ houseId, id, name, purpose }: ReceiptUploadProps) {
  const t = useTranslations();
  const [fileId, setFileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setUploading] = useState(false);

  return (
    <Field
      hint={fileId === null ? t('files.receiptHint') : t('files.receiptReady')}
      htmlFor={id}
      label={t('files.receipt')}
    >
      <input name={name} type="hidden" value={fileId ?? ''} />

      <Input
        accept="image/jpeg,image/png,image/webp,application/pdf"
        data-testid={id}
        disabled={isUploading}
        id={id}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file === undefined) {
            return;
          }

          setError(null);
          setUploading(true);

          void uploadReceipt(houseId, purpose, file)
            .then((uploaded) => {
              setFileId(uploaded);
            })
            .catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : 'files.errors.upload');
            })
            .finally(() => {
              setUploading(false);
            });
        }}
        type="file"
      />

      {error !== null && (
        <p className="text-danger text-[13px]" role="alert">
          {t(error)}
        </p>
      )}
    </Field>
  );
}
