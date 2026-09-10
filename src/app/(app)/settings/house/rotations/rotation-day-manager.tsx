'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';

import {
  previewRotationAction,
  saveNormAction,
  saveRosterAction,
  type RotationPreviewState,
  type RotationSetupActionState,
} from './actions';

import type { BedOption, ZoneOption } from './rotation-rows-manager';

const INITIAL: RotationSetupActionState = {};
const PREVIEW_INITIAL: RotationPreviewState = {};

export interface RosterVersionBlock {
  effectiveFrom: string;
  bedIds: string[];
}

export interface NormVersionBlock {
  effectiveFrom: string;
  zones: { areaId: string; checklistId: string; people: number }[];
}

export interface PreviewDayBlock {
  date: string;
  week: number;
  assignments: {
    areaId: string;
    userId: string | null;
    bedId: string | null;
    emptyReason: string | null;
  }[];
  resting: { bedId: string; userId: string | null }[];
}

export interface DayRowBlock {
  rowId: string;
  name: string;
  type: 'common' | 'room';
  weekday: number;
  startDate: string;
  /** Версии по возрастанию даты: последняя — действующая. */
  rosters: RosterVersionBlock[];
  norms: NormVersionBlock[];
  /** Предпросмотр по сохранённым версиям; кнопка пересчитывает его по черновику. */
  preview: PreviewDayBlock[];
}

export interface RotationDayManagerProps {
  rows: readonly DayRowBlock[];
  beds: readonly BedOption[];
  zones: readonly ZoneOption[];
  members: readonly { userId: string; name: string }[];
  /** Места дома, не попавшие ни в один состав. */
  bedsOutsideRows: readonly string[];
  bedsInSeveralRows: readonly { bedId: string; rowIds: string[] }[];
}

function Message({ state }: { state: RotationSetupActionState }) {
  const t = useTranslations();

  return (
    <>
      {state.error !== undefined && (
        <p className="text-danger text-[13px]" role="alert">
          {t(state.error)}
        </p>
      )}
      {state.done !== undefined && <p className="text-success text-[13px]">{t(state.done)}</p>}
      {state.rebuilt !== undefined && state.rebuilt > 0 && (
        <p className="text-text-muted text-[13px]">
          {t('rotationDaySetup.rebuilt', { count: state.rebuilt })}
        </p>
      )}
      {state.kept !== undefined && state.kept.length > 0 && (
        <p className="text-text-muted text-[13px]" data-testid="rebuild-kept">
          {t('rotationDaySetup.kept', { dates: state.kept.join(', ') })}
        </p>
      )}
    </>
  );
}

/** Обновление экрана после удачного сохранения — как в соседних менеджерах. */
function useRefreshOnDone(state: RotationSetupActionState): void {
  const router = useRouter();

  useEffect(() => {
    if (state.done !== undefined) {
      router.refresh();
    }
  }, [router, state]);
}

