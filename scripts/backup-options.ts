/**
 * Аргументы и окружение выгрузки бэкапа (docs/BACKUP.md).
 *
 * Разбор отделён от работы с Drive намеренно: перепутанный получатель
 * шифрования или пустая папка — это копия, которую потом не расшифровать
 * или не найти, и узнать об этом лучше до обращения к сети.
 */
export interface BackupOptions {
  /** Путь к незашифрованному дампу внутри контейнера. */
  readonly file: string;
  /** Деловая дата копии по календарю Алматы. */
  readonly date: string;
  /** Открытый ключ age, которым шифруется дамп. Закрытого на сервере нет. */
  readonly recipient: string;
  /** Папка Drive под бэкапы — отдельная от папки документов. */
  readonly folderName: string;
}

export const DEFAULT_BACKUP_FOLDER = 'Nice Almaty — бэкапы';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Открытый ключ age: `age1` и дальше строчные буквы с цифрами. */
const RECIPIENT_PATTERN = /^age1[0-9a-z]{20,}$/;

function argument(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const found = argv.find((value) => value.startsWith(prefix));

  return found === undefined ? null : found.slice(prefix.length);
}

export function parseBackupOptions(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): BackupOptions {
  const file = argument(argv, 'file');
  const date = argument(argv, 'date');
  const recipient = env.BACKUP_AGE_RECIPIENT ?? '';
  const folderName = env.BACKUP_FOLDER_NAME ?? '';

  if (file === null || file === '') {
    throw new Error('Не задан --file=<путь к дампу>: выгружать нечего');
  }

  if (date === null || !DATE_PATTERN.test(date)) {
    throw new Error(`Не задан или неверен --date=<ГГГГ-ММ-ДД>, получено «${date ?? ''}»`);
  }

  /*
   * Ключ проверяется по форме, а не только на непустоту: строка не от age
   * шифрование не остановит — `age` откажет сам, — но остановит она его
   * посреди ночного прогона, а не здесь, где причина видна словами.
   */
  if (!RECIPIENT_PATTERN.test(recipient)) {
    throw new Error(
      'BACKUP_AGE_RECIPIENT не похож на открытый ключ age (age1…). ' +
        'Закрытый ключ на сервере не хранится: сюда кладётся только открытый.',
    );
  }

  return {
    file,
    date,
    recipient,
    folderName: folderName === '' ? DEFAULT_BACKUP_FOLDER : folderName,
  };
}
