import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { AppShell } from '@/components/layout/app-shell';
import { assertSchemaCurrent } from '@/db/schema-version';
import { isPathAllowed } from '@/lib/residency-access';
import { getCurrentSession } from '@/lib/session';
import { PATHNAME_HEADER } from '@/middleware';
import { unreadCount } from '@/services/notifications';
import { readAccessScope } from '@/services/onboarding';

export const dynamic = 'force-dynamic';

/**
 * Защищённая зона. Настоящая проверка сессии идёт здесь, а не в middleware:
 * там edge-рантайм без доступа к базе.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  /*
   * Схема проверяется до первого запроса к данным: приложение на отставшей
   * базе ломается вразнобой, и случайные ошибки на случайных экранах хуже
   * одного понятного отказа (P7-16).
   */
  await assertSchemaCurrent();

  const session = await getCurrentSession();

  if (session === null) {
    redirect('/login');
  }

  // До смены пароля доступен только экран смены пароля (docs/01-ARCHITECTURE.md).
  if (session.user.mustChangePassword) {
    redirect('/change-password');
  }

  /*
   * Жёсткая блокировка §1.2 до оплаты депозита и §2.3 п.2 после расторжения.
   * Проверка стоит здесь, а не в каждой странице: забытая страница означала
   * бы дыру в правиле.
   *
   * В базу идём только за путями, закрытыми хотя бы в одной области:
   * профиль и депозит открыты в любой, и статус для них спрашивать незачем.
   */
  if (session.context.role === 'resident') {
    const pathname = (await headers()).get(PATHNAME_HEADER) ?? '/';

    if (!isPathAllowed('termination', pathname)) {
      const scope = await readAccessScope({ context: session.context });

      if (!isPathAllowed(scope, pathname)) {
        redirect('/');
      }
    }
  }

  /*
   * Непрочитанное считается по записям в приложении, а не по каналам
   * доставки: push система уже показала, и второй раз он не новость (P6-18).
   */
  const unread = await unreadCount(session.context);

  return <AppShell unread={unread}>{children}</AppShell>;
}
