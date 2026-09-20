import { describe, expect, it } from 'vitest';

import { DEFAULT_BACKUP_FOLDER, parseBackupOptions } from './backup-options';

const RECIPIENT = 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p';

const ARGV = ['--file=/work/nice-almaty-2026-09-20.dump', '--date=2026-09-20'];

describe('аргументы выгрузки бэкапа', () => {
  it('собирает параметры из аргументов и окружения', () => {
    expect(parseBackupOptions(ARGV, { BACKUP_AGE_RECIPIENT: RECIPIENT })).toEqual({
      file: '/work/nice-almaty-2026-09-20.dump',
      date: '2026-09-20',
      recipient: RECIPIENT,
      folderName: DEFAULT_BACKUP_FOLDER,
    });
  });

  it('имя папки переопределяется окружением', () => {
    const options = parseBackupOptions(ARGV, {
      BACKUP_AGE_RECIPIENT: RECIPIENT,
      BACKUP_FOLDER_NAME: 'Копии базы',
    });

    expect(options.folderName).toBe('Копии базы');
  });

  it('без файла выгрузка не начинается', () => {
    expect(() =>
      parseBackupOptions(['--date=2026-09-20'], { BACKUP_AGE_RECIPIENT: RECIPIENT }),
    ).toThrow(/--file/);
  });

  it('дата обязана быть датой', () => {
    expect(() =>
      parseBackupOptions(['--file=/work/dump', '--date=20.09.2026'], {
        BACKUP_AGE_RECIPIENT: RECIPIENT,
      }),
    ).toThrow(/--date/);
  });

  /*
   * Негативные фикстуры на ключ: копия, зашифрованная не тем, не расшифруется
   * ничем, и узнается это в тот единственный раз, когда она понадобится.
   */
  it('пустой получатель останавливает выгрузку', () => {
    expect(() => parseBackupOptions(ARGV, {})).toThrow(/BACKUP_AGE_RECIPIENT/);
  });

  it('закрытый ключ age вместо открытого не принимается', () => {
    expect(() =>
      parseBackupOptions(ARGV, {
        BACKUP_AGE_RECIPIENT: 'AGE-SECRET-KEY-1QQPQZRFR7ZZ2WCVXBYN2J5CRT3MT5PLKCZ8G5NQ',
      }),
    ).toThrow(/age1/);
  });

  it('ключ ssh вместо ключа age не принимается', () => {
    expect(() =>
      parseBackupOptions(ARGV, { BACKUP_AGE_RECIPIENT: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5' }),
    ).toThrow(/age1/);
  });
});
