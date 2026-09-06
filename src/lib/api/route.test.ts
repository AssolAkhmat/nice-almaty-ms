import { describe, expect, it } from 'vitest';

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
} from '../errors';

import { apiErrorResponse, apiJson, apiRoute, statusForCode } from './route';

/**
 * Формат ответа REST (docs/06-API.md, «Соглашения»).
 *
 * Коды ошибок заданы документацией, статусы — решением P2-6. Здесь они
 * закреплены тестом: молчаливая смена статуса ломает клиентов, а заметить
 * её по коду обзором почти невозможно.
 */
describe('статусы под коды ошибок', () => {
  it('каждому коду соответствует свой статус', () => {
    expect(statusForCode('unauthorized')).toBe(401);
    expect(statusForCode('forbidden')).toBe(403);
    expect(statusForCode('not_found')).toBe(404);
    expect(statusForCode('conflict')).toBe(409);
    expect(statusForCode('validation_error')).toBe(422);
    expect(statusForCode('rate_limited')).toBe(429);
    expect(statusForCode('internal')).toBe(500);
  });

  it('ошибки приложения отвечают своим статусом', async () => {
    const cases = [
      { error: new UnauthorizedError(), status: 401 },
      { error: new ForbiddenError(), status: 403 },
      { error: new NotFoundError(), status: 404 },
      { error: new ConflictError('занято'), status: 409 },
      { error: new ValidationError('files.tooLarge'), status: 422 },
      { error: new RateLimitedError('часто', 60), status: 429 },
    ];

    for (const { error, status } of cases) {
      const response = apiErrorResponse(error, 'req-1');

      expect(response.status).toBe(status);
      expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
        error.message,
      );
    }
  });
});

describe('тело ответа об ошибке', () => {
  it('содержит код, сообщение и идентификатор запроса', async () => {
    const response = apiErrorResponse(new NotFoundError('Файл не найден'), 'req-2');

    expect(await response.json()).toEqual({
      error: { code: 'not_found', message: 'Файл не найден' },
      request_id: 'req-2',
    });
  });

  it('подробности передаются, когда они есть', async () => {
    const response = apiErrorResponse(
      new ValidationError('files.tooLarge', { maxBytes: 10 }),
      'req-3',
    );

    const body = (await response.json()) as { error: { details?: Record<string, unknown> } };
    expect(body.error.details).toEqual({ maxBytes: 10 });
  });

  it('чужая ошибка наружу текстом не выходит', async () => {
    const response = apiErrorResponse(new Error('connect ECONNREFUSED 10.0.0.1:5432'), 'req-4');

    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal');
    expect(body.error.message).not.toContain('5432');
  });

  it('идентификатор запроса виден и в заголовке', () => {
    expect(apiErrorResponse(new NotFoundError(), 'req-5').headers.get('x-request-id')).toBe(
      'req-5',
    );
    expect(apiJson({ ok: true }, 'req-6').headers.get('x-request-id')).toBe('req-6');
  });
});

describe('обёртка обработчика', () => {
  it('ошибка обработчика превращается в ответ, а не в падение', async () => {
    const route = apiRoute(() => Promise.reject(new ConflictError('уже принят')));

    const response = await route(new Request('http://localhost/api/v1/x'));

    expect(response.status).toBe(409);
  });

  it('идентификатор запроса свой у каждого вызова', async () => {
    const route = apiRoute((_request, { requestId }) =>
      Promise.resolve(apiJson({ requestId }, requestId)),
    );

    const first = await route(new Request('http://localhost/api/v1/x'));
    const second = await route(new Request('http://localhost/api/v1/x'));

    expect(first.headers.get('x-request-id')).not.toBe(second.headers.get('x-request-id'));
  });

  it('параметры пути доходят до обработчика', async () => {
    const route = apiRoute<{ id: string }>((_request, { requestId, params }) =>
      Promise.resolve(apiJson({ id: params.id }, requestId)),
    );

    const response = await route(new Request('http://localhost/api/v1/files/7/blob'), {
      params: Promise.resolve({ id: '7' }),
    });

    expect(await response.json()).toEqual({ id: '7' });
  });
});
