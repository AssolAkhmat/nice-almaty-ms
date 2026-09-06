/**
 * Телефон — логин пользователя. Хранится строго в виде `+7XXXXXXXXXX`
 * (docs/02-DATA-MODEL.md), поэтому нормализация обязана быть однозначной.
 *
 * Чистая функция: никакой БД и никаких часов.
 */

/** Национальный номер: десять цифр, первая — семёрка (мобильные коды 70x, 74x, 77x). */
const NATIONAL_LENGTH = 10;

const STORED_PATTERN = /^\+7\d{10}$/;

export function isNormalizedPhone(value: string): boolean {
  return STORED_PATTERN.test(value);
}

/**
 * Приводит запись номера к формату хранения.
 * Принимает `+7…`, `8…`, `7…` и национальные десять цифр, разделители любые.
 */
export function normalizePhone(input: string): string {
  const trimmed = input.trim();
  const hasPlus = trimmed.startsWith('+');
  const rest = hasPlus ? trimmed.slice(1) : trimmed;

  // Плюс допустим только один и только первым символом.
  if (rest.includes('+')) {
    throw new RangeError(`Не похоже на номер телефона: ${input}`);
  }

  const digits = rest.replace(/[\s()\-.]/g, '');
  if (!/^\d+$/.test(digits)) {
    throw new RangeError(`Не похоже на номер телефона: ${input}`);
  }

  const national = toNationalNumber(digits, hasPlus);
  if (national === null) {
    throw new RangeError(`Не похоже на казахстанский номер телефона: ${input}`);
  }

  return `+7${national}`;
}

/** Мягкий вариант для форм и фильтров: `null` вместо исключения. */
export function tryNormalizePhone(input: string): string | null {
  try {
    return normalizePhone(input);
  } catch {
    return null;
  }
}

function toNationalNumber(digits: string, hasPlus: boolean): string | null {
  if (digits.length === NATIONAL_LENGTH) {
    // Без кода страны запись допустима только в национальном виде и без плюса.
    return !hasPlus && digits.startsWith('7') ? digits : null;
  }

  if (digits.length === NATIONAL_LENGTH + 1) {
    const countryCode = digits.charAt(0);
    const national = digits.slice(1);

    // Восьмёрка — местная форма записи кода страны, с плюсом она бессмысленна.
    if (countryCode === '8' && !hasPlus) {
      return national.startsWith('7') ? national : null;
    }

    if (countryCode === '7') {
      return national.startsWith('7') ? national : null;
    }
  }

  return null;
}
