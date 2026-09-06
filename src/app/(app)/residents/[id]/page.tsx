import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { listHouses } from '@/db/repositories/houses';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { getCurrentSession } from '@/lib/session';
import { readResidentCard } from '@/services/residents';

import { RoleForm } from './role-form';

import type { UserActor } from '@/services/users';

export const dynamic = 'force-dynamic';

/**
 * Карточка жильца (docs/04-MODULES/01-onboarding.md).
 *
 * Сводка по проживанию плюс смена роли для суперадмина. Профиль, документы,
 * договор и депозит живут на своих экранах и открываются ссылками: копия
 * тех же данных здесь однажды разошлась бы с оригиналом.
 */
export default async function ResidentCardPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const t = await getTranslations('residents');
  const { context } = session;
  const actor: UserActor = { context };

  const { id } = await params;
  const card = await readResidentCard(actor, id);
  const houses = context.role === 'superadmin' ? await listHouses(context) : [];

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{card.row.fullName}</h1>
        <p className="text-text-muted text-[13px]">{card.row.phone}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('summary')}</CardTitle>
          <Badge tone={card.row.status === 'active' ? 'success' : 'neutral'}>
            {t(`statuses.${card.row.status}`)}
          </Badge>
        </CardHeader>

        <div className="flex flex-col gap-2 p-4 pt-0 text-[13px]">
          <div className="flex justify-between gap-4">
            <span>{t('room')}</span>
            <span>
              {card.row.room === null ? t('noRoom') : `${card.row.room}, ${card.row.bed ?? ''}`}
            </span>
          </div>

          {card.row.price !== null && (
            <div className="flex justify-between gap-4">
              <span>{t('price')}</span>
              <Money amount={card.row.price} />
            </div>
          )}

          <div className="flex gap-2">
            {card.row.hasDebt && <Badge tone="danger">{t('debtMark')}</Badge>}
            {card.row.hasDocumentProblem && <Badge tone="warning">{t('documentsMark')}</Badge>}
          </div>

          <div className="flex flex-wrap gap-3 pt-2">
            <Link className="text-accent underline" href="/documents">
              {t('links.documents')}
            </Link>
            <Link className="text-accent underline" href="/contract">
              {t('links.contract')}
            </Link>
            <Link className="text-accent underline" href="/deposit">
              {t('links.deposit')}
            </Link>
          </div>
        </div>
      </Card>

      {context.role === 'superadmin' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('roleTitle')}</CardTitle>
          </CardHeader>

          <div className="p-4 pt-0">
            <RoleForm
              currentRole={card.row.role}
              houseId={card.residency.houseId}
              houses={houses.map((house) => ({ id: house.id, name: house.name }))}
              userId={card.row.userId}
            />
          </div>
        </Card>
      )}
    </section>
  );
}
