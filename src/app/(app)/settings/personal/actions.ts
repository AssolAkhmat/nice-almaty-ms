'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from '@/lib/i18n/config';
import { AppError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { savePersonalSettings } from '@/services/settings';

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
