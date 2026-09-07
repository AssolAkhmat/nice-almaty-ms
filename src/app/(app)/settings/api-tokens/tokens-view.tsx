'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';

import { issueTokenAction, revokeTokenAction, type TokenActionState } from './actions';

const INITIAL: TokenActionState = {};

export interface TokenRow {
  tokenId: string;
  name: string;
  scopes: string[];
  houseName: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface TokensViewProps {
  tokens: TokenRow[];
  houses: { id: string; name: string }[];
  scopes: string[];
}

function Message({ state }: { state: TokenActionState }) {
  const t = useTranslations();

  return (
    <>
      {state.error !== undefined && (
        <p className="text-danger text-[13px]" role="alert">
          {t(state.error)}
        </p>
      )}
      {state.done !== undefined && <p className="text-success text-[13px]">{t(state.done)}</p>}
    </>
  );
}

function IssueForm({ houses, scopes }: { houses: TokensViewProps['houses']; scopes: string[] }) {
  const t = useTranslations('apiTokens');
  const router = useRouter();
  const [state, action, pending] = useActionState(issueTokenAction, INITIAL);

  useEffect(() => {
    if (state.done !== undefined) {
      router.refresh();
    }
  }, [router, state]);

  return (
    <form action={action} className="flex flex-col gap-3">
      <Field label={t('name')}>
        <Input data-testid="token-name" name="name" required />
      </Field>

      <Field label={t('house')}>
        <Select data-testid="token-house" name="houseId">
          <option value="">{t('wholeNetwork')}</option>
          {houses.map((house) => (
            <option key={house.id} value={house.id}>
              {house.name}
            </option>
          ))}
        </Select>
      </Field>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-text-muted text-[13px]">{t('scopes')}</legend>
        <div className="flex flex-wrap gap-3">
          {scopes.map((scope) => (
            <label className="flex items-center gap-2 text-[13px]" key={scope}>
              <Checkbox data-testid={`scope-${scope}`} name="scopes" value={scope} />
              <code>{scope}</code>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <Button data-testid="token-issue" disabled={pending} type="submit">
          {t('issue')}
        </Button>
        <Message state={state} />
      </div>

      {state.value !== undefined && (
        <div className="border-border rounded-card flex flex-col gap-1 border p-3">
          <span className="text-text-muted text-[13px]">{t('value')}</span>
          <code className="text-[15px] break-all" data-testid="token-value">
            {state.value}
          </code>
          <span className="text-text-muted text-[13px]">{t('copyHint')}</span>
        </div>
      )}
    </form>
  );
}

function RevokeButton({ tokenId }: { tokenId: string }) {
  const t = useTranslations('apiTokens');
  const router = useRouter();
  const [state, action, pending] = useActionState(revokeTokenAction, INITIAL);

  useEffect(() => {
    if (state.done !== undefined) {
      router.refresh();
    }
  }, [router, state]);

  return (
    <form action={action}>
      <input name="tokenId" type="hidden" value={tokenId} />
      <Button disabled={pending} size="sm" type="submit" variant="secondary">
        {t('revoke')}
      </Button>
    </form>
  );
}

export function TokensView({ houses, scopes, tokens }: TokensViewProps) {
  const t = useTranslations('apiTokens');

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('issue')}</CardTitle>
        </CardHeader>
        <IssueForm houses={houses} scopes={scopes} />
      </Card>

      <Card data-testid="tokens-list">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>

        {tokens.length === 0 ? (
          <EmptyState title={t('empty')} />
        ) : (
          <ul className="flex flex-col gap-3">
            {tokens.map((token) => (
              <li className="flex flex-col gap-1" key={token.tokenId}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[15px] font-medium">{token.name}</span>
                  <RevokeButton tokenId={token.tokenId} />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {token.scopes.map((scope) => (
                    <Badge key={scope}>{scope}</Badge>
                  ))}
                </div>

                <span className="text-text-muted text-[13px]">
                  {token.houseName ?? t('wholeNetwork')} · {t('expires')}: {token.expiresAt ?? '—'}{' '}
                  · {t('lastUsed')}: {token.lastUsedAt ?? t('never')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
