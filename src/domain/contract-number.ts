/**
 * Номер договора найма (T8.1).
 *
 * Формат — `ГГГГ-НННН`: год договора, дефис, порядковый номер в этом году,
 * дополненный нулями до четырёх знаков. Нумерация сквозная в пределах сети
 * и начинается заново каждый год; за пределами четырёх знаков номер просто
 * становится длиннее, а не обнуляется.
 *
 * Чистые функции: ни базы, ни часов. Год приходит снаружи — из календаря
 * Алматы, как все границы суток в системе (`src/lib/time.ts`).
 */
const SEQUENCE_DIGITS = 4;

const NUMBER_PATTERN = /^(\d{4})-(\d+)$/;

export function formatContractNumber(year: number, sequence: number): string {
  return `${String(year)}-${String(sequence).padStart(SEQUENCE_DIGITS, '0')}`;
}

/**
 * Следующий номер после `previous` — последнего выданного в сети.
 *
 * Номер другого года или неразборчивая строка означают, что в этом году
 * договоров ещё не было: продолжать чужую нумерацию нельзя, а падать не на чем —
 * старые проживания номеров не имели вовсе.
 */
export function nextContractNumber(previous: string | null, year: number): string {
  const parsed = previous === null ? null : NUMBER_PATTERN.exec(previous);
  const sameYear = parsed !== null && parsed[1] === String(year);

  return formatContractNumber(year, sameYear ? Number(parsed[2]) + 1 : 1);
}
