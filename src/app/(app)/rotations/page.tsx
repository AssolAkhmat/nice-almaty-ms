import { AppLink } from '@/components/ui/app-link';
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { listHouses } from '@/db/repositories/houses';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import {
  addDays,
  addMonths,
  businessDate,
  businessDateToParts,
  daysInMonth,
  differenceInDays,
  startOfMonth,
  todayInAlmaty,
  toAlmatyParts,
  startOfDayUtc,
  tryParseBusinessDate,
  type BusinessDate,
} from '@/lib/time';
import { readCalendar } from '@/services/rotation-calendar';
import { readTemplateText } from '@/services/rotation-templates';

import { DayTemplate } from './day-template';
import {
  RotationCalendarView,
  type CalendarMode,
  type MemberOption,
  type OccurrenceCard,
  type ZoneOption,
} from './rotation-calendar-view';

import type { UserActor } from '@/services/users';

export const dynamic = 'force-dynamic';

const MODES: CalendarMode[] = ['day', 'week', 'month'];

function isMode(value: string | undefined): value is CalendarMode {
  return value !== undefined && MODES.includes(value as CalendarMode);
}

/** Начало недели — понедельник: так неделю считает и сетка ротаций. */
function startOfWeek(date: BusinessDate): BusinessDate {
  const weekday = toAlmatyParts(startOfDayUtc(date)).weekday;

  return addDays(date, weekday === 0 ? -6 : 1 - weekday);
}

function rangeOf(mode: CalendarMode, date: BusinessDate): { from: BusinessDate; to: BusinessDate } {
  if (mode === 'day') {
    return { from: date, to: date };
  }

  if (mode === 'week') {
    const from = startOfWeek(date);

    return { from, to: addDays(from, 6) };
  }

  const from = startOfMonth(date);
  const { year, month } = businessDateToParts(from);

  return { from, to: businessDate(year, month, daysInMonth(year, month)) };
}

/** Шаг «назад» и «вперёд» по календарю: сутки, неделя или месяц. */
function shift(mode: CalendarMode, date: BusinessDate, direction: -1 | 1): BusinessDate {
  if (mode === 'day') {
    return addDays(date, direction);
  }

  if (mode === 'week') {
    return addDays(date, direction * 7);
  }

  return startOfMonth(addMonths(date, direction));
}

/**
 * Календарь ротаций (docs/04-MODULES/03-rotations.md, «Календарь»).
 *
 * Три режима — день, неделя, месяц. Админ правит расписание прямо здесь;
 * жилец видит то же самое в режиме чтения, и своя ротация помечена.
 */
