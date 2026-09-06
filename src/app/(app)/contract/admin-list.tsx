'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';

import { buildContractAction, issueKeysAction, type ContractActionState } from './actions';

/** Строка списка: договор и ключи — раздельные отметки, и видны они раздельно. */
export interface ContractRowView {
  residencyId: string;
  residentName: string;
  contractFileId: string | null;
  isSigned: boolean;
  keysIssued: boolean;
}

const INITIAL: ContractActionState = {};

function ContractRow({ row }: { row: ContractRowView }) {
  const t = useTranslations();
  const [buildState, buildAction, isBuilding] = useActionState(buildContractAction, INITIAL);
  const [keysState, keysAction, isIssuing] = useActionState(issueKeysAction, INITIAL);

  return (
    <Card data-testid="contract-row">
      <CardHeader>
        <CardTitle>{row.residentName}</CardTitle>
        <div className="flex gap-2">
          <Badge tone={row.isSigned ? 'success' : 'neutral'}>
            {row.isSigned ? t('contract.statusSigned') : t('contract.statusUnsigned')}
          </Badge>
          <Badge tone={row.keysIssued ? 'success' : 'neutral'}>
            {row.keysIssued ? t('contract.keysIssued') : t('contract.keysNotIssued')}
          </Badge>
        </div>
      </CardHeader>

      <div className="flex flex-col gap-3 p-4 pt-0">
        {row.contractFileId !== null && (
          <a
            className="text-accent text-[13px] underline"
            href={`/api/v1/files/${row.contractFileId}/content`}
            rel="noreferrer"
            target="_blank"
          >
            {t('contract.open')}
          </a>
        )}

        {buildState.error !== undefined && (
          <p className="text-danger text-[13px]" role="alert">
            {t(buildState.error)}
          </p>
        )}
        {keysState.error !== undefined && (
          <p className="text-danger text-[13px]" role="alert">
            {t(keysState.error)}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {!row.isSigned && (
            <form action={buildAction}>
              <input name="residencyId" type="hidden" value={row.residencyId} />
              <Button disabled={isBuilding} type="submit" variant="secondary">
                {row.contractFileId === null ? t('contract.build') : t('contract.rebuild')}
              </Button>
            </form>
          )}

          {!row.keysIssued && (
            <form action={keysAction}>
              <input name="residencyId" type="hidden" value={row.residencyId} />
              <Button disabled={isIssuing} type="submit" variant="secondary">
                {t('contract.issueKeys')}
              </Button>
            </form>
          )}
        </div>
      </div>
    </Card>
  );
}

export function ContractList({ rows }: { rows: readonly ContractRowView[] }) {
  const t = useTranslations();

  if (rows.length === 0) {
    return <EmptyState description={t('contract.listEmptyHint')} title={t('contract.listEmpty')} />;
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {rows.map((row) => (
        <ContractRow key={row.residencyId} row={row} />
      ))}
    </div>
  );
}
