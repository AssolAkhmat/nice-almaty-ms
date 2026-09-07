/**
 * Выгрузка таблиц в CSV (docs/04-MODULES/10-accounting-inventory.md).
 *
 * Разделитель — точка с запятой, а не запятая: в русской и казахской
 * локали Excel по умолчанию ждёт именно её, и файл с запятыми открывается
 * одной колонкой. По той же причине в начале стоит метка порядка байтов:
 * без неё Excel читает UTF-8 как однобайтовую кодировку и показывает
 * кракозябры вместо имён.
 */
export const CSV_DELIMITER = ';';

export const CSV_BOM = '﻿';

export interface Column<Row> {
  header: string;
  value: (row: Row) => string | number | null;
}

/** Экранирование по RFC 4180: кавычки удваиваются, поле берётся в кавычки. */
export function escapeCell(value: string | number | null): string {
  if (value === null) {
    return '';
  }

  const text = String(value);

  if (!/["\n\r;]/.test(text)) {
    return text;
  }

  return `"${text.replaceAll('"', '""')}"`;
}

export function toCsv<Row>(columns: readonly Column<Row>[], rows: readonly Row[]): string {
  const lines = [columns.map((column) => escapeCell(column.header)).join(CSV_DELIMITER)];

  for (const row of rows) {
    lines.push(columns.map((column) => escapeCell(column.value(row))).join(CSV_DELIMITER));
  }

  // CRLF: того же требует RFC 4180, и Excel на Windows иначе клеит строки.
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}
