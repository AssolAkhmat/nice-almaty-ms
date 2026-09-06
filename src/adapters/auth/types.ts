import type { AccessContext } from '@/db/access';
import type { Executor } from '@/db/client';
import type { Session, User } from '@/db/schema';

/**
 * Аутентификация за интерфейсом (D5): сейчас драйвер `local`,
 * переход на Supabase Auth возможен без переписывания прикладного кода.
 */
export interface SignInInput {
  phone: string;
  password: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface SignInResult {
  /** Непрозрачный токен для cookie. В базе лежит только его хеш. */
  token: string;
  expiresAt: Date;
  user: User;
  /** Пока true, пользователю доступен только экран смены пароля. */
  mustChangePassword: boolean;
  /** Вход прошёл по одноразовому разрешению сброса, а не по паролю. */
  usedResetPermission: boolean;
}

export interface AuthSession {
  user: User;
  session: Session;
  /** Готовый контекст доступа: с ним работают репозитории. */
  context: AccessContext;
}

export interface AuthProvider {
  signIn: (input: SignInInput, executor?: Executor) => Promise<SignInResult>;
  getSession: (token: string, executor?: Executor) => Promise<AuthSession | null>;
  revoke: (token: string, executor?: Executor) => Promise<void>;
  setPassword: (userId: string, newPassword: string, executor?: Executor) => Promise<void>;
}