function DayRowCard({
  beds,
  members,
  row,
  warnings,
  zones,
}: {
  beds: readonly BedOption[];
  members: readonly { userId: string; name: string }[];
  row: DayRowBlock;
  warnings: readonly string[];
  zones: readonly ZoneOption[];
}) {
  const t = useTranslations('rotationDaySetup');
  // Дни недели и «дата первой ротации» уже названы в словаре рядов:
  // второй перевод тех же семи слов разошёлся бы с первым.
  const tRows = useTranslations('rotationRows');
  const [rosterState, saveRoster, isSavingRoster] = useActionState(saveRosterAction, INITIAL);
  const [normState, saveNorm, isSavingNorm] = useActionState(saveNormAction, INITIAL);
  const [previewState, preview, isPreviewing] = useActionState(
    previewRotationAction,
    PREVIEW_INITIAL,
  );

  useRefreshOnDone(rosterState);
  useRefreshOnDone(normState);

  const id = row.rowId;
  const currentRoster = row.rosters.at(-1);
  const currentNorm = row.norms.at(-1);

  const bedPosition = new Map(currentRoster?.bedIds.map((bedId, position) => [bedId, position]));
  const zonePosition = new Map(
    currentNorm?.zones.map((zone, position) => [`${zone.areaId}|${zone.checklistId}`, position]),
  );
  const zonePeople = new Map(
    currentNorm?.zones.map((zone) => [`${zone.areaId}|${zone.checklistId}`, zone.people]),
  );

  const bedLabel = new Map(beds.map((bed) => [bed.bedId, `${bed.areaName} · ${bed.label}`]));
  const areaName = new Map(zones.map((zone) => [zone.areaId, zone.areaName]));
  const memberName = new Map(members.map((member) => [member.userId, member.name]));

  // Комнатный ряд убирает свою комнату и берёт её же места (§6.4).
  const roomAreaId = row.type === 'room' ? (currentNorm?.zones[0]?.areaId ?? null) : null;
  const bedOptions = roomAreaId === null ? beds : beds.filter((bed) => bed.areaId === roomAreaId);
  const zoneOptions =
    row.type === 'room' ? zones.filter((zone) => zone.areaType === 'living') : zones;

  const days = previewState.preview ?? row.preview;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{row.name}</CardTitle>
      </CardHeader>

      <p className="text-text-muted mb-3 text-[13px]" data-testid={`day-row-meta-${id}`}>
        {tRows(`weekdays.${String(row.weekday)}`)} · {tRows('startDate')}: {row.startDate}
      </p>

      {warnings.length > 0 && (
        <p className="text-warning mb-3 text-[13px]" data-testid={`day-row-warning-${id}`}>
          {t('bedInSeveralRows', { beds: warnings.join(', ') })}
        </p>
      )}

      <form action={saveRoster} className="flex flex-col gap-4" data-testid={`day-form-${id}`}>
        <input name="rowId" type="hidden" value={id} />

        <div className="flex flex-col gap-4 md:flex-row md:gap-6">
          <fieldset className="flex min-w-0 flex-1 flex-col gap-2">
            <legend className="text-label mb-2">{t('roster')}</legend>

            <Field
              hint={t('effectiveFromHint')}
              htmlFor={`roster-from-${id}`}
              label={t('effectiveFrom')}
            >
              <Input
                data-testid={`roster-from-${id}`}
                defaultValue={currentRoster?.effectiveFrom ?? row.startDate}
                id={`roster-from-${id}`}
                name="rosterFrom"
                required
                type="date"
              />
            </Field>

            {bedOptions.map((bed) => (
              <label
                className="flex items-center justify-between gap-3 text-[13px]"
                key={bed.bedId}
              >
                <span className="truncate">
                  {bed.areaName} · {bed.label}
                </span>
                <Input
                  className="w-20"
                  data-testid={`roster-bed-${id}-${bed.bedId}`}
                  defaultValue={bedPosition.get(bed.bedId) ?? ''}
                  min={0}
                  name={`bed-${bed.bedId}`}
                  step={1}
                  type="number"
                />
              </label>
            ))}

            <Button
              className="self-start"
              data-testid={`roster-save-${id}`}
              disabled={isSavingRoster}
              size="sm"
              type="submit"
              variant="secondary"
            >
              {t('saveRoster')}
            </Button>

            <Message state={rosterState} />

            <p className="text-text-muted text-[13px]">
              {row.rosters.length === 0
                ? t('noVersions')
                : t('versions', {
                    list: row.rosters
                      .map((version) =>
                        t('rosterVersion', {
                          date: version.effectiveFrom,
                          count: version.bedIds.length,
                        }),
                      )
                      .join('; '),
                  })}
            </p>
          </fieldset>

          <fieldset className="flex min-w-0 flex-1 flex-col gap-2">
            <legend className="text-label mb-2">{t('norm')}</legend>

            <Field
              hint={t('effectiveFromHint')}
              htmlFor={`norm-from-${id}`}
              label={t('effectiveFrom')}
            >
              <Input
                data-testid={`norm-from-${id}`}
                defaultValue={currentNorm?.effectiveFrom ?? row.startDate}
                id={`norm-from-${id}`}
                name="normFrom"
                type="date"
              />
            </Field>

            {zoneOptions.map((zone) => {
              const key = `${zone.areaId}|${zone.checklistId}`;

              return (
                <div
                  className="flex items-center justify-between gap-3 text-[13px]"
                  data-testid={`norm-row-${id}-${zone.areaId}`}
                  key={key}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {zone.areaName} · {zone.checklistTitle}
                  </span>
                  <Input
                    aria-label={t('position')}
                    className="w-20"
                    data-testid={`norm-zone-${id}-${zone.areaId}`}
                    defaultValue={zonePosition.get(key) ?? ''}
                    min={0}
                    name={`zone-${key}`}
                    step={1}
                    type="number"
                  />
                  <Input
                    aria-label={t('people')}
                    className="w-20"
                    data-testid={`norm-people-${id}-${zone.areaId}`}
                    defaultValue={zonePeople.get(key) ?? zone.peopleNeeded}
                    min={1}
                    name={`people-${key}`}
                    step={1}
                    type="number"
                  />
                </div>
              );
            })}

            <Button
              className="self-start"
              data-testid={`norm-save-${id}`}
              disabled={isSavingNorm}
              formAction={saveNorm}
              size="sm"
              type="submit"
              variant="secondary"
            >
              {t('saveNorm')}
            </Button>

            <Message state={normState} />

            <p className="text-text-muted text-[13px]">
              {row.norms.length === 0
                ? t('noVersions')
                : t('versions', {
                    list: row.norms
                      .map((version) =>
                        t('normVersion', {
                          date: version.effectiveFrom,
                          count: version.zones.length,
                        }),
                      )
                      .join('; '),
                  })}
            </p>
          </fieldset>
        </div>

        <div className="border-border flex flex-col gap-2 border-t pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              data-testid={`preview-${id}`}
              disabled={isPreviewing}
              formAction={preview}
              size="sm"
              type="submit"
              variant="ghost"
            >
              {t('preview')}
            </Button>
            <span className="text-text-muted text-[13px]">{t('previewHint')}</span>
          </div>

          {previewState.error !== undefined && (
            <p className="text-danger text-[13px]" role="alert">
              {t(previewState.error)}
            </p>
          )}

          {days.length === 0 ? (
            <p className="text-text-muted text-[13px]" data-testid={`preview-empty-${id}`}>
              {t('previewEmpty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-3" data-testid={`preview-days-${id}`}>
              {days.map((day) => (
                <li className="flex flex-col gap-1" key={day.date}>
                  <span className="text-[13px] font-medium">
                    {day.date} <Badge tone="neutral">{t('week', { week: day.week })}</Badge>
                  </span>

                  {day.assignments.map((assignment, index) => (
                    <span
                      className="text-text-muted text-[13px]"
                      key={`${day.date}-${assignment.areaId}-${String(index)}`}
                    >
                      {areaName.get(assignment.areaId) ?? assignment.areaId}
                      {' — '}
                      {assignment.userId === null
                        ? t(`holes.${assignment.emptyReason ?? 'no_one'}`)
                        : (memberName.get(assignment.userId) ?? assignment.userId)}
                    </span>
                  ))}

                  {day.resting.length > 0 && (
                    <span className="text-text-muted text-[13px]">
                      {t('rest', {
                        names: day.resting
                          .map(
                            (slot) =>
                              (slot.userId === null ? null : memberName.get(slot.userId)) ??
                              bedLabel.get(slot.bedId) ??
                              slot.bedId,
                          )
                          .join(', '),
                      })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </form>
    </Card>
  );
}

/**
 * Составы рядов и нормы дней (план фазы 10, §5).
 *
 * Состав отвечает на вопрос «кто участвует», норма — «какие зоны убираются
 * и сколько человек на каждую». Обе правки версионируются датой вступления,
 * поэтому у каждой формы своя дата, а прошлые версии перечислены под ней.
 *
 * Предпросмотр стоит в той же форме намеренно: он считает по тому, что сейчас
 * в полях, а не по сохранённому, — иначе правку пришлось бы сохранять вслепую.
 */
export function RotationDayManager({
  beds,
  bedsInSeveralRows,
  bedsOutsideRows,
  members,
  rows,
  zones,
}: RotationDayManagerProps) {
  const t = useTranslations('rotationDaySetup');
  const bedLabel = new Map(beds.map((bed) => [bed.bedId, `${bed.areaName} · ${bed.label}`]));

  const outside = bedsOutsideRows.map((bedId) => bedLabel.get(bedId) ?? bedId);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2>{t('title')}</h2>
        <p className="text-text-muted text-[13px]">{t('hint')}</p>
      </div>

      {outside.length > 0 && (
        <p className="text-text-muted text-[13px]" data-testid="beds-outside-rows">
          {t('bedsOutside', { beds: outside.join(', ') })}
        </p>
      )}

      {rows.map((row) => (
        <DayRowCard
          beds={beds}
          key={row.rowId}
          members={members}
          row={row}
          warnings={bedsInSeveralRows
            .filter((warning) => warning.rowIds.includes(row.rowId))
            .map((warning) => bedLabel.get(warning.bedId) ?? warning.bedId)}
          zones={zones}
        />
      ))}
    </section>
  );
}
