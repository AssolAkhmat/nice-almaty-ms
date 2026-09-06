import { describe, expect, it } from 'vitest';

import { assertSafeKey, resolveWithinRoot, UnsafeStorageKeyError } from './paths';

const BACKSLASH = String.fromCharCode(92);
const NUL = String.fromCharCode(0);

describe('ключ объекта в хранилище', () => {
  it('принимает вложенные пути из безопасных сегментов', () => {
    expect(assertSafeKey('dom-1/residency-42/passport/scan.jpg')).toBe(
      'dom-1/residency-42/passport/scan.jpg',
    );
    expect(assertSafeKey('file.pdf')).toBe('file.pdf');
  });

  it('приводит обратные слэши к прямым', () => {
    expect(assertSafeKey(`dom-1${BACKSLASH}doc.pdf`)).toBe('dom-1/doc.pdf');
  });

  /**
   * Ключ собирается из данных: слаг дома, идентификатор проживания, тип документа.
   * Любая из частей однажды окажется не такой, как ожидалось.
   */
  describe('отвергает попытки уйти за пределы хранилища', () => {
    const attacks: [string, string][] = [
      ['переход вверх', '../etc/passwd'],
      ['переход вверх в середине', 'dom-1/../../etc/passwd'],
      ['текущий каталог', 'dom-1/./doc.pdf'],
      ['переход вверх через обратный слэш', `..${BACKSLASH}windows${BACKSLASH}system32`],
      ['абсолютный путь unix', '/etc/passwd'],
      ['абсолютный путь windows', `C:${BACKSLASH}Windows${BACKSLASH}system32`],
      ['двойной разделитель', 'dom-1//doc.pdf'],
      ['пустой ключ', ''],
      ['нулевой байт', `dom-1/${NUL}/doc.pdf`],
      ['кириллица в имени', 'файл.pdf'],
      ['пробел в сегменте', 'dom 1/doc.pdf'],
      ['служебные символы оболочки', 'dom-1/doc;rm -rf.pdf'],
    ];

    for (const [name, key] of attacks) {
      it(name, () => {
        expect(() => assertSafeKey(key)).toThrow(UnsafeStorageKeyError);
      });
    }
  });
});

describe('путь внутри корня', () => {
  it('собирается из корня и ключа', () => {
    const resolved = resolveWithinRoot('/srv/storage', 'dom-1/doc.pdf');

    expect(resolved).toContain('dom-1');
    expect(resolved).toContain('doc.pdf');
  });

  it('не выпускает за пределы корня', () => {
    expect(() => resolveWithinRoot('/srv/storage', '../secrets')).toThrow(UnsafeStorageKeyError);
  });

  it('сосед по имени не считается своим', () => {
    // Проверка границы каталога, а не префикса строки:
    // иначе /srv/storage-2 сошёл бы за путь внутри /srv/storage.
    const resolved = resolveWithinRoot('/srv/storage', 'a.pdf');

    expect(resolved.startsWith('/srv/storage-2')).toBe(false);
  });
});