export default async function RotationsPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; date?: string; house?: string }>;
}) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const { context } = session;

  if (!can(context, 'rotation.read', { houseId: context.houseId, userId: context.userId })) {
    redirect('/');
  }

  const t = await getTranslations('rotationCalendar');
  const actor: UserActor = { context };

  const params = await searchParams;
  const mode: CalendarMode = isMode(params.mode) ? params.mode : 'week';
  const anchor = tryParseBusinessDate(params.date ?? '') ?? todayInAlmaty();
  const range = rangeOf(mode, anchor);

  /*
   * Дом у админа свой, у жильца — из проживания, а суперадмин выбирает.
   * Без выбора он видел бы пустой календарь: своего дома у него нет —
   * и дом, у которого нет админа, вести было бы некому (указание владельца).
   */
  const houses = context.role === 'superadmin' ? await listHouses(context) : [];
  const selectedHouse = context.role === 'superadmin' ? (params.house ?? houses[0]?.id) : undefined;

  const calendar = await readCalendar(actor, range, {
    ...(selectedHouse === undefined ? {} : { houseId: selectedHouse }),
  });
  const canManage = can(context, 'rotation.manage', { houseId: calendar.houseId });

  const areaNames = new Map(calendar.dictionaries.areas.map((area) => [area.id, area.name]));
  const checklistTitles = new Map(
    calendar.dictionaries.checklists.map((checklist) => [checklist.id, checklist.title]),
  );
  const memberNames = new Map(
    calendar.dictionaries.members.map((member) => [member.userId, member.name]),
  );

  const cards: OccurrenceCard[] = calendar.occurrences.map((item) => ({
    occurrenceId: item.occurrence.id,
    date: item.occurrence.date,
    areaName: areaNames.get(item.occurrence.areaId) ?? '—',
    checklistTitle: checklistTitles.get(item.occurrence.checklistId) ?? '—',
    status: item.occurrence.status,
    type: item.occurrence.type,
    movedFromDate: item.occurrence.movedFromDate,
    assignments: item.assignments.map((assignment) => ({
      assignmentId: assignment.id,
      userId: assignment.userId,
      userName: assignment.userId === null ? null : (memberNames.get(assignment.userId) ?? '—'),
      state: assignment.state,
      isMine: assignment.userId === context.userId,
      score: assignment.score,
      note: assignment.note,
    })),
  }));

  const days = Array.from({ length: differenceInDays(range.from, range.to) + 1 }, (_, offset) =>
    addDays(range.from, offset),
  ).map((date) => ({
    date,
    occurrences: cards.filter((card) => card.date === date),
  }));

  const members: MemberOption[] = calendar.dictionaries.members;
  const zones: ZoneOption[] = calendar.dictionaries.checklists.map((checklist) => ({
    areaId: checklist.areaId,
    checklistId: checklist.id,
    label: `${areaNames.get(checklist.areaId) ?? '—'} · ${checklist.title}`,
  }));

  /*
   * Текст для группы собирается только в дневном режиме: §6.7 привязывает
   * кнопку «Шаблон» именно к дню, и на неделе непонятно, какой день копировать.
   * Генеральная уборка берёт свою шапку — у неё она настраивается отдельно.
   */
  const dayCards = mode === 'day' ? cards : [];
  const isGeneralDay = dayCards.some((card) => card.type === 'general');
  const template =
    mode === 'day' && calendar.houseId !== null
      ? await readTemplateText(
          actor,
          calendar.houseId,
          isGeneralDay ? 'general' : 'regular',
          await getLocale(),
        )
      : null;

  /** Выбранный дом держится в адресе: без него ссылки увели бы в чужой. */
  const houseQuery =
    houses.length > 1 && calendar.houseId !== null ? { house: calendar.houseId } : {};

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">
          {range.from} — {range.to}
        </p>
      </div>

      {houses.length > 1 && (
        <nav className="flex flex-wrap gap-2 text-[13px]">
          {houses.map((house) => (
            <AppLink
              className={
                house.id === calendar.houseId
                  ? 'text-text font-medium'
                  : 'text-text-muted hover:text-text'
              }
              data-testid={`house-${house.id}`}
              href={{ pathname: '/rotations', query: { house: house.id, mode, date: anchor } }}
              key={house.id}
            >
              {house.name}
            </AppLink>
          ))}
        </nav>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('view')}</CardTitle>
        </CardHeader>

        <div className="flex flex-wrap items-center gap-3 text-[13px]">
          {MODES.map((item) => (
            <AppLink
              className={item === mode ? 'font-medium' : 'text-accent underline'}
              data-testid={`mode-${item}`}
              href={{ pathname: '/rotations', query: { ...houseQuery, mode: item, date: anchor } }}
              key={item}
            >
              {t(`modes.${item}`)}
            </AppLink>
          ))}

          <span className="text-text-muted">·</span>

          <AppLink
            className="text-accent underline"
            data-testid="calendar-prev"
            href={{
              pathname: '/rotations',
              query: { ...houseQuery, mode, date: shift(mode, anchor, -1) },
            }}
          >
            {t('previous')}
          </AppLink>
          <AppLink
            className="text-accent underline"
            data-testid="calendar-today"
            href={{ pathname: '/rotations', query: { ...houseQuery, mode } }}
          >
            {t('today')}
          </AppLink>
          <AppLink className="text-accent underline" data-testid="to-stats" href="/rotations/stats">
            {t('toStats')}
          </AppLink>

          <AppLink
            className="text-accent underline"
            data-testid="calendar-next"
            href={{
              pathname: '/rotations',
              query: { ...houseQuery, mode, date: shift(mode, anchor, 1) },
            }}
          >
            {t('next')}
          </AppLink>
        </div>
      </Card>

      {template !== null && (
        <DayTemplate
          date={range.from}
          entries={dayCards
            .filter((card) => card.status !== 'cancelled')
            .map((card) => ({
              areaName: card.areaName,
              checklistTitle: card.checklistTitle,
              people: card.assignments
                .map((assignment) => assignment.userName)
                .filter((name): name is string => name !== null),
            }))}
          footer={template.footer}
          header={template.header}
        />
      )}

      <RotationCalendarView
        canManage={canManage}
        days={days}
        from={range.from}
        houseId={calendar.houseId}
        members={members}
        mode={mode}
        to={range.to}
        zones={zones}
      />
    </section>
  );
}
