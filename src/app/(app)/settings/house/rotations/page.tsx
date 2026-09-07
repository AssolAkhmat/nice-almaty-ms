import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { listHouses } from '@/db/repositories/houses';
import { parseEligibilityRule } from '@/domain/eligibility';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { addDays, todayInAlmaty } from '@/lib/time';
import { readRows } from '@/services/rotation-rows';
import { readSchedule } from '@/services/rotation-schedule';
import { readRotationSetup } from '@/services/rotation-setup';

import {
  RotationRowsManager,
  type BedOption,
  type RowBlock,
  type ZoneOption,
} from './rotation-rows-manager';
import { RotationSetupManager, type AreaBlock, type GroupRow } from './rotation-setup-manager';
import { ScheduleGenerator } from './schedule-generator';

import type { UserActor } from '@/services/users';

export const dynamic = 'force-dynamic';

/**
 * Чек-листы зон и группы допуска (docs/04-MODULES/03-rotations.md, «Настройка»).
 *
 * Отдельная страница внутри настроек дома: зоны и места уже занимают экран
 * целиком, а к ротациям сюда же добавятся ряды и шаблоны текста.
 */
export default async function RotationSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ house?: string }>;
}) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const { context } = session;

  // Раздел вне области видимости роли неотличим от несуществующего (P1-1).
  if (!can(context, 'settings.house.read', { houseId: context.houseId })) {
    redirect('/settings');
  }

  const t = await getTranslations('rotationSetup');
  const actor: UserActor = { context };

  const houses = context.role === 'superadmin' ? await listHouses(context) : [];
  const { house: requested } = await searchParams;

  const houseId =
    context.role === 'superadmin' ? (requested ?? houses[0]?.id ?? null) : context.houseId;

  if (houseId === null) {
    return (
      <section className="flex flex-col gap-6">
        <h1>{t('title')}</h1>
        <EmptyState description={t('noHouseHint')} title={t('noHouse')} />
      </section>
    );
  }

  const today = todayInAlmaty();
  // Горизонт по умолчанию — месяц вперёд: §6.6 требует расписание на месяц.
  const defaultUntil = addDays(today, 30);

  const [setup, rows, scheduled] = await Promise.all([
    readRotationSetup(actor, houseId),
    readRows(actor, houseId),
    readSchedule(actor, houseId, { from: today, to: defaultUntil }),
  ]);

  const areas: AreaBlock[] = setup.areas.map((area) => ({
    areaId: area.area.id,
    name: area.area.name,
    type: area.area.type,
    checklists: area.checklists.map((checklist) => ({
      checklistId: checklist.id,
      type: checklist.type,
      title: checklist.title,
      items: Array.isArray(checklist.items) ? (checklist.items as string[]) : [],
      peopleNeeded: checklist.peopleNeeded,
    })),
    eligibility: area.eligibility,
  }));

  const groups: GroupRow[] = setup.groups.map((group) => {
    const rule = parseEligibilityRule(group.rule);

    return {
      groupId: group.id,
      name: group.name,
      base: rule.base,
      areaId: rule.areaId,
      includeUserIds: rule.includeUserIds,
      excludeUserIds: rule.excludeUserIds,
    };
  });

  const areaNames = new Map(setup.areas.map((area) => [area.area.id, area.area.name]));

  const beds: BedOption[] = setup.beds.map((bed) => ({
    bedId: bed.id,
    label: bed.label,
    areaId: bed.areaId,
    areaName: areaNames.get(bed.areaId) ?? '',
  }));

  const zoneOptions: ZoneOption[] = setup.areas.flatMap((area) =>
    area.checklists.map((checklist) => ({
      areaId: area.area.id,
      areaName: area.area.name,
      areaType: area.area.type,
      checklistId: checklist.id,
      checklistTitle: checklist.title,
      peopleNeeded: checklist.peopleNeeded,
    })),
  );

  const rowBlocks: RowBlock[] = rows.map((view) => ({
    rowId: view.row.id,
    name: view.row.name,
    type: view.row.type,
    weekday: view.row.weekday,
    startDate: view.row.startDate,
    slots: view.slots.map((slot) => ({ bedId: slot.bedId, position: slot.position })),
    zones: view.zones.map((zone) => ({
      areaId: zone.areaId,
      checklistId: zone.checklistId,
      position: zone.position,
    })),
  }));

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">{setup.houseName}</p>
        <Link className="text-accent text-[13px] underline" href="/settings/house">
          {t('backToHouse')}
        </Link>
      </div>

      {houses.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('chooseHouse')}</CardTitle>
          </CardHeader>

          <div className="flex flex-wrap gap-3 text-[13px]">
            {houses.map((house) => (
              <Link
                className={house.id === houseId ? 'font-medium' : 'text-accent underline'}
                href={{ pathname: '/settings/house/rotations', query: { house: house.id } }}
                key={house.id}
              >
                {house.name}
              </Link>
            ))}
          </div>
        </Card>
      )}

      <RotationSetupManager
        areas={areas}
        groups={groups}
        houseId={houseId}
        members={setup.members.map((member) => ({ userId: member.userId, name: member.name }))}
      />

      <RotationRowsManager beds={beds} houseId={houseId} rows={rowBlocks} zones={zoneOptions} />

      <ScheduleGenerator
        defaultUntil={defaultUntil}
        houseId={houseId}
        scheduledCount={scheduled.length}
      />
    </section>
  );
}
