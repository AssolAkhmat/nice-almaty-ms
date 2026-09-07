import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { listHouses } from '@/db/repositories/houses';
import { API_SCOPES } from '@/domain/api-scopes';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { listTokens } from '@/services/api-tokens';

import { TokensView, type TokenRow } from './tokens-view';

import type { UserActor } from '@/services/users';

export const dynamic = 'force-dynamic';

/**
 * Токены API (docs/06-API.md, «Аутентификация»).
 *
 * Экран суперадмина: токен — ключ ко всей сети, и заводит его тот, у кого
 * права на сеть. Значение видно один раз, сразу после выдачи.
 */
export default async function ApiTokensPage() {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const { context } = session;

  if (!can(context, 'settings.org.read', {})) {
    redirect('/settings');
  }

  const t = await getTranslations('apiTokens');
  const actor: UserActor = { context };

  const [tokens, houses] = await Promise.all([
    listTokens(actor, { includeRevoked: false }),
    listHouses(context),
  ]);

  const names = new Map(houses.map((house) => [house.id, house.name]));

  const rows: TokenRow[] = tokens.map((token) => ({
    tokenId: token.id,
    name: token.name,
    scopes: [...token.scopes],
    houseName: token.houseId === null ? null : (names.get(token.houseId) ?? null),
    expiresAt: token.expiresAt?.toISOString().slice(0, 10) ?? null,
    lastUsedAt: token.lastUsedAt?.toISOString().slice(0, 10) ?? null,
  }));

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
      </div>

      <TokensView
        houses={houses.map((house) => ({ id: house.id, name: house.name }))}
        scopes={[...API_SCOPES]}
        tokens={rows}
      />
    </section>
  );
}
