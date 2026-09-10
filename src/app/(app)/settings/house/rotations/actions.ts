'use server';

import { headers } from 'next/headers';

import { actionErrorKey } from '@/lib/action-failure';
import { getCurrentSession } from '@/lib/session';
import { generateGeneralCleaning, setCancelRegularOnGeneral } from '@/services/general-cleaning';
import {
  previewRotationDays,
  saveNorm,
  saveRoster,
  type PreviewDay,
  type SaveNormZoneInput,
  type VersionSaveReport,
} from '@/services/rotation-day-setup';
import { archiveRow, saveRow } from '@/services/rotation-rows';
import { saveTemplateText } from '@/services/rotation-templates';
import { generateSchedule } from '@/services/rotation-schedule';
import {
  archiveChecklist,
  createGroup,
  saveChecklist,
  setAreaEligibility,
  updateGroup,
} from '@/services/rotation-setup';

import { getLocale } from 'next-intl/server';

import { todayInAlmaty, tryParseBusinessDate } from '@/lib/time';

import type { UserActor } from '@/services/users';

/**
 * Настройка ротаций дома: чек-листы зон и группы допуска
 * (docs/04-MODULES/03-rotations.md, «Настройка»).
 */
export interface RotationSetupActionState {
  error?: string;
  done?: string;
  /** Отчёт о пересборке будущих занятий после правки «с даты» (§2.6). */
  rebuilt?: number;
  /** Занятия, которых пересборка не коснулась: их правил человек. */
  kept?: string[];
}

async function actor(): Promise<UserActor | null> {
  const session = await getCurrentSession();
  if (session === null) {
    return null;
  }

  const store = await headers();

  return {
    context: session.context,
    ip: store.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined,
  };
}

function text(formData: FormData, name: string): string {
  const value = formData.get(name);

  return typeof value === 'string' ? value.trim() : '';
}

function list(formData: FormData, name: string): string[] {
  return formData
    .getAll(name)
    .filter((value): value is string => typeof value === 'string')
    .filter((value) => value !== '');
}

/** Пункты приходят строками textarea: одна строка — один пункт. */
function lines(formData: FormData, name: string): string[] {
  return text(formData, name)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function number(formData: FormData, name: string): number {
  return Number(text(formData, name));
}

function failure(error: unknown): RotationSetupActionState {
  return { error: actionErrorKey(error, 'rotationSetup.errors.unknown') };
}

/*
 * Обновление экрана после действия делает клиент — `useRefreshOnDone`
 * в `rotation-setup-manager`.
 *
 * `revalidatePath` тут не годится ни в каком виде. Раздел открывается
 * по ссылке `?house=<id>`, а кеш маршрутизатора ключуется вместе
 * с параметрами запроса: запись с ними не сбрасывается ни путём,
 * ни путём с типом `page`. Сброс всего кеша (`'/', 'layout'`) экран
 * обновляет, но перерисовывает дерево целиком, и следующее действие
 * подвисает на этой перерисовке.
 */
function refresh(): void {
  // Ничего: обновление делает клиент по завершении действия.
}

export async function saveChecklistAction(
  _previous: RotationSetupActionState,
  formData: FormData,
): Promise<RotationSetupActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationSetup.errors.unknown' };
  }

  const type = text(formData, 'type');

  try {
    await saveChecklist(user, {
      areaId: text(formData, 'areaId'),
      type: type === 'general' ? 'general' : 'regular',
      title: text(formData, 'title'),
      items: lines(formData, 'items'),
      peopleNeeded: number(formData, 'peopleNeeded'),
    });
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'rotationSetup.saved' };
}

export async function archiveChecklistAction(
  _previous: RotationSetupActionState,
  formData: FormData,
): Promise<RotationSetupActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationSetup.errors.unknown' };
  }

  try {
    await archiveChecklist(user, text(formData, 'checklistId'));
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'rotationSetup.archived' };
}

/** Правило группы собирается из полей формы: основа, комната и два списка. */
function ruleFrom(formData: FormData): unknown {
  const base = text(formData, 'base');
  const areaId = text(formData, 'ruleAreaId');

  return {
    base,
    areaId: areaId === '' ? null : areaId,
    includeUserIds: list(formData, 'includeUserIds'),
    excludeUserIds: list(formData, 'excludeUserIds'),
  };
}

