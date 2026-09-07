import { AppLink } from '@/components/ui/app-link';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { listHouses } from '@/db/repositories/houses';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { todayInAlmaty } from '@/lib/time';
import { readResidentCard } from '@/services/residents';
import { readTerminationView } from '@/services/terminations';

import { RoleForm } from './role-form';
import { TerminationPanel } from './termination-panel';

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

  /*
   * Расторжение показывается только тому, кто вправе его выполнить. Роль
   * здесь не спрашивается: право читается там же, где его проверяет сервис.
   */
  const canTerminate = can(context, 'residency.terminate', {
    houseId: card.residency.houseId,
    userId: card.row.userId,
  });

  /*
   * Расчёт нужен действующему и расторгаемому проживанию. Незаселённому
   * расторгать нечего, архивному — уже нечего считать.
   */
  const withTermination =
    canTerminate && (card.residency.status === 'active' || card.residency.status === 'terminating');

  const termination = withTermination ? await readTerminationView(actor, card.residency.id) : null;

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
            <AppLink className="text-accent underline" href="/documents">
              {t('links.documents')}
            </AppLink>
            <AppLink className="text-accent underline" href="/contract">
              {t('links.contract')}
            </AppLink>
            <AppLink className="text-accent underline" href="/deposit">
              {t('links.deposit')}
            </AppLink>
          </div>
        </div>
      </Card>

      {termination !== null && (
        <TerminationPanel
          view={{
            residencyId: termination.residency.id,
            status: termination.residency.status,
            today: todayInAlmaty(),
            moveOutDate: termination.residency.moveOutDate,
            balance: termination.balance,
            damages: termination.damages,
            fullMonths: termination.fullMonths,
            deadline: termination.deadline,
            daysLeft: termination.daysLeft,
            outcome: termination.outcome.kind,
            debt: termination.outcome.debt,
            refundInvoice:
              termination.refundInvoice === null
                ? null
                : {
                    id: termination.refundInvoice.id,
                    total: termination.refundInvoice.total,
                    status: termination.refundInvoice.status,
                  },
            canArchive: termination.canArchive,
          }}
        />
      )}

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
