import { AppLink } from '@/components/ui/app-link';
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { requireDocumentType } from '@/db/repositories/documents';
import { listResidencies } from '@/db/repositories/residencies';
import { EmptyState } from '@/components/ui/empty-state';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { listDocumentCards, listReviewDocuments } from '@/services/documents';
import { readProfile } from '@/services/resident-profiles';

import { DocumentCards, type DocumentCardView } from './document-cards';
import { ReviewQueue, type ReviewItemView } from './review-queue';

import type { AccessContext } from '@/db/access';
import type { DocumentType } from '@/db/schema';
import type { UserActor } from '@/services/users';

export const dynamic = 'force-dynamic';

/**
 * Документы (docs/04-MODULES/01-onboarding.md).
 *
 * Жилец видит карточки типов: что требуется, что загружено, до какого числа
 * действует и почему отклонено. Админ видит очередь проверки по своему дому.
 * Само содержимое файла в обоих случаях открывается только ссылкой из
 * системы: она проверяет права и выдаёт пятиминутный пропуск
 * (`src/components/files/file-links.tsx`). Публичных ссылок нет.
 */
function localizedName(type: DocumentType, locale: string): string {
  const names = type.nameI18n as Record<string, string> | null;

  return names?.[locale] ?? names?.ru ?? type.code;
}

async function residentView(actor: UserActor, context: AccessContext, locale: string) {
  const [residency] = await listResidencies(context, {});
  if (residency === undefined) {
    return null;
  }

  const cards = await listDocumentCards(actor, residency.id);

  const views: DocumentCardView[] = cards.map((card) => ({
    typeId: card.type.id,
    code: card.type.code,
    name: localizedName(card.type, locale),
    requiresIssueDate: card.type.requiresIssueDate,
    status: card.document === null ? 'missing' : card.document.status,
    validity: card.validity,
    validUntil: card.document?.validUntil ?? null,
    daysLeft: card.daysLeft,
    rejectReason: card.document?.rejectReason ?? null,
    fileId: card.document?.fileId ?? null,
  }));

  return { residencyId: residency.id, cards: views };
}

async function reviewView(
  actor: UserActor,
  context: AccessContext,
  locale: string,
  status: 'uploaded' | 'approved' | 'rejected' | undefined,
  residencyId: string | undefined,
): Promise<ReviewItemView[]> {
  const documents = await listReviewDocuments(actor, {
    ...(status === undefined ? {} : { status }),
    ...(residencyId === undefined ? {} : { residencyId }),
  });

  return Promise.all(
    documents.map(async (document) => {
      const type = await requireDocumentType(context, document.documentTypeId);
      const profile = await readProfile(actor, document.userId);
      const name = [profile.lastName, profile.firstName].filter((part) => part !== null).join(' ');

      return {
        id: document.id,
        typeName: localizedName(type, locale),
        // Профиль может быть ещё пустым: в списке тогда нужен хоть какой-то ориентир.
        residentName: name.trim() === '' ? document.userId : name,
        fileId: document.fileId,
        status: document.status,
        issueDate: document.issueDate,
        validUntil: document.validUntil,
        rejectReason: document.rejectReason,
        createdAt: document.createdAt.toISOString(),
      };
    }),
  );
}

const REVIEW_STATUSES = ['uploaded', 'approved', 'rejected'] as const;

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; residency?: string; back?: string }>;
}) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const t = await getTranslations('documents');
  const locale = await getLocale();
  const { context } = session;
  const actor: UserActor = { context };

  const isReviewer = context.role === 'admin' || context.role === 'superadmin';

  /*
   * Статус стал фильтром: по умолчанию очередь, но проверенные документы
   * никуда не деваются и открываются (указание владельца, 23 сентября 2026).
   */
  const { status: requested, residency: requestedResidency, back } = await searchParams;
  const status = REVIEW_STATUSES.find((candidate) => candidate === requested) ?? 'uploaded';

  /*
   * Очередь по одному жильцу: админ открыл человека и проверяет его справки
   * (указание владельца, 25 сентября 2026). Адрес возврата проверяется
   * белым списком — «куда угодно из ссылки» это открытое перенаправление.
   */
  const residencyId =
    requestedResidency !== undefined && /^[0-9a-f-]{36}$/.test(requestedResidency)
      ? requestedResidency
      : undefined;

  const returnTo =
    back !== undefined && /^\/residents\/[0-9a-f-]{36}$/.test(back) ? back : undefined;

  /*
   * Доступ админа к документам жильца сеть может не включать (указание
   * владельца, 23 сентября 2026). Тогда экран объясняет себя, а не падает
   * отказом: отказ выглядел бы поломкой, а это осознанная настройка.
   */
  const mayReview =
    isReviewer &&
    can(context, 'document.read', { houseId: context.houseId, userId: context.userId });

  const resident = isReviewer ? null : await residentView(actor, context, locale);
  const queue = mayReview ? await reviewView(actor, context, locale, status, residencyId) : [];

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">
          {isReviewer ? t('reviewSubtitle') : t('subtitle')}
        </p>
      </div>

      {mayReview && (
        <nav className="flex flex-wrap gap-3 text-[13px]">
          {REVIEW_STATUSES.map((value) => (
            <AppLink
              className={
                value === status ? 'text-text font-medium' : 'text-text-muted hover:text-text'
              }
              data-testid={`documents-filter-${value}`}
              href={{
                pathname: '/documents',
                query: {
                  status: value,
                  ...(residencyId === undefined ? {} : { residency: residencyId }),
                  ...(returnTo === undefined ? {} : { back: returnTo }),
                },
              }}
              key={value}
            >
              {t(`status.${value}`)}
            </AppLink>
          ))}
        </nav>
      )}

      {isReviewer && !mayReview ? (
        <EmptyState description={t('accessOffHint')} title={t('accessOff')} />
      ) : isReviewer ? (
        <ReviewQueue items={queue} returnTo={returnTo} />
      ) : resident === null ? (
        <EmptyState description={t('noResidencyHint')} title={t('noResidency')} />
      ) : (
        <DocumentCards cards={resident.cards} residencyId={resident.residencyId} />
      )}
    </section>
  );
}
