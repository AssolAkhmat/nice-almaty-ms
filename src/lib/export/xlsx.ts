import { crc32, storedZip, type ZipEntry } from './zip';

import type { Column } from './csv';

/**
 * Выгрузка таблиц в XLSX (docs/04-MODULES/10-accounting-inventory.md).
 *
 * Книга собирается вручную: xlsx — это zip с несколькими XML внутри,
 * и для одной плоской таблицы их нужно четыре. Библиотека ради этого
 * тянула бы за собой десятки чужих файлов в сборку, а формат здесь
 * используется в самом простом своём виде — строки и числа, без формул,
 * стилей и форматов.
 */
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

function workbook(sheetName: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Имя колонки по её номеру: 1 → A, 27 → AA. */
export function columnName(index: number): string {
  let rest = index;
  let name = '';

  while (rest > 0) {
    const remainder = (rest - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    rest = Math.floor((rest - remainder) / 26);
  }

  return name;
}

function cell(reference: string, value: string | number | null): string {
  if (value === null || value === '') {
    return '';
  }

  if (typeof value === 'number') {
    return `<c r="${reference}"><v>${value}</v></c>`;
  }

  /* Текст пишется строкой прямо в ячейку (`inlineStr`): отдельная таблица
     общих строк экономит место в больших книгах, а здесь только усложнила
     бы файл. */
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function sheet<Row>(columns: readonly Column<Row>[], rows: readonly Row[]): string {
  const lines: string[] = [];

  lines.push(
    `<row r="1">${columns
      .map((column, index) => cell(`${columnName(index + 1)}1`, column.header))
      .join('')}</row>`,
  );

  rows.forEach((row, rowIndex) => {
    const number = rowIndex + 2;

    lines.push(
      `<row r="${number}">${columns
        .map((column, index) => cell(`${columnName(index + 1)}${number}`, column.value(row)))
        .join('')}</row>`,
    );
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${lines.join('')}</sheetData>
</worksheet>`;
}

export function toXlsx<Row>(
  columns: readonly Column<Row>[],
  rows: readonly Row[],
  sheetName: string,
): Uint8Array {
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: ROOT_RELS },
    { name: 'xl/workbook.xml', content: workbook(sheetName) },
    { name: 'xl/_rels/workbook.xml.rels', content: WORKBOOK_RELS },
    { name: 'xl/worksheets/sheet1.xml', content: sheet(columns, rows) },
  ];

  return storedZip(entries);
}

export { crc32 };
