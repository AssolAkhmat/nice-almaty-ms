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
