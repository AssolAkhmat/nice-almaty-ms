import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { requireDocumentType } from '@/db/repositories/documents';
import { listResidencies } from '@/db/repositories/residencies';
import { EmptyState } from '@/components/ui/empty-state';
import { getCurrentSession } from '@/lib/session';
import { listDocumentCards, listPendingDocuments } from '@/services/documents';
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
 * Само содержимое файла в обоих случаях отдаётся только через
 * `/api/v1/files/{id}/content`, который проверяет права: публичных ссылок нет.
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
): Promise<ReviewItemView[]> {
  const pending = await listPendingDocuments(actor);

  return Promise.all(
    pending.map(async (document) => {
      const type = await requireDocumentType(context, document.documentTypeId);
      const profile = await readProfile(actor, document.userId);
      const name = [profile.lastName, profile.firstName].filter((part) => part !== null).join(' ');

      return {
        id: document.id,
        typeName: localizedName(type, locale),
        // Профиль может быть ещё пустым: в списке тогда нужен хоть какой-то ориентир.
        residentName: name.trim() === '' ? document.userId : name,
        fileId: document.fileId,
        issueDate: document.issueDate,
        validUntil: document.validUntil,
        createdAt: document.createdAt.toISOString(),
      };
    }),
  );
}

export default async function DocumentsPage() {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const t = await getTranslations('documents');
  const locale = await getLocale();
  const { context } = session;
  const actor: UserActor = { context };

  const isReviewer = context.role === 'admin' || context.role === 'superadmin';

  const resident = isReviewer ? null : await residentView(actor, context, locale);
  const queue = isReviewer ? await reviewView(actor, context, locale) : [];

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">
          {isReviewer ? t('reviewSubtitle') : t('subtitle')}
        </p>
      </div>

      {isReviewer ? (
        <ReviewQueue items={queue} />
      ) : resident === null ? (
        <EmptyState description={t('noResidencyHint')} title={t('noResidency')} />
      ) : (
        <DocumentCards cards={resident.cards} residencyId={resident.residencyId} />
      )}
    </section>
  );
}
