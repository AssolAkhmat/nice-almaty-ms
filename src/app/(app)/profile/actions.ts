'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { AppError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { subscribeToPush, unsubscribeFromPush } from '@/services/notifications';
import {
  revealSensitiveField,
  saveProfile,
  type SensitiveField,
} from '@/services/resident-profiles';

export interface ProfileActionState {
  error?: string;
  done?: string;
}

export interface PushActionState {
  error?: string;
  done?: string;
}

/**
 * Подписка браузера на push. Адресат берётся из сессии, а не из запроса:
 * иначе один браузер подписался бы на уведомления другого человека (P6-3).
 */
export async function subscribePushAction(formData: FormData): Promise<PushActionState> {
  const session = await getCurrentSession();

  if (session === null) {
    return { error: 'notifications.errors.subscription' };
  }

  const endpoint = text(formData, 'endpoint');
  const p256dh = text(formData, 'p256dh');
  const auth = text(formData, 'auth');
  const userAgent = optionalText(formData, 'userAgent');

  if (endpoint === '' || p256dh === '' || auth === '') {
    return { error: 'notifications.errors.subscription' };
  }

  try {
    await subscribeToPush(session.context, {
      endpoint,
      p256dh,
      auth,
      ...(userAgent === null ? {} : { userAgent }),
    });
    revalidatePath('/profile');

    return { done: 'notifications.push.enabled' };
  } catch (error) {
    return {
      error: error instanceof AppError ? error.message : 'notifications.errors.subscription',
    };
  }
}

export async function unsubscribePushAction(formData: FormData): Promise<PushActionState> {
  const session = await getCurrentSession();

  if (session === null) {
    return { error: 'notifications.errors.subscription' };
  }

  const endpoint = text(formData, 'endpoint');

  if (endpoint === '') {
    return { error: 'notifications.errors.subscription' };
  }

  try {
    await unsubscribeFromPush(session.context, endpoint);
    revalidatePath('/profile');

    return { done: 'notifications.push.disabled' };
  } catch (error) {
    return {
      error: error instanceof AppError ? error.message : 'notifications.errors.subscription',
    };
  }
}

export interface RevealState {
  error?: string;
  field?: SensitiveField;
  value?: string;
}

function text(formData: FormData, name: string): string {
  const value = formData.get(name);

  return typeof value === 'string' ? value.trim() : '';
}

function optionalText(formData: FormData, name: string): string | null {
  const value = text(formData, name);

  return value === '' ? null : value;
}

async function actor() {
  const session = await getCurrentSession();
  if (session === null) {
    return null;
  }

  const store = await headers();

  return {
    session,
    actor: {
      context: session.context,
      ip: store.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined,
    },
  };
}

export async function saveProfileAction(
  _previous: ProfileActionState,
  formData: FormData,
): Promise<ProfileActionState> {
  const current = await actor();
  if (current === null) {
    return { error: 'profile.errors.unauthorized' };
  }

  const sex = text(formData, 'sex');
  const payment = text(formData, 'preferredPayment');
  const course = text(formData, 'course');

  try {
    await saveProfile(current.actor, current.session.user.id, {
      lastName: optionalText(formData, 'lastName'),
      firstName: optionalText(formData, 'firstName'),
      middleName: optionalText(formData, 'middleName'),
      sex: sex === 'male' || sex === 'female' ? sex : null,
      birthDate: optionalText(formData, 'birthDate'),
      phone: optionalText(formData, 'phone'),
      university: optionalText(formData, 'university'),
      course: course === '' ? null : Number(course),
      major: optionalText(formData, 'major'),
      emergencyName: optionalText(formData, 'emergencyName'),
      emergencyPhone: optionalText(formData, 'emergencyPhone'),
      emergencyRelation: optionalText(formData, 'emergencyRelation'),
      preferredPayment: payment === 'kaspi' || payment === 'cash' ? payment : null,
      noEpilepsy: formData.get('noEpilepsy') !== null,
      noAsthma: formData.get('noAsthma') !== null,
      ...(text(formData, 'iin') === '' ? {} : { iin: text(formData, 'iin') }),
      ...(text(formData, 'idDocNumber') === ''
        ? {}
        : { idDocNumber: text(formData, 'idDocNumber') }),
    });

    revalidatePath('/profile');

    return { done: 'profile.done.saved' };
  } catch (error) {
    if (error instanceof AppError) {
      return { error: `profile.errors.${error.code}` };
    }

    throw error;
  }
}

/**
 * Раскрытие полного значения. Каждое обращение пишется в журнал —
 * это требование §11, а не мера предосторожности на всякий случай.
 */
export async function revealAction(
  _previous: RevealState,
  formData: FormData,
): Promise<RevealState> {
  const current = await actor();
  if (current === null) {
    return { error: 'profile.errors.unauthorized' };
  }

  const field = text(formData, 'field');
  if (field !== 'iin' && field !== 'idDocNumber') {
    return { error: 'profile.errors.validation_error' };
  }

  try {
    const value = await revealSensitiveField(current.actor, current.session.user.id, field);

    return { field, value };
  } catch (error) {
    if (error instanceof AppError) {
      return { error: `profile.errors.${error.code}` };
    }

    throw error;
  }
}
