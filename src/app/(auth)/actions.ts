'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuthProvider } from '@/adapters/auth';
import { AppError } from '@/lib/errors';
import { newRequestId, requestLogger } from '@/lib/logger';
import { verifyPassword } from '@/lib/password';
import { passwordSchema } from '@/lib/validation/password';
import {
  clearSessionCookie,
  getCurrentSession,
  readSessionToken,
  setSessionCookie,
} from '@/lib/session';
import { AUDIT_ACTIONS, recordAudit } from '@/services/audit';
import { getDb } from '@/db/client';
import { signIn, signOut } from '@/services/auth';

/**
 * Server actions входа. Тот же сервисный слой используют обработчики
 * `/api/v1`, логика не дублируется (docs/06-API.md).
 *
 * Наружу отдаётся код ошибки, а не текст: перевод подставляет интерфейс.
 */
export interface AuthFormState {
  /** Ключ i18n под `auth.errors` или `validation`. */
  error?: string;
  /** Секунды до следующей попытки, если сработало ограничение частоты. */
  retryAfterSeconds?: number;
}

/** FormData отдаёт строку или файл; поле формы, разумеется, строка. */
function textField(formData: FormData, name: string): string {
  const value = formData.get(name);

  return typeof value === 'string' ? value : '';
}

async function clientIp(): Promise<string | undefined> {
  const store = await headers();
  const forwarded = store.get('x-forwarded-for');

  return forwarded?.split(',')[0]?.trim() ?? undefined;
}

async function clientUserAgent(): Promise<string | undefined> {
  const store = await headers();

  return store.get('user-agent') ?? undefined;
}

export async function loginAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const phone = textField(formData, 'phone');
  const password = textField(formData, 'password');

  if (phone === '' || password === '') {
    return { error: 'auth.errors.required' };
  }

  const requestId = newRequestId();

  try {
    const result = await signIn({
      phone,
      password,
      ip: await clientIp(),
      userAgent: await clientUserAgent(),
    });

    await setSessionCookie(result.token, result.expiresAt);
  } catch (error) {
    if (error instanceof AppError) {
      requestLogger(requestId).warn({ code: error.code }, 'вход отклонён');

      return {
        error: `auth.errors.${error.code}`,
        ...(error.code === 'rate_limited'
          ? { retryAfterSeconds: Number(error.details?.retryAfterSeconds ?? 0) }
          : {}),
      };
    }

    throw error;
  }

  // redirect бросает исключение, поэтому вызывается вне try.
  redirect('/');
}

export async function changePasswordAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const password = textField(formData, 'password');
  const confirmation = textField(formData, 'confirmation');

  if (password !== confirmation) {
    return { error: 'auth.errors.confirmationMismatch' };
  }

  const parsed = passwordSchema({ phone: session.user.phone }).safeParse(password);
  if (!parsed.success) {
    return { error: `validation.${parsed.error.issues[0]?.message ?? 'password.tooShort'}` };
  }

  // Совпадение с прежним паролем проверяет только сервер: у клиента нет хеша.
  if (await verifyPassword(session.user.passwordHash, password)) {
    return { error: 'validation.password.reused' };
  }

  await getAuthProvider().setPassword(session.user.id, password);

  await recordAudit(
    { context: session.context, ip: await clientIp() },
    {
      action: AUDIT_ACTIONS.passwordChanged,
      entityType: 'user',
      entityId: session.user.id,
      before: { passwordHash: session.user.passwordHash },
      after: { passwordHash: 'изменён' },
    },
    getDb(),
  );

  // Смена пароля отзывает все сессии, включая текущую: нужен новый вход.
  await clearSessionCookie();
  redirect('/login?changed=1');
}

export async function logoutAction(): Promise<void> {
  const token = await readSessionToken();

  if (token !== null) {
    await signOut(token);
  }

  await clearSessionCookie();
  redirect('/login');
}
