import { existsSync, readFileSync } from 'node:fs';

/**
 * Разбор `.env` для конфигураций тестов.
 *
 * Ни vitest, ни playwright не переносят `.env` в `process.env` сами: прогон
 * уходил в базу по умолчанию — на порт локального PostgreSQL вместо
 * контейнера — и падал на аутентификации (инцидент I2). Значение, заданное
 * в оболочке, сильнее файла: в CI адрес базы приходит именно так.
 *
 * Приложение этим модулем не пользуется: там переменные приносит Next
 * или окружение контейнера.
 */
export function readDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }

  const values: Record<string, string> = {};

  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, '');

    // Пустая строка — не значение: на этом в фазе 0 падал drizzle-kit.
    if (value !== '') {
      values[key] = value;
    }
  }

  return values;
}

/** Значения из файла, которых нет в окружении оболочки. */
export function dotEnvFallback(path: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(readDotEnv(path)).filter(([key]) => process.env[key] === undefined),
  );
}
