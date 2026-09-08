'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from '@/lib/i18n/config';
import { AppError, ConflictError, ValidationError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { savePersonalSettings } from '@/services/settings';
import { changeAccountPhone } from '@/services/users';

export interface PersonalActionState {
  error?: string;
  done?: string;
}

function textField(formData: FormData, name: string): string {
  const value = formData.get(name);

  return typeof value === 'string' ? value : '';
}

export async function savePersonalSettingsAction(
  _previous: PersonalActionState,
  formData: FormData,
): Promise<PersonalActionState> {
  const session = await getCurrentSession();
  if (session === null) {
    return { error: 'settings.errors.unauthorized' };
  }

  try {
    const updated = await savePersonalSettings(
      { context: session.context },
      { locale: textField(formData, 'locale'), theme: textField(formData, 'theme') },
    );

    /*
     * Cookie обновляется вслед за профилем: она остаётся запасным путём
     * для анонимных страниц вроде экрана входа, где сессии уже нет.
     */
    const store = await cookies();
    store.set(LOCALE_COOKIE, updated.locale, {
      maxAge: LOCALE_COOKIE_MAX_AGE,
      path: '/',
      sameSite: 'lax',
    });

    revalidatePath('/', 'layout');

    return { done: 'settings.done.personalSaved' };
  } catch (error) {
    if (error instanceof AppError) {
      return { error: `settings.errors.${error.code}` };
    }

    throw error;
  }
}

/**
 * Смена собственного номера (T9.7): новый номер и действующий пароль.
 * Cookie сессии не трогается — сменился логин, а не его владелец.
 */
export async function changeOwnPhoneAction(
  _previous: PersonalActionState,
  formData: FormData,
): Promise<PersonalActionState> {
  const session = await getCurrentSession();
  if (session === null) {
    return { error: 'settings.errors.unauthorized' };
  }

  try {
    await changeAccountPhone({ context: session.context }, session.user.id, {
      phone: textField(formData, 'phone'),
      currentPassword: textField(formData, 'currentPassword'),
    });

    revalidatePath('/settings/personal');

    return { done: 'settings.done.phoneChanged' };
  } catch (error) {
    if (error instanceof ValidationError && error.details?.field === 'currentPassword') {
      return { error: 'settings.errors.wrongPassword' };
    }

    if (error instanceof ConflictError) {
      return { error: 'settings.errors.phoneTaken' };
    }

    if (error instanceof AppError) {
      return { error: `settings.errors.${error.code}` };
    }

    throw error;
  }
}
