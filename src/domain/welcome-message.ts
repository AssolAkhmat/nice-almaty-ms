import { formatPhone, normalizePhone } from './phone';

/**
 * Приветственное сообщение новому жильцу и ссылка на WhatsApp
 * (указание владельца, 25 сентября 2026).
 *
 * Пароль показывается один раз, и передать его человеку надо тут же.
 * Сообщение короткое намеренно: адрес, логин, временный пароль и указание
 * сменить его. Ничего сверх этого — ни ИИН, ни названия дома, ни ФИО:
 * переписка в мессенджере остаётся у обоих навсегда, и класть туда
 * лишнее незачем.
 *
 * Чистые функции: ни БД, ни часов, ни словарей. Текст приходит готовым
 * шаблоном — из настроек сети либо из словаря.
 */
export interface WelcomeValues {
  /** Адрес приложения без схемы: `nice.aqy.kz`. */
  url: string;
  /** Телефон в человеческом виде: он же логин. */
  login: string;
  password: string;
}

const PLACEHOLDERS = ['url', 'login', 'password'] as const;

/**
 * Подстановка значений в шаблон. Неизвестные скобки остаются как есть:
 * шаблон правит человек, и терять его текст из-за опечатки нельзя.
 */
export function renderWelcomeMessage(template: string, values: WelcomeValues): string {
  let text = template;

  for (const name of PLACEHOLDERS) {
    text = text.replaceAll(`{${name}}`, values[name]);
  }

  return text;
}

/**
 * Ссылка на переписку в WhatsApp с готовым текстом.
 *
 * Номер — только цифры, без плюса и пробелов: так его ждёт wa.me.
 * Нормализация та же, что у входа, иначе номер из формы и номер в ссылке
 * разойдутся.
 */
export function whatsAppLink(phone: string, text: string): string {
  const digits = normalizePhone(phone).slice(1);

  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/** Готовое сообщение по телефону нового жильца: логин — тот же телефон. */
export function welcomeMessageFor(
  template: string,
  input: { phone: string; password: string; url: string },
): string {
  return renderWelcomeMessage(template, {
    url: input.url,
    login: formatPhone(input.phone),
    password: input.password,
  });
}
