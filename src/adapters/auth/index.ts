import { localAuthProvider } from './local';

import type { AuthProvider } from './types';

export type { AuthProvider, AuthSession, SignInInput, SignInResult } from './types';
export { toAccessContext } from './local';

/**
 * Драйвер аутентификации. Сейчас один — `local` (D5).
 * Задел под Supabase Auth появится, когда в нём возникнет нужда.
 */
export function getAuthProvider(): AuthProvider {
  return localAuthProvider;
}
