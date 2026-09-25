import { ValidationError } from '@/lib/errors';
import { businessDate, tryParseBusinessDate, type BusinessDate } from '@/lib/time';

/**
 * Пять типов объявляемого поля, и список живёт здесь, а не в схеме базы:
 * ядро расчётов о базе не знает (правило `src/domain`), а перечисление
 * в миграции собирается из этого же списка — одно описание, не два.
 */
export const PROFILE_FIELD_TYPES = ['text', 'number', 'date', 'boolean', 'choice'] as const;

export type ProfileFieldType = (typeof PROFILE_FIELD_TYPES)[number];

/**
 * Дополнительные поля профиля: разбор значений (T12.2, решение D31).
 *
 * Ядро чистое — ни базы, ни времени: объявление приходит аргументом, потому
 * что набор полей стал данными, а не константой. Канонический вид значения
 * один на тип: число без пробелов и с точкой, дата `ГГГГ-ММ-ДД`, да/нет
 * `true`/`false`, выбор — код варианта, строка — обрезанная по краям.
 *
 * Принимается больше, чем хранится: человек пишет дату точками, а число
 * с запятой и пробелами разрядов — отказ на этом был бы отказом ни о чём.
 */
export interface FieldDeclaration {
  code: string;
  isArchived?: boolean;
  isRequired: boolean;
  options: readonly string[];
  type: ProfileFieldType;
}

/** Значения по кодам полей: пусто — значение стирается. */
export type DeclaredValues = Readonly<Record<string, string | null>>;

const TRUE_WORDS = new Set(['on', 'true', '1', 'да', 'yes']);
const FALSE_WORDS = new Set(['', 'off', 'false', '0', 'нет', 'no']);

function asNumber(declaration: FieldDeclaration, raw: string): string {
  const normalized = raw.replaceAll(/[\s\u00a0]/gu, '').replace(',', '.');

  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    throw new ValidationError('profileFieldNotNumber', { field: declaration.code, value: raw });
  }

  return normalized;
}

function asDate(declaration: FieldDeclaration, raw: string): BusinessDate {
  const dotted = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw);

  if (dotted !== null) {
    const [, day, month, year] = dotted;

    try {
      return businessDate(Number(year), Number(month), Number(day));
    } catch {
      throw new ValidationError('profileFieldNoSuchDate', {
        field: declaration.code,
        value: raw,
      });
    }
  }

  const parsed = tryParseBusinessDate(raw);

  if (parsed === null) {
    throw new ValidationError('profileFieldNotDate', { field: declaration.code, value: raw });
  }

  return parsed;
}

function asChoice(declaration: FieldDeclaration, raw: string): string {
  if (!declaration.options.includes(raw)) {
    throw new ValidationError('profileFieldNoSuchOption', {
      field: declaration.code,
      options: declaration.options.join(', '),
      value: raw,
    });
  }

  return raw;
}

/**
 * Каноническое значение или `null`, если поле оставили пустым.
 * Да/нет пустым не бывает: снятый флажок — это «нет», а не отсутствие.
 */
export function canonicalValue(declaration: FieldDeclaration, raw: string): string | null {
  const trimmed = raw.trim();

  if (declaration.type === 'boolean') {
    const word = trimmed.toLowerCase();

    if (TRUE_WORDS.has(word)) {
      return 'true';
    }

    if (FALSE_WORDS.has(word)) {
      return 'false';
    }

    throw new ValidationError('profileFieldNotBoolean', {
      field: declaration.code,
      value: raw,
    });
  }

  if (trimmed === '') {
    return null;
  }

  switch (declaration.type) {
    case 'number': {
      return asNumber(declaration, trimmed);
    }
    case 'date': {
      return asDate(declaration, trimmed);
    }
    case 'choice': {
      return asChoice(declaration, trimmed);
    }
    default: {
      return trimmed;
    }
  }
}

/**
 * Разбор всего набора: неизвестный код и лишнее значение архивированного поля
 * не проходят молча — иначе опечатка в шаблоне или в боте теряла бы данные
 * без единого следа.
 *
 * Обязательность архивированного поля не требуется: оно больше не заполняется,
 * а прежнее значение остаётся читаемым.
 */
export function validateDeclaredValues(
  declarations: readonly FieldDeclaration[],
  raw: Readonly<Record<string, string>>,
): DeclaredValues {
  const byCode = new Map(declarations.map((declaration) => [declaration.code, declaration]));
  const result: Record<string, string | null> = {};

  for (const code of Object.keys(raw)) {
    const declaration = byCode.get(code);

    if (declaration === undefined) {
      throw new ValidationError('profileFieldUnknown', { field: code });
    }

    if (declaration.isArchived === true) {
      throw new ValidationError('profileFieldArchived', { field: code });
    }
  }

  for (const declaration of declarations) {
    if (declaration.isArchived === true) {
      continue;
    }

    const given = raw[declaration.code];
    const value = given === undefined ? null : canonicalValue(declaration, given);

    if (declaration.isRequired && (value === null || value === 'false')) {
      throw new ValidationError(
        declaration.type === 'boolean' ? 'profileFieldNeedsMark' : 'profileFieldRequired',
        { field: declaration.code },
      );
    }

    if (given !== undefined) {
      result[declaration.code] = value;
    }
  }

  return result;
}

/**
 * Какие обязательные поля остались незаполненными.
 *
 * Отдельная функция, а не условие в двух местах: незаполненность решает
 * и шаг «профиль» в мастере заселения, и проверка перед записью. Разойдясь,
 * эти два места дали бы мастеру зелёный шаг при отказе на сохранении.
 *
 * Архивированное поле не требуется: заполнить его уже нельзя.
 * Снятый флажок обязательного да/нет — незаполненное поле.
 */
export function missingRequiredFields(
  declarations: readonly FieldDeclaration[],
  values: Readonly<Record<string, string | null>>,
): string[] {
  return declarations
    .filter((declaration) => declaration.isArchived !== true && declaration.isRequired)
    .filter((declaration) => {
      const value = values[declaration.code] ?? null;

      return value === null || (declaration.type === 'boolean' && value === 'false');
    })
    .map((declaration) => declaration.code);
}

/** Подписи да/нет приходят от вызывающего: в ядре строк интерфейса нет. */
export interface BooleanLabels {
  no: string;
  yes: string;
}

/**
 * Значение так, как его читает человек: карточка и договор печатают это.
 * Подписи да/нет — аргументом, из словаря читающего или из языка договора:
 * своих строк интерфейса у ядра быть не может.
 */
export function displayValue(
  declaration: FieldDeclaration,
  value: string,
  labels: BooleanLabels,
): string {
  if (declaration.type === 'boolean') {
    return value === 'true' ? labels.yes : labels.no;
  }

  if (declaration.type === 'date') {
    const parsed = tryParseBusinessDate(value);

    if (parsed === null) {
      return value;
    }

    const [year, month, day] = parsed.split('-');

    return `${day}.${month}.${year}`;
  }

  return value;
}

/**
 * Образец на каждый тип: предпросмотр шаблона договора рисуется на тестовых
 * данных, и объявленному полю тоже нужно что-то показать. Без образца
 * предпросмотр печатал бы пустоту там, где в договоре будет значение.
 */
export function sampleValue(declaration: FieldDeclaration): string {
  switch (declaration.type) {
    case 'number': {
      return '3';
    }
    case 'date': {
      return '2026-09-01';
    }
    case 'boolean': {
      return 'true';
    }
    case 'choice': {
      return declaration.options[0] ?? '';
    }
    default: {
      return 'образец';
    }
  }
}
