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

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const hasSessionCookie = request.cookies.has(SESSION_COOKIE_NAME);

  if (PUBLIC_PATHS.some((path) => pathname.startsWith(path))) {
    return NextResponse.next();
  }

  if (!hasSessionCookie) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';

    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  /** Статика, здоровье и служебные пути проверку не проходят. */
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
