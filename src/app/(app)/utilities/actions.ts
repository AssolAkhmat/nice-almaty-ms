'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { actionErrorKey } from '@/lib/action-failure';
import { AppError, ConflictError, ValidationError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { parseMonthInput } from '@/domain/utilities';
import {
  addPeriodLine,
  closeUtilityPeriod,
  correctUtilityDays,
  openUtilityPeriod,
  previewDayCorrection,
  removePeriodLine,
  reopenUtilityPeriod,
  setHouseDays,
} from '@/services/utilities';
import { houseHistoryNames } from '@/services/residents';

import type { UserActor } from '@/services/users';

/** Коммунальный период: строки, закрытие, переоткрытие (модуль 6). */
export interface UtilityActionState {
  error?: string;
  done?: string;
  /** Пересчёт с подставленными сутками — до сохранения (P2-6). */
  preview?: {
    rows: readonly { userId: string; name: string; days: number; amount: number }[];
    surplus: number;
  };
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

function failure(error: unknown): UtilityActionState {
  if (error instanceof ValidationError || error instanceof ConflictError) {
    return { error: error.message };
  }

  if (error instanceof AppError) {
    return { error: `utilities.errors.${error.code}` };
  }

  return { error: actionErrorKey(error, 'utilities.errors.unknown') };
}

/** Доли уходят в счета, поэтому обновляется и раздел счетов. */
function refresh(): void {
  revalidatePath('/utilities');
  revalidatePath('/invoices', 'layout');
}

export async function openPeriodAction(
  _previous: UtilityActionState,
  formData: FormData,
): Promise<UtilityActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'utilities.errors.unauthorized' };
  }

  const month = parseMonthInput(text(formData, 'month'));
  if (month === null) {
    return { error: 'utilities.errors.month' };
  }

  try {
    await openUtilityPeriod(current, text(formData, 'houseId'), month);
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'utilities.done.opened' };
}

export async function addLineAction(
  _previous: UtilityActionState,
  formData: FormData,
): Promise<UtilityActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'utilities.errors.unauthorized' };
  }

  try {
    const receiptFileId = text(formData, 'receiptFileId');

    await addPeriodLine(current, text(formData, 'periodId'), {
      title: text(formData, 'title'),
      amount: Number(text(formData, 'amount')),
      receiptFileId: receiptFileId === '' ? null : receiptFileId,
    });
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'utilities.done.lineAdded' };
}

export async function removeLineAction(
  _previous: UtilityActionState,
  formData: FormData,
): Promise<UtilityActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'utilities.errors.unauthorized' };
  }

  try {
    await removePeriodLine(current, text(formData, 'lineId'));
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'utilities.done.lineRemoved' };
}

export async function closePeriodAction(
  _previous: UtilityActionState,
  formData: FormData,
): Promise<UtilityActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'utilities.errors.unauthorized' };
  }

  try {
    await closeUtilityPeriod(current, text(formData, 'periodId'));
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'utilities.done.closed' };
}

export async function reopenPeriodAction(
  _previous: UtilityActionState,
  formData: FormData,
): Promise<UtilityActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'utilities.errors.unauthorized' };
  }

  try {
    await reopenUtilityPeriod(current, text(formData, 'periodId'));
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'utilities.done.reopened' };
}

/**
 * Корректировка суток: пересчёт и сохранение одной формой (P2-6).
 *
 * Кнопка «Пересчитать» показывает последствия до записи, кнопка «Сохранить»
 * пишет. Считает оба раза один и тот же сервис — предпросмотр не имеет
 * своей арифметики, иначе он однажды покажет не то, что сохранится.
 */
export async function correctDaysAction(
  _previous: UtilityActionState,
  formData: FormData,
): Promise<UtilityActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'utilities.errors.unauthorized' };
  }

  const periodId = text(formData, 'periodId');
  const userId = text(formData, 'userId');
  const raw = text(formData, 'days');
  const days = raw === '' ? Number.NaN : Number(raw);
  const comment = text(formData, 'comment');
  const confirmIncrease = formData.get('confirmIncrease') !== null;

  if (text(formData, 'intent') === 'preview') {
    try {
      const preview = await previewDayCorrection(current, periodId, { userId, days });
      const names = await houseHistoryNames(
        current,
        preview.period.houseId,
        preview.distribution.allocations.map((row) => row.userId),
      );

      return {
        preview: {
          rows: preview.distribution.allocations.map((row) => ({
            userId: row.userId,
            name: names.get(row.userId)?.trim() ?? '',
            days: row.days,
            amount: row.amount,
          })),
          surplus: preview.distribution.surplus,
        },
      };
    } catch (error) {
      return failure(error);
    }
  }

  try {
    await correctUtilityDays(current, { periodId, userId, days, comment, confirmIncrease });
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'utilities.done.daysCorrected' };
}

/**
 * Доля дома в человеко-днях (P2-7). Ноль убирает долю целиком, поэтому
 * причина обязательна только при ненулевом значении.
 */
export async function setHouseDaysAction(
  _previous: UtilityActionState,
  formData: FormData,
): Promise<UtilityActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'utilities.errors.unauthorized' };
  }

  const raw = text(formData, 'houseDays');

  try {
    await setHouseDays(current, text(formData, 'periodId'), {
      days: raw === '' ? 0 : Number(raw),
      comment: text(formData, 'comment'),
    });
  } catch (error) {
    return failure(error);
  }

  refresh();

  return { done: 'utilities.done.houseDaysSet' };
}
