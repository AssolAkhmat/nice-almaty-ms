import { gunzipSync, inflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { CSV_BOM, escapeCell, toCsv, type Column } from './csv';
import { columnName, escapeXml, toXlsx } from './xlsx';
import { crc32, storedZip } from './zip';

/**
 * Выгрузка списков (docs/04-MODULES/10-accounting-inventory.md).
 *
 * Проверяется то, что ломает файл у человека: разделитель и метка
 * кодировки в CSV, структура архива и экранирование в XLSX. Открыть
 * Excel в прогоне нельзя, но собранный архив можно разобрать обратно.
 */
interface Row {
  name: string;
  qty: number;
  note: string | null;
}

const COLUMNS: Column<Row>[] = [
  { header: 'Наименование', value: (row) => row.name },
  { header: 'Количество', value: (row) => row.qty },
  { header: 'Примечание', value: (row) => row.note },
];

const ROWS: Row[] = [
  { name: 'Краска', qty: 12.5, note: null },
  { name: 'Швабра; большая', qty: 2, note: 'С «кавычками» и\nпереносом' },
];

describe('CSV', () => {
  it('начинается меткой кодировки: без неё Excel читает не ту', () => {
    expect(toCsv(COLUMNS, ROWS).startsWith(CSV_BOM)).toBe(true);
  });

  it('разделитель — точка с запятой', () => {
    const [header] = toCsv(COLUMNS, []).replace(CSV_BOM, '').split('\r\n');

    expect(header).toBe('Наименование;Количество;Примечание');
  });

  it('точка с запятой, кавычки и перенос внутри поля не рвут таблицу', () => {
    expect(escapeCell('Швабра; большая')).toBe('"Швабра; большая"');
    expect(escapeCell('С «кавычками»')).toBe('С «кавычками»');
    expect(escapeCell('a"b')).toBe('"a""b"');
    expect(escapeCell('строка\nвторая')).toBe('"строка\nвторая"');
  });

  it('пустое значение остаётся пустым, а не строкой «null»', () => {
    expect(escapeCell(null)).toBe('');
    expect(toCsv(COLUMNS, [ROWS[0] as Row])).toContain('Краска;12.5;\r\n');
  });
});

describe('XLSX', () => {
  it('это zip: сигнатура на месте, файлов пять', () => {
    const book = toXlsx(COLUMNS, ROWS, 'Инвентарь');

    expect([...book.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const view = new DataView(book.buffer, book.byteOffset, book.byteLength);
    // Число записей лежит в конце архива, в записи о центральном каталоге.
    expect(view.getUint16(book.length - 22 + 10, true)).toBe(5);
  });

  it('лист содержит заголовок и строки с данными', () => {
    const book = toXlsx(COLUMNS, ROWS, 'Инвентарь');
    const text = new TextDecoder().decode(book);

    expect(text).toContain('<sheetData>');
    expect(text).toContain('Наименование');
    expect(text).toContain('<c r="B2"><v>12.5</v></c>');
  });

  it('опасные символы экранируются, а не ломают XML', () => {
    expect(escapeXml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');

    const book = toXlsx([{ header: 'A&B', value: () => '<b>' }], [{} as Row], 'Лист');
    const text = new TextDecoder().decode(book);

    expect(text).toContain('A&amp;B');
    expect(text).toContain('&lt;b&gt;');
  });

  it('колонки нумеруются по-табличному', () => {
    expect(columnName(1)).toBe('A');
    expect(columnName(26)).toBe('Z');
    expect(columnName(27)).toBe('AA');
    expect(columnName(52)).toBe('AZ');
  });
});

describe('zip', () => {
  it('контрольная сумма считается тем же способом, что читает распаковщик', () => {
    // Известное значение CRC-32 для строки «123456789».
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('содержимое лежит в архиве как есть: метод без сжатия', () => {
    const archive = storedZip([{ name: 'a.txt', content: 'привет' }]);
    const text = new TextDecoder().decode(archive);

    expect(text).toContain('a.txt');
    expect(text).toContain('привет');
    // Ни gzip, ни deflate внутри нет: данные хранятся без преобразования.
    expect(() => gunzipSync(Buffer.from(archive))).toThrow();
    expect(() => inflateRawSync(Buffer.from(archive))).toThrow();
  });
});
