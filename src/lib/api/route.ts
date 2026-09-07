import { getSession } from '@/services/auth';

import { AppError, UnauthorizedError, type AppErrorCode } from '../errors';
import { identifyByToken } from './token-auth';
import { newRequestId, requestLogger } from '../logger';
import { SESSION_COOKIE_NAME } from '../session-token';

import type { Executor } from '@/db/client';
import type { UserActor } from '@/services/users';

/**
 * Общая обвязка REST под `/api/v1` (docs/06-API.md).
 *
 * Обработчики зеркалят server actions и ходят в тот же сервисный слой:
 * логика не дублируется, поэтому здесь только то, чего у server actions нет, —
 * коды ответов, формат ошибки и разбор входа.
 */

/**
 * Статусы под коды ошибок. В docs/06-API.md заданы коды, но не статусы;
 * выбор записан решением в docs/08-DECISIONS.md. `validation_error` — 422:
 * запрос разобран, отвергнут именно его смысл.
 */
const STATUS: Readonly<Record<AppErrorCode, number>> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_error: 422,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
};

export function statusForCode(code: AppErrorCode): number {
  return STATUS[code];
}

export interface ApiContext<P> {
  requestId: string;
  params: P;
}

interface RouteContext<P> {
  params: Promise<P>;
}

/** Успешный ответ. Тело — JSON в snake_case, как договорено в docs/06-API.md. */
export function apiJson(body: unknown, requestId: string, status = 200): Response {
  return Response.json(body, { status, headers: { 'x-request-id': requestId } });
}

/**
 * Ошибка наружу: `{ error: { code, message, details? }, request_id }`.
 * Неожиданная ошибка не выносит наружу свой текст — он уходит в журнал:
 * сообщение из недр может содержать что угодно, вплоть до строки подключения.
 */
export function apiErrorResponse(error: unknown, requestId: string): Response {
  const known = error instanceof AppError;

  if (!known) {
    requestLogger(requestId).error({ err: error }, 'необработанная ошибка в /api/v1');
  }

  const code: AppErrorCode = known ? error.code : 'internal';
  const body = {
    error: {
      code,
      message: known ? error.message : 'Внутренняя ошибка',
      ...(known && error.details !== undefined ? { details: error.details } : {}),
    },
    request_id: requestId,
  };

  return Response.json(body, {
    status: statusForCode(code),
    headers: { 'x-request-id': requestId },
  });
}

/**
 * Обёртка обработчика: идентификатор запроса и единый формат отказа.
 * Ни один обработчик не должен отдавать наружу стек или пустой 500.
 */
export function apiRoute<P = Record<string, never>>(
  handler: (request: Request, context: ApiContext<P>) => Promise<Response>,
) {
  return async function route(request: Request, context?: RouteContext<P>): Promise<Response> {
    const requestId = newRequestId();

    try {
      const params = context === undefined ? ({} as P) : await context.params;

      return await handler(request, { requestId, params });
    } catch (error) {
      return apiErrorResponse(error, requestId);
    }
  };
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (header === null) {
    return null;
  }

  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      return rest.join('=');
    }
  }

  return null;
}

/** Адрес клиента для журнала действий: за прокси он приходит заголовком. */
function clientIp(request: Request): string | undefined {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
}

/**
 * Действующий пользователь запроса.
 *
 * Входов два (docs/06-API.md): Bearer-токен для ботов и сессионная cookie
 * для интерфейса. Токен старше: если заголовок пришёл, разбирается именно
 * он — молчаливый откат на чужую сессию был бы худшим из возможных ответов.
 */
export async function requireApiActor(
  request: Request,
  requestId: string,
  executor?: Executor,
): Promise<UserActor> {
  const identity = await identifyByToken(request, executor);

  if (identity !== null) {
    return {
      context: identity.context,
      ip: clientIp(request),
      requestId,
      scopes: identity.scopes,
    };
  }

  const token = readCookie(request, SESSION_COOKIE_NAME);
  if (token === null || token === '') {
    throw new UnauthorizedError();
  }

  const session = await getSession(token, executor);
  if (session === null) {
    throw new UnauthorizedError();
  }

  return { context: session.context, ip: clientIp(request), requestId };
}
