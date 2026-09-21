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
  /* Номер документа, депозит, контакты и учёба нанимателя (сентябрь 2026). */
  'resident.id_doc_number',
  'residency.deposit_amount',
  'resident.phone',
  'resident.emergency_name',
  'resident.emergency_phone',
  'resident.university',
  'resident.course',
  /*
   * Подпись жильца (указание владельца, 21 сентября 2026; пересмотр P2-17).
   * Раньше картинка подписи приклеивалась блоком в конец документа, и место
   * подписи в договоре не настраивалось. Теперь оно задаётся токеном там,
   * где ему положено быть по тексту договора.
   */
  'resident.signature',
] as const;

export type ContractToken = (typeof CONTRACT_TOKENS)[number];

export type ContractValues = Readonly<Partial<Record<string, string>>>;

/** `{{ token }}` с любым числом пробелов внутри скобок. */
const TOKEN_PATTERN = /\{\{\s*([\w.]+)\s*\}\}/g;

function isKnown(token: string): token is ContractToken {
  return (CONTRACT_TOKENS as readonly string[]).includes(token);
}

/**
 * Токены, значение которых вставляется разметкой как есть.
 *
 * Ровно один: подпись — это `<img>` с картинкой, собранный сервером
 * из байтов файла, а не данные, пришедшие от человека. Всё остальное
 * экранируется без исключений: имя жильца, примечание, адрес — данные,
 * и тегом в документ они попасть не должны.
 *
 * Список закрыт намеренно. Добавление сюда второго токена означает, что
 * кто-то сможет положить разметку в договор через поле профиля, поэтому
 * такому токену нужна своя причина и своя негативная фикстура.
 */
const RAW_TOKENS: readonly ContractToken[] = ['resident.signature'];

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

    return RAW_TOKENS.includes(rawToken) ? value : escapeHtml(value);
  });
}

/** Есть ли токен в тексте шаблона. Нужно, чтобы знать, куда класть подпись. */
export function hasToken(template: string, token: ContractToken): boolean {
  for (const match of template.matchAll(TOKEN_PATTERN)) {
    if (match[1] === token) {
      return true;
    }
  }

  return false;
}

/**
 * Образец для предпросмотра шаблона (T8.4).
 *
 * Данные выдуманные: суперадмин смотрит на вёрстку договора до того, как
 * по нему заселили живого человека, и подставлять чужой ИИН ради предпросмотра
 * незачем. Тест держит образец полным — новый токен палитры без значения
 * оставил бы в предпросмотре сырые скобки.
 */
export const SAMPLE_CONTRACT_VALUES: Readonly<Record<ContractToken, string>> = {
  'resident.full_name': 'Иванов Иван Иванович',
  'resident.iin': '990101300123',
  'resident.id_doc_issuer': 'МВД РК',
  'resident.registration_address': 'Алматы, ул. Сатпаева, 22, кв. 5',
  'residency.contract_number': '2026-0042',
  'residency.contract_start': '01.09.2026',
  'residency.contract_end': '31.05.2027',
  'bed.room': 'Комната 3',
  'bed.label': 'Место 2, нижний ярус',
  'bed.price': '75 000 ₸',
  'house.name': 'Дом 1',
  'house.address': 'Алматы, ул. Абая, 1',
  today: '08.09.2026',
  'resident.id_doc_number': '012345678',
  'residency.deposit_amount': '75 000 ₸',
  'resident.phone': '+77011234567',
  'resident.emergency_name': 'Иванова Мария Петровна',
  'resident.emergency_phone': '+77029876543',
  'resident.university': 'КазНУ им. аль-Фараби',
  'resident.course': '2',
  /*
   * Предпросмотр показывает место подписи, а не подпись: настоящей картинки
   * до подписания не существует, а пустая строка оставила бы суперадмина
   * в неведении, куда она встанет.
   */
  'resident.signature':
    '<span style="display:inline-block;min-width:180px;border-bottom:1px solid #999">' +
    '<span style="color:#999;font-size:12px">место подписи</span></span>',
};
