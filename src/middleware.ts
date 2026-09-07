import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE_NAME } from '@/lib/session-token';

/**
 * Middleware исполняется в edge-рантайме: базы и argon2 здесь нет,
 * поэтому проверяется только наличие cookie. Настоящая проверка сессии
 * идёт в layout защищённой зоны, где доступен Node-рантайм.
 *
 * Смысл этого слоя — не пускать анонимного пользователя дальше по маршруту
 * и не рендерить защищённые страницы впустую.
 */
const PUBLIC_PATHS = ['/login', '/change-password'];

/** Заголовок с текущим путём: серверные компоненты его иначе не видят. */
export const PATHNAME_HEADER = 'x-pathname';

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const hasSessionCookie = request.cookies.has(SESSION_COOKIE_NAME);

  if (PUBLIC_PATHS.some((path) => pathname.startsWith(path))) {
    return NextResponse.next();
  }

  /*
   * Путь передаётся дальше заголовком: layout защищённой зоны решает по нему,
   * закрыт ли раздел до оплаты депозита (§1.2), а своего пути он не знает.
   */
  const headers = new Headers(request.headers);
  headers.set(PATHNAME_HEADER, pathname);

  if (!hasSessionCookie) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';

    return NextResponse.redirect(url);
  }

  return NextResponse.next({ request: { headers } });
}

export const config = {
  /**
   * Статика, здоровье и служебные пути проверку не проходят.
   *
   * Отдельно — файлы установки на телефон: манифест, service worker,
   * иконки и страница обрыва связи. Браузер просит их и без сессии,
   * а редирект на вход отдавал бы вместо картинки и JSON страницу
   * входа: значок не ставился, worker не регистрировался (P6-29).
   */
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|offline.html|icons/).*)',
  ],
};
