/* eslint-disable no-console -- это консольная утилита, её вывод и есть результат */
import { and, eq, isNull } from 'drizzle-orm';

import { endOfMonth, startOfMonth, todayInAlmaty } from '@/lib/time';
import { generateSchedule } from '@/services/rotation-schedule';

import { closeDb, getDb } from './client';
import { accounts, contractTemplates, documentTypes, users } from './schema';
import { seedNetwork, SUPERADMIN_PHONE } from './seed';
import { FURNISHED_HOUSES } from './seed-content';
import { parseSeedArguments } from './seed-options';

import type { UserActor } from '@/services/users';

/**
 * `pnpm db:seed`. Временные пароли печатаются один раз: в базе лежит
 * только их хеш, восстановить их потом неоткуда.
 *
 * Расписание материализуется здесь, а не в самом сиде: генерация — это
 * сервис с проверкой прав, а `src/db` о сервисах ничего не знает и знать
 * не должен. CLI — верхний уровень, ему доступно и то и другое (P7-14).
 */
async function scheduleRotations(houseIds: readonly string[]): Promise<number> {
  const db = getDb();

  const [superadmin] = await db
    .select()
    .from(users)
    .where(eq(users.phone, SUPERADMIN_PHONE))
    .limit(1);

  if (superadmin === undefined) {
    return 0;
  }

  const actor: UserActor = {
    context: {
      orgId: superadmin.orgId,
      userId: superadmin.id,
      role: 'superadmin',
      houseId: null,
    },
    requestId: 'seed',
  };

  const month = startOfMonth(todayInAlmaty());
  let created = 0;

  for (const houseId of houseIds.slice(0, FURNISHED_HOUSES)) {
    const result = await generateSchedule(actor, houseId, endOfMonth(month), { today: month });
    created += result.created;
  }

  return created;
}

/**
 * Что есть в сети помимо домов. Печатается после `--skeleton`: восстановление
 * без отчёта пришлось бы проверять запросом вручную, а ради этих трёх строк
 * скелет и запускают (модули 10 и 11 — экранов у них нет).
 */
async function reportSkeleton(orgId: string): Promise<void> {
  const db = getDb();

  const types = await db.select().from(documentTypes).where(eq(documentTypes.orgId, orgId));
  const templates = await db
    .select()
    .from(contractTemplates)
    .where(eq(contractTemplates.orgId, orgId));
  const networkAccounts = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.orgId, orgId), isNull(accounts.houseId)));

  console.log('');
  console.log('Скелет сети на месте:');
  console.log(`  типов документов: ${String(types.length)}`);
  console.log(`  шаблонов договора: ${String(templates.length)}`);
  console.log(`  счетов сети: ${String(networkAccounts.length)}`);
  console.log('Домов, жильцов и расписания скелет не заводит.');
}

async function main(): Promise<void> {
  const options = parseSeedArguments(process.argv.slice(2));
  const result = await seedNetwork(options);

  console.log(options.houses === 0 ? 'Сеть готова, домов сид не заводил.' : 'Сеть и дома готовы.');
  console.log('');
  console.log('Учётные записи (пароль меняется при первом входе):');

  for (const account of result.accounts) {
    const where = account.house === undefined ? 'вся сеть' : account.house;
    const password = account.temporaryPassword ?? 'уже существует, пароль не менялся';

    console.log(`  ${account.phone}  ${account.role}  ${where}  ${password}`);
  }

  if (options.houses === 0) {
    await reportSkeleton(result.orgId);

    return;
  }

  const occurrences = await scheduleRotations(result.houseIds);

  console.log('');
  console.log(
    result.residents === 0
      ? 'Жильцы уже заведены: повторный запуск ничего не удваивает.'
      : `Заведено жильцов: ${String(result.residents)}. Их пароли временные, как и у админов.`,
  );
  console.log(
    occurrences === 0
      ? 'Расписание на текущий месяц уже составлено.'
      : `Занятий на текущий месяц создано: ${String(occurrences)}.`,
  );
  console.log('Пароли показаны один раз. Повторный запуск сида их не покажет.');
}

try {
  await main();
} finally {
  await closeDb();
}
