/**
 * Коды ошибок из docs/06-API.md. Одни и те же коды отдают server actions
 * и REST: логика не дублируется, значит и ошибки должны быть общими.
 */
export type AppErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_error'
  | 'conflict'
  | 'rate_limited'
  | 'internal';

export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Требуется вход') {
    super('unauthorized', message);
  }
}

/**
 * Действие запрещено роли, но объект внутри области видимости (P1-1).
 * Если объект вне области видимости — это NotFoundError, а не эта ошибка.
 */
export class ForbiddenError extends AppError {
  constructor(message = 'Действие недоступно этой роли') {
    super('forbidden', message);
  }
}

/**
 * Объект не существует ЛИБО находится вне области видимости (P1-1).
 * Разница наружу не выдаётся: иначе перебором id узнаётся состав сети.
 */
export class NotFoundError extends AppError {
  constructor(message = 'Не найдено') {
    super('not_found', message);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('validation_error', message, details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('conflict', message, details);
  }
}

export class RateLimitedError extends AppError {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super('rate_limited', message, { retryAfterSeconds });
  }
}
