import { redirect } from 'next/navigation';

import { AppShell } from '@/components/layout/app-shell';
import { getCurrentSession } from '@/lib/session';

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

  return <AppShell>{children}</AppShell>;
}
