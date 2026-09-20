/**
 * Адрес тестовой базы для интеграционных тестов.
 *
 * Запасного значения нет намеренно. Раньше каждый файл `*.db-test.ts`
 * подставлял `postgres://nice:nice@localhost:5432/nice_almaty`, если
 * переменная не задана, — и прогон молча уходил на порт локального
 * PostgreSQL, где живёт чужая база (инцидент I2, а до него та же ловушка
 * с портом в фазе 1). Отсутствие адреса обязано быть слышным.
 *
 * Модуль нужен только тестам: приложение берёт `DATABASE_URL` из `src/env.ts`.
 */
export const TEST_DATABASE_URL_VARIABLE = 'TEST_DATABASE_URL';

export const E2E_DATABASE_URL_VARIABLE = 'E2E_DATABASE_URL';

export function testDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  const url = env[TEST_DATABASE_URL_VARIABLE];

  if (url === undefined || url.trim() === '') {
    throw new Error(
      `${TEST_DATABASE_URL_VARIABLE} не задан: интеграционные тесты идут только в тестовую базу. ` +
        'Задайте переменную в .env или в окружении прогона. Запасного адреса нет: ' +
        'молчаливый переход на localhost:5432 однажды увёл прогон в чужую базу.',
    );
  }

  return url;
}

/**
 * Адрес базы для приёмок Playwright.
 *
 * Порядок тот же, что у самих приёмок: окружение прогона сильнее файла,
 * `E2E_DATABASE_URL` сильнее `TEST_DATABASE_URL`. Запасного адреса нет
 * и здесь: до 20 сентября 2026 три конфигурации приёмок подставляли
 * `postgres://nice:nice@…` — причём две на порт 5432, а третья на 55432.
 * После смены пароля базы такой адрес перестал вести хоть куда-нибудь
 * и показывал ошибку авторизации вместо внятного «переменная не задана».
 *
 * `fileEnv` — значения из `.env`: ни vitest, ни playwright сами их
 * в `process.env` не переносят.
 */
export function e2eDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
  fileEnv: Record<string, string | undefined> = {},
): string {
  const url =
    env[E2E_DATABASE_URL_VARIABLE] ??
    env[TEST_DATABASE_URL_VARIABLE] ??
    fileEnv[E2E_DATABASE_URL_VARIABLE] ??
    fileEnv[TEST_DATABASE_URL_VARIABLE];

  if (url === undefined || url.trim() === '') {
    throw new Error(
      `Не задан ни ${E2E_DATABASE_URL_VARIABLE}, ни ${TEST_DATABASE_URL_VARIABLE}: ` +
        'приёмки идут только в тестовую базу. Задайте переменную в .env или в окружении ' +
        'прогона. Запасного адреса нет: прежний postgres://nice:nice@… после смены ' +
        'пароля базы вёл в никуда и выглядел ошибкой авторизации.',
    );
  }

  return url;
}
