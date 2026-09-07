/**
 * Шаблон договора: палитра токенов и подстановка
 * (docs/04-MODULES/11-users-settings.md, «Шаблон договора»).
 *
 * Шаблон пишет суперадмин в HTML-редакторе, значения подставляет сервер.
 * Значение всегда экранируется: имя жильца — это данные, а не разметка,
 * и попасть в документ тегом оно не должно.
 *
 * Чистые функции: ни БД, ни часов, ни хранилища.
 */
export const CONTRACT_TOKENS = [
  'resident.full_name',
  'resident.iin',
  'residency.contract_start',
  'residency.contract_end',
  'bed.room',
  'bed.label',
  'bed.price',
  'house.name',
  'house.address',
  'today',
  /* Реквизиты нанимателя и номер договора (T8.1). */
  'resident.id_doc_issuer',
  'resident.registration_address',
  'residency.contract_number',
] as const;

export type ContractToken = (typeof CONTRACT_TOKENS)[number];

export type ContractValues = Readonly<Partial<Record<string, string>>>;

/** `{{ token }}` с любым числом пробелов внутри скобок. */
const TOKEN_PATTERN = /\{\{\s*([\w.]+)\s*\}\}/g;

function isKnown(token: string): token is ContractToken {
  return (CONTRACT_TOKENS as readonly string[]).includes(token);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Токены, которых нет в палитре. Нужны при сохранении шаблона: опечатка
 * должна всплыть там, а не в договоре, который уже подписали.
 */
export function unknownTokens(template: string): string[] {
  const found: string[] = [];

  for (const match of template.matchAll(TOKEN_PATTERN)) {
    const token = match[1] ?? '';
    if (!isKnown(token) && !found.includes(token)) {
      found.push(token);
    }
  }

  return found;
}

/**
 * Подстановка значений. Неизвестный токен или отсутствующее значение —
 * ошибка: документ с дырой на месте срока или цены хуже, чем несозданный.
 */
export function renderContractTemplate(template: string, values: ContractValues): string {
  return template.replaceAll(TOKEN_PATTERN, (_match, rawToken: string) => {
    if (!isKnown(rawToken)) {
      throw new RangeError(`Неизвестный токен шаблона: ${rawToken}`);
    }

    const value = values[rawToken];
    if (value === undefined) {
      throw new RangeError(`Нет значения для токена шаблона: ${rawToken}`);
    }

    return escapeHtml(value);
  });
}
