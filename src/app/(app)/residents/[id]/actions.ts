'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { AppError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { changeAccountRole } from '@/services/users';

import type { UserActor } from '@/services/users';

/** Смена роли отдельным действием (модуль 1, долг фазы 1). */
export interface RoleActionState {
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

export async function changeRoleAction(
  _previous: RoleActionState,
  formData: FormData,
): Promise<RoleActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'residents.errors.unauthorized' };
  }

  const role = text(formData, 'role');
  if (role !== 'resident' && role !== 'admin') {
    return { error: 'residents.errors.role' };
  }

  const houseId = text(formData, 'houseId');

  try {
    await changeAccountRole(
      current,
      text(formData, 'userId'),
      role,
      houseId === '' ? null : houseId,
    );
  } catch (error) {
    return {
      error: error instanceof AppError ? error.message : 'residents.errors.unknown',
    };
  }

  revalidatePath('/residents');

  return { done: 'residents.roleChanged' };
}