export async function saveGroupAction(
  _previous: RotationSetupActionState,
  formData: FormData,
): Promise<RotationSetupActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationSetup.errors.unknown' };
  }

  const groupId = text(formData, 'groupId');

  try {
    if (groupId === '') {
      await createGroup(user, {
        houseId: text(formData, 'houseId'),
        name: text(formData, 'name'),
        rule: ruleFrom(formData),
      });
    } else {
      await updateGroup(user, groupId, {
        name: text(formData, 'name'),
        rule: ruleFrom(formData),
      });
    }
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'rotationSetup.saved' };
}

export async function setEligibilityAction(
  _previous: RotationSetupActionState,
  formData: FormData,
): Promise<RotationSetupActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationSetup.errors.unknown' };
  }

  const type = text(formData, 'checklistType');

  try {
    await setAreaEligibility(user, {
      areaId: text(formData, 'areaId'),
      checklistType: type === 'general' ? 'general' : 'regular',
      groupIds: list(formData, 'groupIds'),
    });
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'rotationSetup.saved' };
}

/**
 * Порядок в ряду задаётся числом у каждого места и каждой зоны: пусто —
 * не входит в ряд. Перетаскивания здесь нет намеренно — ряд собирают
 * редко, а число видно и на узком экране.
 */
function ordered<T>(
  formData: FormData,
  prefix: string,
  build: (key: string) => T,
): { position: number; value: T }[] {
  const picked: { position: number; value: T }[] = [];

  for (const [name, raw] of formData.entries()) {
    if (!name.startsWith(prefix) || typeof raw !== 'string' || raw.trim() === '') {
      continue;
    }

    const position = Number(raw);
    if (!Number.isFinite(position)) {
      continue;
    }

    picked.push({ position, value: build(name.slice(prefix.length)) });
  }

  return picked.sort((left, right) => left.position - right.position);
}

export async function saveRowAction(
  _previous: RotationSetupActionState,
  formData: FormData,
): Promise<RotationSetupActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationSetup.errors.unknown' };
  }

  const rowId = text(formData, 'rowId');
  const type = text(formData, 'type');

  // Дата приходит из поля ввода: незаполненная или битая должна назваться
  // сама, а не превратиться в «не получилось сохранить».
  const startDate = tryParseBusinessDate(text(formData, 'startDate'));
  if (startDate === null) {
    return { error: 'rotationRows.errors.startDateInvalid' };
  }

  const slots = ordered(formData, 'slot-', (bedId) => ({ bedId })).map((item) => item.value);
  const zones = ordered(formData, 'zone-', (key) => {
    const [areaId = '', checklistId = ''] = key.split('|');

    return { areaId, checklistId };
  }).map((item) => item.value);

  try {
    await saveRow(user, {
      ...(rowId === '' ? {} : { rowId }),
      houseId: text(formData, 'houseId'),
      name: text(formData, 'name'),
      type: type === 'room' ? 'room' : 'common',
      weekday: Number(text(formData, 'weekday')),
      startDate,
      slots,
      zones,
    });
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'rotationSetup.saved' };
}

export async function archiveRowAction(
  _previous: RotationSetupActionState,
  formData: FormData,
): Promise<RotationSetupActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationSetup.errors.unknown' };
  }

  try {
    await archiveRow(user, text(formData, 'rowId'));
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'rotationSetup.rowArchived' };
}

export async function generateScheduleAction(
  _previous: RotationSetupActionState,
  formData: FormData,
): Promise<RotationSetupActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationSetup.errors.unknown' };
  }

  const until = tryParseBusinessDate(text(formData, 'until'));
  if (until === null) {
    return { error: 'rotationSchedule.errors.untilInvalid' };
  }

  let created = 0;

  try {
    ({ created } = await generateSchedule(user, text(formData, 'houseId'), until));
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: created === 0 ? 'rotationSchedule.nothingNew' : 'rotationSchedule.generated' };
}

export async function planGeneralCleaningAction(
  _previous: RotationSetupActionState,
  formData: FormData,
): Promise<RotationSetupActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationSetup.errors.unknown' };
  }

  const date = tryParseBusinessDate(text(formData, 'date'));
  if (date === null) {
    return { error: 'generalCleaning.errors.dateInvalid' };
  }

  let created = 0;

  try {
    ({ created } = await generateGeneralCleaning(user, text(formData, 'houseId'), date));
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: created === 0 ? 'generalCleaning.nothingNew' : 'generalCleaning.planned' };
}

export async function setCancelRegularAction(
  _previous: RotationSetupActionState,
  formData: FormData,
): Promise<RotationSetupActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationSetup.errors.unknown' };
  }

  try {
    await setCancelRegularOnGeneral(
      user,
      text(formData, 'houseId'),
      text(formData, 'cancelRegular') === 'on',
    );
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'generalCleaning.settingSaved' };
}

