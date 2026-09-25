import { AppLink } from '@/components/ui/app-link';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { listHouses } from '@/db/repositories/houses';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { fileViewHref } from '@/components/files/file-links';
import { Money } from '@/components/ui/money';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { addMonths, startOfMonth, todayInAlmaty } from '@/lib/time';
import { listAuditEntries } from '@/db/repositories/audit-log';
import { houseLayout } from '@/services/beds';
import { readDepositView } from '@/services/deposits';
import { listDocumentCards } from '@/services/documents';
import { listInvoicesFor } from '@/services/invoices';
import { readResidentRating } from '@/services/rating-views';
import { groupsNamingUser } from '@/services/relocations';
import { readProfile } from '@/services/resident-profiles';
import { readResidentCard } from '@/services/residents';
import { readRotationStats } from '@/services/rotation-stats';
import { readTerminationView } from '@/services/terminations';

import {
  DepositSection,
  HistorySection,
  InvoicesSection,
  RatingSection,
  RotationsSection,
} from './card-sections';
import { DocumentsSection } from './documents-section';
import { ProfileSection } from './profile-section';
import { RelocationPanel, type FreeBedView } from './relocation-panel';
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

  /*
   * Переселение — действие сети: права нужны в обоих домах сразу, поэтому
   * панель видит тот, кому видны другие дома. Показывается только
   * действующему проживанию: архивному переселяться некуда.
   */
  const canRelocate =
    houses.length > 1 &&
    (card.residency.status === 'active' || card.residency.status === 'terminating') &&
    houses.every((house) => can(context, 'bed.assign', { houseId: house.id }));

  const freeBeds: FreeBedView[] = [];
  let namedGroups: { id: string; name: string }[] = [];

  if (canRelocate) {
    for (const house of houses) {
      if (house.id === card.residency.houseId) {
        continue;
      }

      for (const area of await houseLayout(actor, house.id)) {
        for (const bed of area.beds) {
          if (bed.occupiedBy !== null) {
            continue;
          }

          freeBeds.push({
            houseId: house.id,
            houseName: house.name,
            bedId: bed.bedId,
            label: `${area.area.name}, ${bed.label}`,
            defaultPrice: bed.defaultPrice,
          });
        }
      }
    }

    namedGroups = (await groupsNamingUser(actor, card.residency.houseId, card.row.userId)).map(
      (group) => ({ id: group.id, name: group.name }),
    );
  }

  /*
   * Разделы карточки (модуль 1). Каждый грузится только тому, кому положен:
   * право спрашивается там же, где его проверит сервис, и раздел просто
   * не появляется — вместо отказа на весь экран.
   */
  const userId = card.row.userId;
  const houseId = card.residency.houseId;
  const target = { houseId, userId };

  const mayReadDocuments = can(context, 'document.read', target);
  const mayReadDeposit = can(context, 'deposit.read', target);
  const mayReadInvoices = can(context, 'invoice.read', target);
  const mayReadRating = can(context, 'rating.history', target);
  const mayReadRotations = can(context, 'rotation.score', { houseId });
  const mayEditProfile = can(context, 'user.updateProfile', target);
  const mayReadHistory = context.role === 'superadmin';

  const [profile, documents, deposit, invoices, rating, stats, history] = await Promise.all([
    mayEditProfile ? readProfile(actor, userId) : null,
    mayReadDocuments ? listDocumentCards(actor, card.residency.id) : null,
    mayReadDeposit ? readDepositView(actor, card.residency.id) : null,
    mayReadInvoices ? listInvoicesFor(actor, { residencyId: card.residency.id }) : null,
    mayReadRating ? readResidentRating(actor, userId) : null,
    mayReadRotations
      ? readRotationStats(actor, houseId, {
          from: addMonths(startOfMonth(todayInAlmaty()), -11),
          to: todayInAlmaty(),
        })
      : null,
    mayReadHistory ? listAuditEntries(context, { entityId: card.residency.id, limit: 20 }) : null,
  ]);

  /* Фото 3×4 живёт типом документа, а не полем профиля: так его и грузят. */
  const photoFileId =
    documents?.find((document) => document.type.code === 'photo_3x4')?.document?.fileId ?? null;

  const person = stats?.byPerson.find((row) => row.userId === userId) ?? null;

  return (
    <section className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        {photoFileId !== null && (
          <span className="border-border h-[56px] w-[42px] shrink-0 overflow-hidden rounded border">
            {/*
              Фото 3×4 над именем (указание владельца, 25 сентября 2026).
              Идёт через тот же просмотр, что и документы: ссылка живёт
              пять минут, прямой адрес файла наружу не уходит (D25).
            */}
            <img alt="" className="h-full w-full object-cover" src={fileViewHref(photoFileId)} />
          </span>
        )}

        <div className="flex flex-col gap-1">
          <h1>{card.row.fullName}</h1>
          <p className="text-text-muted text-[13px]">{card.row.phone}</p>
        </div>
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

      {profile !== null && (
        <ProfileSection
          canReplaceSecrets={context.role === 'superadmin'}
          profile={profile}
          room={card.row.room}
          bed={card.row.bed}
          userId={userId}
        />
      )}

      {documents !== null && <DocumentsSection cards={documents} />}

      {deposit !== null && <DepositSection view={deposit} />}

      {invoices !== null && (
        <InvoicesSection
          rows={invoices.map((row) => ({ ...row, href: `/invoices/${row.invoice.id}` }))}
        />
      )}

      {person !== null && (
        <RotationsSection
          summary={{
            done: person.done,
            missed: person.missed,
            averageScore: person.averageScore,
            debts: rating?.debts ?? 0,
          }}
        />
      )}

      {rating !== null && <RatingSection view={rating} />}

      {history !== null && <HistorySection entries={history} />}

      {canRelocate && (
        <RelocationPanel
          beds={freeBeds}
          groups={namedGroups}
          residencyId={card.residency.id}
          today={todayInAlmaty()}
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
