'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { SignaturePad } from '@/components/ui/signature-pad';

import { signContractAction, type ContractActionState } from './actions';

export interface ContractView {
  residencyId: string;
  contractFileId: string | null;
  isSigned: boolean;
  keysIssued: boolean;
}

const INITIAL: ContractActionState = {};

/** Подпись уходит той же двухшаговой загрузкой, что и документы (D4). */
async function uploadSignature(residencyId: string, blob: Blob): Promise<string> {
  const session = await fetch('/api/v1/files/upload-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      residency_id: residencyId,
      document_type: 'signature',
      mime: 'image/png',
      size_bytes: blob.size,
      original_name: 'signature.png',
    }),
  });

  if (!session.ok) {
    throw new Error('contract.errors.upload');
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
    throw new Error('contract.errors.upload');
  }

  const completed = await fetch(`/api/v1/files/${target.file_id}/complete`, { method: 'POST' });
  if (!completed.ok) {
    throw new Error('contract.errors.upload');
  }

  return target.file_id;
}

export function ContractCard({ contract }: { contract: ContractView }) {
  const t = useTranslations();
  const [state, action, isPending] = useActionState(signContractAction, INITIAL);
  const [signatureFileId, setSignatureFileId] = useState<string | null>(null);
  const [isSending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasDrawing, setHasDrawing] = useState(false);
  const exportRef = useRef<(() => Promise<Blob | null>) | null>(null);

  async function prepareSignature(): Promise<void> {
    setError(null);
    setSending(true);

    try {
      const blob = await exportRef.current?.();
      if (blob === null || blob === undefined) {
        setError('contract.errors.emptySignature');

        return;
      }

      setSignatureFileId(await uploadSignature(contract.residencyId, blob));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'contract.errors.upload');
    } finally {
      setSending(false);
    }
  }

  if (contract.contractFileId === null) {
    return <EmptyState description={t('contract.notBuiltHint')} title={t('contract.notBuilt')} />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('contract.title')}</CardTitle>
        <span className="text-text-muted text-[13px]">
          {contract.isSigned ? t('contract.statusSigned') : t('contract.statusUnsigned')}
        </span>
      </CardHeader>

      <div className="flex flex-col gap-4 p-4 pt-0">
        <a
          className="text-accent text-[13px] underline"
          data-testid="contract-file"
          href={`/api/v1/files/${contract.contractFileId}/content`}
          rel="noreferrer"
          target="_blank"
        >
          {t('contract.open')}
        </a>

        {contract.isSigned ? (
          <p className="text-text-muted text-[13px]">{t('contract.signedHint')}</p>
        ) : (
          <>
            <p className="text-text-muted text-[13px]">{t('contract.signHint')}</p>

            <SignaturePad
              clearLabel={t('contract.clear')}
              disabled={isSending || isPending}
              exportRef={exportRef}
              onChange={(isEmpty) => {
                setHasDrawing(!isEmpty);
                setSignatureFileId(null);
              }}
            />

            {error !== null && (
              <p className="text-danger text-[13px]" role="alert">
                {t(error)}
              </p>
            )}
            {state.error !== undefined && (
              <p className="text-danger text-[13px]" role="alert">
                {t(state.error)}
              </p>
            )}

            <form action={action} className="flex flex-col gap-2">
              <input name="residencyId" type="hidden" value={contract.residencyId} />
              <input name="signatureFileId" type="hidden" value={signatureFileId ?? ''} />

              {signatureFileId === null ? (
                <Button
                  disabled={!hasDrawing || isSending}
                  onClick={() => {
                    void prepareSignature();
                  }}
                  type="button"
                >
                  {isSending ? t('contract.sending') : t('contract.prepare')}
                </Button>
              ) : (
                <Button data-testid="sign-submit" disabled={isPending} type="submit">
                  {t('contract.sign')}
                </Button>
              )}
            </form>
          </>
        )}
      </div>
    </Card>
  );
}
