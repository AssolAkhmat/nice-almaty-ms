import { AppLink } from '@/components/ui/app-link';
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { listDocumentTypes } from '@/db/repositories/documents';
import { listHouses } from '@/db/repositories/houses';
import { listResidencies } from '@/db/repositories/residencies';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { listDocumentCards, listReviewDocuments } from '@/services/documents';
import { optionLabel, personLabels } from '@/services/person-labels';

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

interface ReviewFilter {
  status: 'uploaded' | 'approved' | 'rejected' | undefined;
  residencyId: string | undefined;
  houseId: string | undefined;
  documentTypeId: string | undefined;
  /** Поиск по жильцу: фамилия или имя, без учёта регистра (P2-9). */
  query: string;
}

async function reviewView(
  actor: UserActor,
  context: AccessContext,
  locale: string,
  filter: ReviewFilter,
  types: readonly DocumentType[],
): Promise<ReviewItemView[]> {
  const documents = await listReviewDocuments(actor, {
    ...(filter.status === undefined ? {} : { status: filter.status }),
    ...(filter.residencyId === undefined ? {} : { residencyId: filter.residencyId }),
    ...(filter.houseId === undefined ? {} : { houseId: filter.houseId }),
    ...(filter.documentTypeId === undefined ? {} : { documentTypeId: filter.documentTypeId }),
  });

  /*
   * Типы и подписи читаются по одному разу на весь список, а не по разу
   * на строку: на сотне документов прежний способ делал двести запросов.
   * Типы уже прочитаны ради фильтра — здесь они переиспользуются.
   *
   * Подпись строит общий `personLabels`: без имени в строке стоит телефон,
   * а не пустое место, и чтение списка больше не создаёт профиль побочно
   * (прежний `readProfile` заводил пустой профиль на каждого).
   */
  const typeOf = new Map(types.map((type) => [type.id, type]));
  const labels = await personLabels(
    context,
    documents.map((document) => document.userId),
  );

  const items = documents.map((document) => {
    const type = typeOf.get(document.documentTypeId);

    return {
      id: document.id,
      typeName: type === undefined ? '' : localizedName(type, locale),
      residentName: optionLabel(labels.get(document.userId), ''),
      fileId: document.fileId,
      status: document.status,
      issueDate: document.issueDate,
      validUntil: document.validUntil,
      rejectReason: document.rejectReason,
      createdAt: document.createdAt.toISOString(),
    };
  });

  /*
   * Поиск по жильцу идёт по собранным строкам, а не запросом: имя лежит
   * в профиле, и очередь уже читает его на каждую строку. Отдельный
   * SQL-поиск по тем же данным разошёлся бы с этим списком.
   */
  const needle = filter.query.trim().toLowerCase();

  return needle === ''
    ? items
    : items.filter((item) => item.residentName.toLowerCase().includes(needle));
}

const REVIEW_STATUSES = ['uploaded', 'approved', 'rejected'] as const;

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    residency?: string;
    back?: string;
    house?: string;
    type?: string;
    q?: string;
  }>;
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
  const {
    status: requested,
    residency: requestedResidency,
    back,
    house: requestedHouse,
    type: requestedType,
    q,
  } = await searchParams;
  const status = REVIEW_STATUSES.find((candidate) => candidate === requested) ?? 'uploaded';
  const search = q ?? '';

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

  /*
   * Фильтры очереди (находка P2-9, 27 сентября 2026): у суперадмина она была
   * общей на всю сеть, и разобрать её было нечем — ни дома, ни типа справки,
   * ни поиска по человеку.
   *
   * Дом из адреса сверяется со списком видимых: непринадлежащий дом
   * не «показывает пусто», а просто не применяется — право на очередь
   * всё равно спрашивается по нему в сервисе.
   */
  const houses = mayReview && context.role === 'superadmin' ? await listHouses(context) : [];
  const houseId = houses.some((house) => house.id === requestedHouse) ? requestedHouse : undefined;

  const types = mayReview ? await listDocumentTypes(context, { includeArchived: true }) : [];
  const documentTypeId = types.some((type) => type.id === requestedType)
    ? requestedType
    : undefined;

  const resident = isReviewer ? null : await residentView(actor, context, locale);
  const queue = mayReview
    ? await reviewView(
        actor,
        context,
        locale,
        { status, residencyId, houseId, documentTypeId, query: search },
        types,
      )
    : [];

  /** Фильтры переносятся ссылками статуса: иначе смена статуса сбрасывала бы их. */
  const carried = {
    ...(residencyId === undefined ? {} : { residency: residencyId }),
    ...(returnTo === undefined ? {} : { back: returnTo }),
    ...(houseId === undefined ? {} : { house: houseId }),
    ...(documentTypeId === undefined ? {} : { type: documentTypeId }),
    ...(search.trim() === '' ? {} : { q: search }),
  };

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
              href={{ pathname: '/documents', query: { status: value, ...carried } }}
              key={value}
            >
              {t(`status.${value}`)}
            </AppLink>
          ))}
        </nav>
      )}

      {mayReview && (
        /* Обычная форма GET: фильтры работают и без включённого JavaScript. */
        <form
          action="/documents"
          className="grid items-end gap-3 md:grid-cols-[1fr_1fr_1fr_auto]"
          data-testid="documents-filters"
          method="get"
        >
          <input name="status" type="hidden" value={status} />
          {residencyId !== undefined && (
            <input name="residency" type="hidden" value={residencyId} />
          )}
          {returnTo !== undefined && <input name="back" type="hidden" value={returnTo} />}

          {houses.length > 1 && (
            <Field htmlFor="documents-house" label={t('filterHouse')}>
              <Select
                data-testid="documents-house"
                defaultValue={houseId ?? ''}
                id="documents-house"
                name="house"
              >
                <option value="">{t('filterAllHouses')}</option>
                {houses.map((house) => (
                  <option key={house.id} value={house.id}>
                    {house.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field htmlFor="documents-type" label={t('filterType')}>
            <Select
              data-testid="documents-type"
              defaultValue={documentTypeId ?? ''}
              id="documents-type"
              name="type"
            >
              <option value="">{t('filterAllTypes')}</option>
              {types.map((type) => (
                <option key={type.id} value={type.id}>
                  {localizedName(type, locale)}
                </option>
              ))}
            </Select>
          </Field>

          <Field htmlFor="documents-q" label={t('filterResident')}>
            <Input
              data-testid="documents-q"
              defaultValue={search}
              id="documents-q"
              name="q"
              type="search"
            />
          </Field>

          <Button data-testid="documents-apply" size="sm" type="submit" variant="ghost">
            {t('filterApply')}
          </Button>
        </form>
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
