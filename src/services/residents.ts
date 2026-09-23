import { getDb, type Executor } from '@/db/client';
import { findPlacementOfResidency } from '@/db/repositories/areas';
import { listDocuments, listDocumentTypes } from '@/db/repositories/documents';
import { listHouses } from '@/db/repositories/houses';
import { listInvoices } from '@/db/repositories/invoices';
import { listResidencies, requireResidency } from '@/db/repositories/residencies';
import { findProfile, listHistoricNames } from '@/db/repositories/resident-profiles';
import { requireUser } from '@/db/repositories/users';
import { documentValidity } from '@/domain/documents';
import { assertCan } from '@/lib/authz';
import {
  compareBusinessDates,
  parseBusinessDate,
  todayInAlmaty,
  type BusinessDate,
} from '@/lib/time';

import type { Residency, User } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Список жильцов дома и карточка (docs/04-MODULES/01-onboarding.md).
 *
 * Видимость идёт через проживание — это и закрывает долг фазы 1: до появления
 * проживаний список жильцов дома у админа оставался пустым (D11).
 */
export interface ResidentRow {
  residencyId: string;
  userId: string;
  houseId: string;
  /** Название дома: сводный список сети читает человек, а не машина. */
  houseName: string;
  fullName: string;
  phone: string;
  status: Residency['status'];
  room: string | null;
  bed: string | null;
  price: number | null;
  /** Есть просроченный неоплаченный счёт. */
  hasDebt: boolean;
  /** Есть обязательный документ, который просрочен или не принят. */
  hasDocumentProblem: boolean;
  role: User['role'];
}

export interface ResidentFilter {
  status?: Residency['status'];
  /** Дом: у суперадмина список идёт по всей сети, админ видит только свой. */
  houseId?: string;
  /** Идентификатор зоны: фильтр «по комнате» из модуля 1. */
  areaId?: string;
  withDebt?: boolean;
  withDocumentProblems?: boolean;
  /** Поиск по ФИО и телефону. */
  query?: string;
}

export interface ResidentsDeps {
  executor?: Executor;
  today?: BusinessDate;
}

export interface ResidentCard {
  residency: Residency;
  row: ResidentRow;
}

function fullNameOf(parts: readonly (string | null)[], fallback: string): string {
  const name = parts
    .filter((part) => part !== null && part !== '')
    .join(' ')
    .trim();

  return name === '' ? fallback : name;
}

function matchesQuery(row: ResidentRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return true;
  }

  return row.fullName.toLowerCase().includes(needle) || row.phone.toLowerCase().includes(needle);
}

async function buildRow(
  actor: UserActor,
  residency: Residency,
  today: BusinessDate,
  houseNames: ReadonlyMap<string, string>,
  executor: Executor,
): Promise<ResidentRow> {
  const [user, profile, placement, invoices, types, documents] = await Promise.all([
    requireUser(actor.context, residency.userId, executor),
    findProfile(actor.context, residency.userId, executor),
    findPlacementOfResidency(actor.context, residency.id, executor),
    listInvoices(actor.context, { residencyId: residency.id }, executor),
    listDocumentTypes(actor.context, {}, executor),
    listDocuments(actor.context, { residencyId: residency.id }, executor),
  ]);

  /*
   * Долг — просроченный неоплаченный счёт (§3, «Просрочка»). Счёт без срока
   * оплаты долгом не считается: срок ещё не наступил, а не пропущен.
   */
  const hasDebt = invoices.some(
    (invoice) =>
      (invoice.status === 'issued' || invoice.status === 'partially_paid') &&
      invoice.dueDate !== null &&
      compareBusinessDates(parseBusinessDate(invoice.dueDate), today) < 0,
  );

  const byType = new Map(documents.map((document) => [document.documentTypeId, document]));

  const hasDocumentProblem = types
    .filter((type) => type.isRequired)
    .some((type) => {
      const document = byType.get(type.id);
      if (document === undefined || document.status !== 'approved') {
        return true;
      }

      const validUntil =
        document.validUntil === null ? null : parseBusinessDate(document.validUntil);

      return documentValidity(validUntil, today) === 'expired';
    });

  return {
    residencyId: residency.id,
    userId: residency.userId,
    houseId: residency.houseId,
    houseName: houseNames.get(residency.houseId) ?? residency.houseId,
    fullName: fullNameOf(
      [profile?.lastName ?? null, profile?.firstName ?? null, profile?.middleName ?? null],
      user.phone,
    ),
    phone: user.phone,
    status: residency.status,
    room: placement?.area.name ?? null,
    bed: placement?.bed.label ?? null,
    price: placement?.price ?? null,
    hasDebt,
    hasDocumentProblem,
    role: user.role,
  };
}

