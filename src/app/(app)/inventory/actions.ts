'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { AppError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { consumeItem, receiveItem, transferItem } from '@/services/inventory';
import { closeInventoryAudit, saveAuditFact, startAudit } from '@/services/inventory-audit';

import type { UserActor } from '@/services/users';

/**
 * Инвентарь (docs/04-MODULES/10-accounting-inventory.md, «Инвентарь»).
 *
 * Права проверяет сервис: экран их не дублирует и не обходит. Ошибки
 * возвращаются ключом словаря — сообщение выбирает язык читающего.
 */
export interface InventoryActionState {
  error?: string;
  done?: string;
  /** Сколько строк скорректировало закрытие ведомости. */
  adjusted?: number;
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

function failure(error: unknown): InventoryActionState {
  return { error: error instanceof AppError ? error.message : 'inventory.errors.unknown' };
}

function refresh(): void {
  revalidatePath('/inventory');
}

export async function receiveAction(
  _previous: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  const user = await actor();

  if (user === null) {
    return { error: 'inventory.errors.unknown' };
  }

  try {
    await receiveItem(user, {
      houseId: text(formData, 'houseId'),
      name: text(formData, 'name'),
      unit: text(formData, 'unit'),
      unitCost: Number(text(formData, 'unitCost') || '0'),
      qty: text(formData, 'qty'),
      ...(text(formData, 'note') === '' ? {} : { note: text(formData, 'note') }),
    });
    refresh();

    return { done: 'inventory.added' };
  } catch (error) {
    return failure(error);
  }
}

export async function consumeAction(
  _previous: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  const user = await actor();

  if (user === null) {
    return { error: 'inventory.errors.unknown' };
  }

  const type = text(formData, 'type') === 'write_off' ? 'write_off' : 'out';

  try {
    await consumeItem(user, text(formData, 'itemId'), { qty: text(formData, 'qty'), type });
    refresh();

    return { done: 'inventory.consumed' };
  } catch (error) {
    return failure(error);
  }
}

export async function transferAction(
  _previous: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  const user = await actor();

  if (user === null) {
    return { error: 'inventory.errors.unknown' };
  }

  try {
    await transferItem(user, text(formData, 'itemId'), text(formData, 'toHouseId'));
    refresh();

    return { done: 'inventory.transferred' };
  } catch (error) {
    return failure(error);
  }
}

export async function startAuditAction(
  _previous: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  const user = await actor();

  if (user === null) {
    return { error: 'inventory.errors.unknown' };
  }

  try {
    await startAudit(user, text(formData, 'houseId'));
    refresh();

    return { done: 'inventory.auditTitle' };
  } catch (error) {
    return failure(error);
  }
}

export async function saveAuditLineAction(
  _previous: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  const user = await actor();

  if (user === null) {
    return { error: 'inventory.errors.unknown' };
  }

  const actual = text(formData, 'actualQty');

  try {
    await saveAuditFact(user, text(formData, 'auditId'), text(formData, 'itemId'), {
      actualQty: actual === '' ? null : actual,
      comment: text(formData, 'comment'),
    });
    refresh();

    return { done: 'inventory.saved' };
  } catch (error) {
    return failure(error);
  }
}

export async function closeAuditAction(
  _previous: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  const user = await actor();

  if (user === null) {
    return { error: 'inventory.errors.unknown' };
  }

  try {
    const result = await closeInventoryAudit(user, text(formData, 'auditId'));
    refresh();

    return { done: 'inventory.auditClosed', adjusted: result.adjusted };
  } catch (error) {
    return failure(error);
  }
}
