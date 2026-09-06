/* eslint-disable no-console -- это консольная утилита, её вывод и есть результат */
import { closeDb } from './client';
import { seedNetwork } from './seed';

/**
 * `pnpm db:seed`. Временные пароли печатаются один раз: в базе лежит
 * только их хеш, восстановить их потом неоткуда.
 */
async function main(): Promise<void> {
  const result = await seedNetwork();

  console.log('Сеть и дома готовы.');
  console.log('');
  console.log('Учётные записи (пароль меняется при первом входе):');

  for (const account of result.accounts) {
    const where = account.house === undefined ? 'вся сеть' : account.house;
    const password = account.temporaryPassword ?? 'уже существует, пароль не менялся';

    console.log(`  ${account.phone}  ${account.role}  ${where}  ${password}`);
  }

  console.log('');
  console.log('Пароли показаны один раз. Повторный запуск сида их не покажет.');
}

try {
  await main();
} finally {
  await closeDb();
}