export async function listHouseResidents(
  actor: UserActor,
  filter: ResidentFilter = {},
  deps: ResidentsDeps = {},
): Promise<ResidentRow[]> {
  const executor = deps.executor ?? getDb();
  const today = deps.today ?? todayInAlmaty();

  const residencies = await listResidencies(
    actor.context,
    {
      ...(filter.status === undefined ? {} : { status: filter.status }),
      ...(filter.houseId === undefined || filter.houseId === '' ? {} : { houseId: filter.houseId }),
    },
    executor,
  );

  /*
   * Названия домов берутся одним запросом на весь список: сводный список сети
   * без колонки дома отвечает на вопрос «кто есть», но не на вопрос «где он».
   */
  const houseNames = new Map(
    (await listHouses(actor.context, {}, executor)).map((house) => [house.id, house.name]),
  );

  const rows: ResidentRow[] = [];

  for (const residency of residencies) {
    const row = await buildRow(actor, residency, today, houseNames, executor);

    if (filter.withDebt === true && !row.hasDebt) {
      continue;
    }
    if (filter.withDocumentProblems === true && !row.hasDocumentProblem) {
      continue;
    }
    if (filter.query !== undefined && !matchesQuery(row, filter.query)) {
      continue;
    }

    rows.push(row);
  }

  if (filter.areaId === undefined) {
    return rows.sort((first, second) => first.fullName.localeCompare(second.fullName, 'ru'));
  }

  // Фильтр по комнате идёт по названию зоны: место жильца известно из назначения.
  const placements = await Promise.all(
    rows.map(async (row) => ({
      row,
      placement: await findPlacementOfResidency(actor.context, row.residencyId, executor),
    })),
  );

  return placements
    .filter((entry) => entry.placement?.area.id === filter.areaId)
    .map((entry) => entry.row)
    .sort((first, second) => first.fullName.localeCompare(second.fullName, 'ru'));
}

/**
 * Имена для исторических записей дома (указание владельца, 23 сентября 2026).
 *
 * Отвечает на один вопрос: как зовут тех, кто занимал места этого дома.
 * Нужен закрытому коммунальному периоду, счетам, ущербу и ротациям —
 * строка с суммой и без имени непроверяема, а объясняться за неё придётся
 * админу дома.
 *
 * Это **не** доступ к карточке: телефона, документов, справок, нынешнего
 * рейтинга и дел уехавшего в новом доме здесь нет и не будет. Уехавший
 * ушёл из дома, и его сегодняшние данные админа покинутого дома не касаются
 * (решение D27). Негативная фикстура на это — в `residents.db-test.ts`.
 */
export async function houseHistoryNames(
  actor: UserActor,
  houseId: string,
  userIds: readonly string[],
  deps: ResidentsDeps = {},
): Promise<Map<string, string>> {
  const executor = deps.executor ?? getDb();

  assertCan(actor.context, 'user.read', { houseId });

  const rows = await listHistoricNames(actor.context, houseId, userIds, executor);

  return new Map(
    rows.map((row) => [row.userId, fullNameOf([row.lastName, row.firstName, row.middleName], '')]),
  );
}

export async function readResidentCard(
  actor: UserActor,
  residencyId: string,
  deps: ResidentsDeps = {},
): Promise<ResidentCard> {
  const executor = deps.executor ?? getDb();
  const today = deps.today ?? todayInAlmaty();

  const residency = await requireResidency(actor.context, residencyId, executor);
  assertCan(actor.context, 'user.read', {
    houseId: residency.houseId,
    userId: residency.userId,
  });

  const houseNames = new Map(
    (await listHouses(actor.context, {}, executor)).map((house) => [house.id, house.name]),
  );

  return { residency, row: await buildRow(actor, residency, today, houseNames, executor) };
}