export async function saveTemplateAction(
  _previous: RotationSetupActionState,
  formData: FormData,
): Promise<RotationSetupActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationSetup.errors.unknown' };
  }

  const type = text(formData, 'type') === 'general' ? 'general' : 'regular';
  const locale = await getLocale();

  try {
    await saveTemplateText(user, text(formData, 'houseId'), type, locale, {
      header: text(formData, 'header'),
      footer: text(formData, 'footer'),
    });
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'rotationTemplates.saved' };
}

/**
 * Состав ряда и норма дня (план фазы 10, §2.2, §2.3, §5).
 *
 * Все три действия читают одну и ту же форму: у ряда состав, норма
 * и предпросмотр стоят рядом, и человеку не приходится переписывать
 * черновик из одной формы в другую, чтобы посмотреть, что выйдет.
 */
function draftBedIds(formData: FormData): string[] {
  return ordered(formData, 'bed-', (bedId) => bedId).map((item) => item.value);
}

function draftZones(formData: FormData): SaveNormZoneInput[] {
  return ordered(formData, 'zone-', (key) => {
    const [areaId = '', checklistId = ''] = key.split('|');
    const people = Number(text(formData, `people-${key}`));

    return {
      areaId,
      checklistId,
      ...(Number.isFinite(people) && people > 0 ? { people } : {}),
    };
  }).map((item) => item.value);
}

/**
 * Отчёт о пересборке для экрана: сколько занятий заведено заново и какие
 * даты остались как были, потому что их правил человек (§2.6).
 */
function report(result: VersionSaveReport): Pick<RotationSetupActionState, 'rebuilt' | 'kept'> {
  return {
    rebuilt: result.rebuilt,
    kept: result.kept.map((item) => item.date),
  };
}

export async function saveRosterAction(
  _previous: RotationSetupActionState,
  formData: FormData,
): Promise<RotationSetupActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationSetup.errors.unknown' };
  }

  const effectiveFrom = tryParseBusinessDate(text(formData, 'rosterFrom'));
  if (effectiveFrom === null) {
    return { error: 'rotationDaySetup.errors.effectiveInvalid' };
  }

  try {
    const result = await saveRoster(user, {
      rowId: text(formData, 'rowId'),
      effectiveFrom,
      bedIds: draftBedIds(formData),
    });

    return { done: 'rotationDaySetup.rosterSaved', ...report(result) };
  } catch (error) {
    return failure(error);
  }
}

export async function saveNormAction(
  _previous: RotationSetupActionState,
  formData: FormData,
): Promise<RotationSetupActionState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationSetup.errors.unknown' };
  }

  const effectiveFrom = tryParseBusinessDate(text(formData, 'normFrom'));
  if (effectiveFrom === null) {
    return { error: 'rotationDaySetup.errors.effectiveInvalid' };
  }

  try {
    const result = await saveNorm(user, {
      rowId: text(formData, 'rowId'),
      effectiveFrom,
      zones: draftZones(formData),
    });

    return { done: 'rotationDaySetup.normSaved', ...report(result) };
  } catch (error) {
    return failure(error);
  }
}

export interface RotationPreviewState {
  error?: string;
  preview?: PreviewDay[];
}

export async function previewRotationAction(
  _previous: RotationPreviewState,
  formData: FormData,
): Promise<RotationPreviewState> {
  const user = await actor();
  if (user === null) {
    return { error: 'rotationSetup.errors.unknown' };
  }

  const rosterFrom = tryParseBusinessDate(text(formData, 'rosterFrom'));
  const normFrom = tryParseBusinessDate(text(formData, 'normFrom'));
  const bedIds = draftBedIds(formData);
  const zones = draftZones(formData);

  try {
    const preview = await previewRotationDays(user, {
      rowId: text(formData, 'rowId'),
      from: todayInAlmaty(),
      // Черновик кладётся только заполненный: пустая форма означает
      // «покажи, как есть», а не «ряд остался без состава».
      ...(rosterFrom === null || bedIds.length === 0
        ? {}
        : { draftRoster: { effectiveFrom: rosterFrom, bedIds } }),
      ...(normFrom === null || zones.length === 0
        ? {}
        : { draftNorm: { effectiveFrom: normFrom, zones } }),
    });

    return { preview };
  } catch (error) {
    return failure(error);
  }
}
