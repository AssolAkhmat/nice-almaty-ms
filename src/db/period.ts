import { compareBusinessDates, type BusinessDate } from '@/lib/time';

/**
 * Период занятости места хранится типом `daterange` (docs/02-DATA-MODEL.md).
 * Границы полуоткрытые: `[начало, конец)`. День выезда в период не входит —
 * иначе новый жилец не смог бы заехать в день освобождения места.
 *
 * Чистые функции: только представление, ни БД, ни времени.
 */
export interface Period {
  from: BusinessDate;
  /** `null` — договор открыт, место занято бессрочно. */
  to: BusinessDate | null;
}

export function periodLiteral(period: Period): string {
  if (period.to !== null && compareBusinessDates(period.from, period.to) >= 0) {
    throw new RangeError(
      `Пустой период занятости: ${period.from} — ${period.to}. Конец должен быть строго позже начала`,
    );
  }

  return `[${period.from},${period.to ?? ''})`;
}

/**
 * Период, закрытый датой освобождения места. В отличие от `periodLiteral`,
 * совпадение границ допускается: это пустой период, и означает он ровно то,
 * что случилось, — расторжение пришло в день заселения, и место не было
 * занято ни дня. База пустой диапазон принимает и пересечением не считает,
 * поэтому новый жилец занимает место сразу.
 */
export function closedPeriodLiteral(from: BusinessDate, to: BusinessDate): string {
  if (compareBusinessDates(from, to) > 0) {
    throw new RangeError(
      `Невозможный период занятости: ${from} — ${to}. Выезда раньше заезда не бывает`,
    );
  }

  return `[${from},${to})`;
}

const LITERAL_PATTERN = /^\[(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})?\)$/;

export function parsePeriod(literal: string): Period {
  const match = LITERAL_PATTERN.exec(literal);
  if (match === null) {
    throw new RangeError(`Не похоже на период занятости: ${literal}`);
  }

  return {
    from: match[1] as BusinessDate,
    to: (match[2] ?? null) as BusinessDate | null,
  };
}
