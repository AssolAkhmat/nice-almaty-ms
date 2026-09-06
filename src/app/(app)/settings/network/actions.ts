'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { AppError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { ORG_SETTINGS, writeOrgSetting } from '@/services/settings';

export interface NetworkActionState {
  error?: string;
  done?: string;
}

export async function saveNetworkSettingsAction(
  _previous: NetworkActionState,
  formData: FormData,
): Promise<NetworkActionState> {
  const session = await getCurrentSession();
  if (session === null) {
    return { error: 'settings.errors.unauthorized' };
  }

  const store = await headers();
  const actor = {
    context: session.context,
    ip: store.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined,
  };

  try {
    // Отсутствие чекбокса в форме означает «выключено», а не «не менялось».
    await writeOrgSetting(
      actor,
      ORG_SETTINGS.ratingVisibleToResidents.key,
      formData.get('ratingVisibleToResidents') !== null,
    );

    const locale = formData.get('defaultLocale');
    if (typeof locale === 'string') {
      await writeOrgSetting(actor, ORG_SETTINGS.defaultLocale.key, locale);
    }

    revalidatePath('/settings/network');

    return { done: 'settings.done.networkSaved' };
  } catch (error) {
    if (error instanceof AppError) {
      return { error: `settings.errors.${error.code}` };
    }

    throw error;
  }
}
