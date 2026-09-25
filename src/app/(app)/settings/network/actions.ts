'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { AppError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { isAdminCapability } from '@/lib/permissions';
import { setAdminCapability } from '@/services/permissions';
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

/**
 * Переключатель полномочия админа (указание владельца, 23 сентября 2026).
 *
 * Каждый переключатель — своя отправка формы: сохранять их вместе с языком
 * и видимостью рейтинга значило бы менять права заодно с настройками вида.
 */
export async function setCapabilityAction(
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

  const capability = formData.get('capability');

  if (typeof capability !== 'string' || !isAdminCapability(capability)) {
    return { error: 'settings.errors.validation_error' };
  }

  try {
    await setAdminCapability(actor, capability, formData.get('enabled') === '1');

    revalidatePath('/settings/network');

    return { done: 'settings.done.capabilitySaved' };
  } catch (error) {
    if (error instanceof AppError) {
      return { error: `settings.errors.${error.code}` };
    }

    throw error;
  }
}

/**
 * Подпись исполнителя в договоре (указание владельца, 22 сентября 2026).
 *
 * Сохраняется идентификатор уже загруженного файла: сама загрузка идёт
 * двухшаговой сессией, как у подписи жильца (D4). Подписанные договоры
 * держат свою копию снимком и от смены не меняются.
 */
export async function saveOwnerSignatureAction(
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

  const fileId = formData.get('fileId');

  if (typeof fileId !== 'string' || fileId === '') {
    return { error: 'settings.errors.validation_error' };
  }

  try {
    await writeOrgSetting(actor, ORG_SETTINGS.ownerSignatureFileId.key, fileId);

    revalidatePath('/settings/network');
    /* Договор собирается с подписью исполнителя — обновляется и он. */
    revalidatePath('/contract', 'layout');

    return { done: 'settings.done.ownerSignatureSaved' };
  } catch (error) {
    if (error instanceof AppError) {
      return { error: `settings.errors.${error.code}` };
    }

    throw error;
  }
}

/**
 * Приветственное сообщение новому жильцу (указание владельца,
 * 25 сентября 2026). Пустое поле означает «вернуть текст по умолчанию»:
 * в настройке остаётся пусто, и экран берёт текст из словаря.
 */
export async function saveWelcomeMessageAction(
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

  const raw = formData.get('message');
  const message = typeof raw === 'string' ? raw.trim() : '';

  try {
    await writeOrgSetting(actor, ORG_SETTINGS.welcomeMessage.key, message === '' ? null : message);

    revalidatePath('/settings/network');
    revalidatePath('/settings/users');

    return { done: 'settings.done.welcomeSaved' };
  } catch (error) {
    if (error instanceof AppError) {
      return { error: `settings.errors.${error.code}` };
    }

    throw error;
  }
}
