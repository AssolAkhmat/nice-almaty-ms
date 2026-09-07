'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Field, Input } from '@/components/ui/input';

/**
 * Фото к подтверждению ротации (§7): необязательное.
 *
 * Загрузка двухшаговая, как у документов и чеков (D4): сначала сессия —
 * права, тип и размер проверяются до того, как байты пойдут, — потом сами
 * байты. Владелец снимка — проживание исполнителя, поэтому он его и видит.
 */
interface SessionResponse {
  file_id: string;
  upload: { url: string; method: 'PUT' | 'POST'; headers: Record<string, string> };
  error?: { message?: string };
}

async function uploadPhoto(assignmentId: string, file: File): Promise<string> {
  const session = await fetch('/api/v1/files/upload-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assignment_id: assignmentId,
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

export function RotationPhotoUpload({ assignmentId, id }: { assignmentId: string; id: string }) {
  const t = useTranslations();
  const [fileId, setFileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setUploading] = useState(false);

  return (
    <Field
      hint={fileId === null ? t('files.photoHint') : t('files.photoReady')}
      htmlFor={id}
      label={t('files.photo')}
    >
      <input name="photoFileIds" type="hidden" value={fileId ?? ''} />

      <Input
        accept="image/jpeg,image/png,image/webp"
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

          void uploadPhoto(assignmentId, file)
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
