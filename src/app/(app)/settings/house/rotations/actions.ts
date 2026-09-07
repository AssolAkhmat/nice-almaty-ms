'use server';

import { headers } from 'next/headers';

import { AppError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import {
  archiveChecklist,
  createGroup,
  saveChecklist,
  setAreaEligibility,
  updateGroup,
} from '@/services/rotation-setup';

import type { UserActor } from '@/services/users';

/**
 * Настройка ротаций дома: чек-листы зон и группы допуска
 * (docs/04-MODULES/03-rotations.md, «Настройка»).
 */
export interface RotationSetupActionState {
  error?: string;
  done?: string;
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
  return { error: error instanceof AppError ? error.message : 'rotationSetup.errors.unknown' };
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
