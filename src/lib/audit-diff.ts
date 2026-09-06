/**
 * Подготовка значений «до» и «после» для журнала (docs/03-BUSINESS-RULES.md §11).
 *
 * Два правила, оба обязательны:
 *  1. В журнал попадают только изменившиеся поля, а не вся строка целиком.
 *  2. Зашифрованные и секретные значения не попадают в журнал никогда —
 *     иначе аудит становится вторым, незашифрованным хранилищем
 *     персональных данных. Пишется факт изменения, а не значение.
 */
export const MASKED_VALUE = '***';

/** Точные имена секретных полей и суффиксы шифрованных колонок. */
const SENSITIVE_EXACT = new Set([
  'passwordHash',
  'password_hash',
  'password',
  'tokenHash',
  'token_hash',
  'iin',
  'idDocNumber',
  'id_doc_number',
]);

const SENSITIVE_SUFFIXES = ['_enc', 'Enc'];

export function isSensitiveField(name: string): boolean {
  return SENSITIVE_EXACT.has(name) || SENSITIVE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export type AuditValues = Record<string, unknown>;

export interface AuditDiff {
  before: AuditValues;
  after: AuditValues;
}

function isSameValue(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }

  if (Object.is(left, right)) {
    return true;
  }

  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }

  return JSON.stringify(left) === JSON.stringify(right);
}

function forJournal(name: string, value: unknown): unknown {
  if (isSensitiveField(name)) {
    return MASKED_VALUE;
  }

  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Разница двух состояний записи. `null` — ничего не изменилось,
 * такой записи в журнале быть не должно.
 */
export function diffForAudit(before: AuditValues, after: AuditValues): AuditDiff | null {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diff: AuditDiff = { before: {}, after: {} };
  let changed = false;

  for (const name of names) {
    if (isSameValue(before[name], after[name])) {
      continue;
    }

    changed = true;
    if (name in before) {
      diff.before[name] = forJournal(name, before[name]);
    }
    if (name in after) {
      diff.after[name] = forJournal(name, after[name]);
    }
  }

  return changed ? diff : null;
}

/** Снимок одного состояния — для создания и удаления, где второй стороны нет. */
export function snapshotForAudit(values: AuditValues): AuditValues {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, forJournal(name, value)]),
  );
}
