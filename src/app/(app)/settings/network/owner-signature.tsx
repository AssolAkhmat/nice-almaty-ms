'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useRef, useState } from 'react';

import { fileViewHref } from '@/components/files/file-links';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { SignaturePad } from '@/components/ui/signature-pad';

import { saveOwnerSignatureAction, type NetworkActionState } from './actions';

const INITIAL: NetworkActionState = {};

/**
 * Подпись исполнителя в договоре (указание владельца, 22 сентября 2026).
 *
 * Суперадмин расписывается так же, как жилец, — на том же полотне и той же
 * двухшаговой загрузкой (D4). Подпись можно заменить: новая пойдёт в договоры,
 * которые ещё не подписаны, а подписанные держат свою копию снимком
 * (`residencies.owner_signature_file_id`) и задним числом не меняются.
 *
 * Файл уровня сети: дома у подписи нет.
 */
async function upload(blob: Blob): Promise<string> {
  const session = await fetch('/api/v1/files/upload-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      house_id: null,
      purpose: 'owner-signature',
      mime: 'image/png',
      size_bytes: blob.size,
      original_name: 'owner-signature.png',
    }),
  });

  if (!session.ok) {
    throw new Error('settings.errors.upload');
  }

  const target = (await session.json()) as {
    file_id: string;
    upload: { url: string; method: 'PUT' | 'POST'; headers: Record<string, string> };
  };

  const sent = await fetch(target.upload.url, {
    method: target.upload.method,
    headers: { ...target.upload.headers, 'content-type': 'image/png' },
    body: blob,
  });

  if (!sent.ok) {
    throw new Error('settings.errors.upload');
  }

  const completed = await fetch(`/api/v1/files/${target.file_id}/complete`, { method: 'POST' });

  if (!completed.ok) {
    throw new Error('settings.errors.upload');
  }

  return target.file_id;
}

export function OwnerSignature({ fileId }: { fileId: string | null }) {
  const t = useTranslations('settings.ownerSignature');
  const [state, action, isPending] = useActionState(saveOwnerSignatureAction, INITIAL);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDrawing, setDrawing] = useState(fileId === null);
  const exportRef = useRef<(() => Promise<Blob | null>) | null>(null);

  async function saveDrawing(): Promise<void> {
    setError(null);

    const blob = await exportRef.current?.();

    if (blob == null) {
      setError('settings.ownerSignature.empty');

      return;
    }

    try {
      setUploaded(await upload(blob));
    } catch {
      setError('settings.errors.upload');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>

      <div className="flex flex-col gap-3 p-4 pt-0">
        <p className="text-text-muted text-[13px]">{t('hint')}</p>

        {fileId !== null && !isDrawing && (
          <div className="flex flex-wrap items-center gap-4">
            {/* Подпись показывается тем же просмотром, что документы (D25). */}
            <img
              alt=""
              className="border-border max-h-[80px] rounded border bg-white p-1"
              src={fileViewHref(fileId)}
            />

            <Button
              onClick={() => {
                setDrawing(true);
              }}
              size="sm"
              type="button"
              variant="secondary"
            >
              {t('replace')}
            </Button>
          </div>
        )}

        {isDrawing && (
          <div className="flex flex-col gap-3">
            <SignaturePad
              clearLabel={t('clear')}
              exportRef={exportRef}
              onChange={() => {
                setError(null);
              }}
            />

            {error !== null && (
              <p className="text-danger text-[13px]" role="alert">
                {t(error.replace('settings.ownerSignature.', '').replace('settings.errors.', ''))}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => {
                  void saveDrawing();
                }}
                size="sm"
                type="button"
                variant="secondary"
              >
                {t('prepare')}
              </Button>

              <form action={action}>
                <input name="fileId" type="hidden" value={uploaded ?? ''} />
                <Button
                  data-testid="owner-signature-save"
                  disabled={isPending || uploaded === null}
                  size="sm"
                  type="submit"
                >
                  {t('save')}
                </Button>
              </form>

              {fileId !== null && (
                <Button
                  onClick={() => {
                    setDrawing(false);
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {t('cancel')}
                </Button>
              )}
            </div>

            {state.error !== undefined && (
              <p className="text-danger text-[13px]" role="alert">
                {state.error}
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
