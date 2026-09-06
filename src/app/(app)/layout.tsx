import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { AppShell } from '@/components/layout/app-shell';
import { isAllowedDuringOnboarding } from '@/lib/onboarding-access';
import { getCurrentSession } from '@/lib/session';
import { PATHNAME_HEADER } from '@/middleware';
import { readOnboarding } from '@/services/onboarding';

export const dynamic = 'force-dynamic';

/**
 * Защищённая зона. Настоящая проверка сессии идёт здесь, а не в middleware:
 * там edge-рантайм без доступа к базе.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentSession();

  if (session === null) {
    redirect('/login');
  }

  // До смены пароля доступен только экран смены пароля (docs/01-ARCHITECTURE.md).
  if (session.user.mustChangePassword) {
    redirect('/change-password');
  }

  /*
   * Жёсткая блокировка §1.2: до оплаты депозита жильцу открыты только профиль,
   * документы и свои счета. Проверка стоит здесь, а не в каждой странице:
   * забытая страница означала бы дыру в правиле.
   */
  if (session.context.role === 'resident') {
    const pathname = (await headers()).get(PATHNAME_HEADER) ?? '/';

    if (!isAllowedDuringOnboarding(pathname)) {
      const onboarding = await readOnboarding({ context: session.context });

      if (onboarding.isBlocked) {
        redirect('/');
      }
    }
  }

  return <AppShell>{children}</AppShell>;
}
