import { isAbsolute, join, normalize, sep } from 'node:path';

/**
 * Ключ объекта в хранилище приходит из данных: тип документа, идентификатор
 * проживания, слаг дома. Любая из этих частей однажды окажется не такой,
 * как ожидалось, поэтому путь проверяется до обращения к диску.
 *
 * Чистая функция: её можно проверить всеми злыми вариантами сразу.
 */
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

export class UnsafeStorageKeyError extends Error {
  constructor(key: string, reason: string) {
    super(`Небезопасный ключ хранилища «${key}»: ${reason}`);
    this.name = 'UnsafeStorageKeyError';
  }
}

/** Проверяет ключ и возвращает его нормализованный вид с прямыми слэшами. */
export function assertSafeKey(key: string): string {
  if (key === '') {
    throw new UnsafeStorageKeyError(key, 'пустой');
  }

  if (key.includes('\0')) {
    throw new UnsafeStorageKeyError(key, 'содержит нулевой байт');
  }

  if (isAbsolute(key) || key.startsWith('/') || /^[A-Za-z]:/.test(key)) {
    throw new UnsafeStorageKeyError(key, 'абсолютный путь');
  }

  const segments = key.split(/[/\\]/);

  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new UnsafeStorageKeyError(key, 'пустой сегмент или переход вверх');
    }

    if (!SEGMENT_PATTERN.test(segment)) {
      throw new UnsafeStorageKeyError(key, `недопустимый сегмент «${segment}»`);
    }
  }

  return segments.join('/');
}

/**
 * Абсолютный путь внутри корня хранилища.
 * Дополнительно сверяется, что результат действительно лежит под корнем:
 * проверка ключа и проверка результата ловят разные ошибки.
 */
export function resolveWithinRoot(root: string, key: string): string {
  const safeKey = assertSafeKey(key);
  const resolved = normalize(join(root, safeKey));
  const boundary = normalize(root).endsWith(sep) ? normalize(root) : normalize(root) + sep;

  if (!resolved.startsWith(boundary)) {
    throw new UnsafeStorageKeyError(key, 'путь уходит за пределы корня хранилища');
  }

  return resolved;
}
