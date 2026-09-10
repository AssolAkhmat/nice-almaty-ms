/**
 * Долг по дополнительным ротациям — книга со знаком
 * (docs/03-BUSINESS-RULES.md §7, docs/tasks/PHASE-10.md §2.7).
 *
 * Строка `+1` — ротация не выполнена (автозакрытие дня, порог рейтинга),
 * строка `−1` — выполнена ротация с галочкой «списать доп. ротацию».
 * Баланс — сумма несгоревших строк; минус допустим и означает запас:
 * следующее «не выполнена» сначала съедает его.
 *
 * Чистые функции: откуда пришли строки и когда они сгорают, знает
 * репозиторий — здесь только арифметика.
 */

export type DebtStep = -1 | 0 | 1;

export interface DebtStepInput {
  state: 'assigned' | 'needs_reassignment' | 'confirmed' | 'missed' | 'cancelled';
  /** Галочка «списать доп. ротацию» на назначении (§2.7). */
  writeOffDebt: boolean;
  /** Есть ли исполнитель: дырке долг не начисляют (§6.3). */
  hasExecutor: boolean;
  /** Занятие отменено: отменённое не влияет ни на рейтинг, ни на долг (§7). */
  cancelled: boolean;
}

/**
 * Какую строку книги должно давать назначение в его нынешнем состоянии.
 *
 * Списание происходит при подтверждении выполнения, а не при постановке
 * (P10-3): галочка на неподтверждённом назначении ничего не значит,
 * а «не выполнена» с галочкой — обычный `+1`, как у любой ротации.
 */
export function debtStepOf(input: DebtStepInput): DebtStep {
  if (!input.hasExecutor || input.cancelled || input.state === 'cancelled') {
    return 0;
  }

  if (input.state === 'missed') {
    return 1;
  }

  if (input.state === 'confirmed' && input.writeOffDebt) {
    return -1;
  }

  return 0;
}

/** Баланс книги: сумма строк, вправе быть отрицательным. */
export function debtBalance(rows: readonly { delta: number }[]): number {
  return rows.reduce((sum, row) => sum + row.delta, 0);
}
