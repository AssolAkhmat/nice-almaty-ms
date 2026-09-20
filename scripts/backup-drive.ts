/* eslint-disable no-console -- это консольная утилита, её вывод и есть результат */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, unlinkSync } from 'node:fs';

import { createGdriveStorage } from '@/adapters/storage/gdrive';

import { backupName, planRetention } from './backup-retention';
import { parseBackupOptions } from './backup-options';

/**
 * Шифрование дампа и выгрузка его на Drive (docs/BACKUP.md).
 *
 * Шифруется открытым ключом age: на сервере лежит только он, расшифровать
 * копию сервер не может ни при каких условиях. Смысл ровно в этом — утечка
 * серверного токена Drive не должна отдавать читаемый слепок базы.
 *
 * Папка бэкапов отдельная от папки документов: имя задаёт BACKUP_FOLDER_NAME,
 * заводит её сам драйвер. Область `drive.file` видит только то, что создало
 * приложение, поэтому папку, сделанную владельцем в браузере, сюда не подать.
 */
const AGE_HEADER = 'age-encryption.org/v1';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function driveKeys(): { clientId: string; clientSecret: string; refreshToken: string } {
  const clientId = process.env.GDRIVE_CLIENT_ID ?? '';
  const clientSecret = process.env.GDRIVE_CLIENT_SECRET ?? '';
  const refreshToken = process.env.GDRIVE_REFRESH_TOKEN ?? '';

  if (clientId === '' || clientSecret === '' || refreshToken === '') {
    fail(
      'Отказ: для выгрузки нужны GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET и GDRIVE_REFRESH_TOKEN.\n' +
        'Те же ключи, что у документов: копии кладутся в другую папку того же диска.',
    );
  }

  return { clientId, clientSecret, refreshToken };
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Шифрование в файл рядом с дампом. Возвращает путь зашифрованного. */
function encrypt(file: string, recipient: string): string {
  const encrypted = `${file}.age`;

  const result = spawnSync('age', ['-r', recipient, '-o', encrypted, file], { stdio: 'inherit' });

  if (result.error !== undefined) {
    fail(`Отказ: не удалось запустить age: ${result.error.message}`);
  }

  if (result.status !== 0) {
    fail(`Отказ: age завершился с кодом ${String(result.status)}`);
  }

  const header = readFileSync(encrypted).subarray(0, AGE_HEADER.length).toString('utf8');

  if (header !== AGE_HEADER) {
    fail('Отказ: у зашифрованного файла нет заголовка age — выгружать такое нельзя');
  }

  return encrypted;
}

async function main(): Promise<void> {
  const options = parseBackupOptions(process.argv.slice(2), process.env);
  const keys = driveKeys();

  const plain = statSync(options.file);

  if (plain.size === 0) {
    fail('Отказ: дамп пуст. Пустая копия хуже отсутствующей: она выглядит копией');
  }

  const encrypted = encrypt(options.file, options.recipient);
  const bytes = readFileSync(encrypted);
  const digest = sha256(bytes);
  const name = backupName(options.date);

  console.log(`Дамп: ${String(plain.size)} Б, зашифрован: ${String(bytes.length)} Б`);
  console.log(`sha256 зашифрованного: ${digest}`);

  const storage = createGdriveStorage({
    ...keys,
    rootFolderName: options.folderName,
    onRootFolder: ({ id, created }) => {
      console.log(
        `Папка бэкапов «${options.folderName}» ${created ? 'создана' : 'найдена'}: ${id}`,
      );
    },
  });

  await storage.put(name, bytes);
  console.log(`Выгружено: ${name}`);

  /*
   * Скачивание обратно — единственное, чем сервер может подтвердить выгрузку
   * сам: расшифровать копию он не может, закрытого ключа у него нет.
   * Обрезанная загрузка без этой сверки выглядела бы успешной.
   */
  const uploaded = await storage.get(name);

  if (uploaded === null) {
    fail(`Отказ: сразу после выгрузки файл ${name} на Drive не находится`);
  }

  if (sha256(uploaded) !== digest) {
    fail(`Отказ: скачанная обратно копия не совпала по sha256 — выгрузка испорчена`);
  }

  console.log('Сверка после выгрузки: совпало');

  const existing = await storage.list('');
  const plan = planRetention(existing.map((object) => object.key));

  /*
   * Ротация трогает папку только тогда, когда видит в ней сегодняшнюю копию.
   * Перечень, пришедший пустым или чужим, означает сбой чтения, а не то,
   * что старые копии больше не нужны.
   */
  if (!plan.keep.includes(name)) {
    fail(`Отказ: в перечне папки нет только что выгруженной ${name}, ротация не выполняется`);
  }

  for (const stale of plan.remove) {
    await storage.delete(stale);
    console.log(`Удалена устаревшая копия: ${stale}`);
  }

  if (plan.foreign.length > 0) {
    console.log(`Чужие файлы в папке (не тронуты): ${plan.foreign.join(', ')}`);
  }

  console.log(`Итого копий на Drive: ${String(plan.keep.length)}`);

  // Зашифрованный файл на сервере не задерживается: его место — на Drive.
  unlinkSync(encrypted);
}

await main();
