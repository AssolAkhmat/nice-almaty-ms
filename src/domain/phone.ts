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
 * Разделители, которые человек вставляет в номер.
 *
 * `\p{Pd}` — все тире Unicode, а не только ASCII-дефис: номер, скопированный
 * из мессенджера или документа, приходит с длинным тире, и жилец из-за этого
 * не мог войти вовсе (отзыв жильца, 25 сентября 2026). Пробелы тоже любые,
 * включая неразрывный.
 */
const SEPARATORS = /[\s().\u2011/\p{Pd}]/gu;

/**
 * Приводит запись номера к формату хранения.
 *
 * Принимает `+7…`, `8…`, `7…`, `00 7…` и национальные десять цифр;
 * разделители — пробелы любого вида, скобки, точки, дроби и любые тире.
 */
export function normalizePhone(input: string): string {
  const trimmed = input.trim();
  const hasLeadingPlus = trimmed.startsWith('+');
  const rest = hasLeadingPlus ? trimmed.slice(1) : trimmed;

  // Плюс допустим только один и только первым символом.
  if (rest.includes('+')) {
    throw new RangeError(`Не похоже на номер телефона: ${input}`);
  }

  const cleaned = rest.replace(SEPARATORS, '');
  if (!/^\d+$/.test(cleaned)) {
    throw new RangeError(`Не похоже на номер телефона: ${input}`);
  }

  /*
   * `00` — международный префикс, та же роль, что у плюса: `00 7 777…`
   * равно `+7 777…`. Набирается так с городских телефонов и из-за границы.
   */
  const international = cleaned.startsWith('00');
  const digits = international ? cleaned.slice(2) : cleaned;
  const hasPlus = hasLeadingPlus || international;

  const national = toNationalNumber(digits, hasPlus);
  if (national === null) {
    throw new RangeError(
      `Номер должен быть казахстанским: +7 7XX XXX XX XX, 8 7XX XXX XX XX или 7XX XXX XX XX — получено ${input}`,
    );
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

/**
 * Человеческий вид номера: `+7 705 410 00 20`.
 *
 * Нужен полю ввода: жилец вставляет номер как придётся, и поле показывает,
 * что система поняла, — иначе «мусор в поле» остаётся мусором до отправки
 * (отзыв жильца, 25 сентября 2026). Ненормализуемая строка возвращается
 * как есть: поле не должно молча портить то, чего не разобрало.
 */
export function formatPhone(input: string): string {
  const normalized = tryNormalizePhone(input);

  if (normalized === null) {
    return input;
  }

  const digits = normalized.slice(2);

  return `+7 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 8)} ${digits.slice(8)}`;
}
