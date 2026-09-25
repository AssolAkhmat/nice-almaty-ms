import { describe, expect, it } from 'vitest';

import { renderWelcomeMessage, welcomeMessageFor, whatsAppLink } from './welcome-message';

/**
 * Приветственное сообщение и ссылка на WhatsApp (указание владельца,
 * 25 сентября 2026). Главное здесь — что в сообщение не попадает ничего,
 * кроме адреса, логина и временного пароля.
 */
const TEMPLATE =
  'nice.aqy.kz\nЛогин: {login}\nВременный пароль: {password}\nПароль нужно сменить при первом входе.';

describe('приветственное сообщение', () => {
  it('подставляет адрес, логин и пароль', () => {
    const text = renderWelcomeMessage('{url}\n{login}\n{password}', {
      url: 'nice.aqy.kz',
      login: '+7 701 234 56 78',
      password: 'AbCdEfGhIjKl',
    });

    expect(text).toBe('nice.aqy.kz\n+7 701 234 56 78\nAbCdEfGhIjKl');
  });

  it('логин собирается из телефона в человеческом виде', () => {
    const text = welcomeMessageFor(TEMPLATE, {
      phone: '87012345678',
      password: 'AbCdEfGhIjKl',
      url: 'nice.aqy.kz',
    });

    expect(text).toContain('Логин: +7 701 234 56 78');
    expect(text).toContain('Временный пароль: AbCdEfGhIjKl');
  });

  it('незнакомые скобки шаблон не теряет: его правит человек', () => {
    expect(
      renderWelcomeMessage('{url} и {чужое}', {
        url: 'nice.aqy.kz',
        login: 'л',
        password: 'п',
      }),
    ).toBe('nice.aqy.kz и {чужое}');
  });

  it('повторяющийся плейсхолдер подставляется везде', () => {
    expect(
      renderWelcomeMessage('{password} {password}', {
        url: '',
        login: '',
        password: 'X',
      }),
    ).toBe('X X');
  });
});

describe('ссылка на WhatsApp', () => {
  it('номер только цифрами, без плюса и пробелов', () => {
    const link = whatsAppLink('+7 701 234 56 78', 'привет');

    expect(link.startsWith('https://wa.me/77012345678?text=')).toBe(true);
  });

  it('любая ходовая запись номера даёт ту же ссылку', () => {
    const expected = whatsAppLink('+77012345678', 'т');

    for (const form of ['87012345678', '8 701 234 56 78', '7012345678', '8-701-234-56-78']) {
      expect(whatsAppLink(form, 'т'), form).toBe(expected);
    }
  });

  it('текст уходит закодированным: переводы строк не ломают ссылку', () => {
    const link = whatsAppLink('87012345678', 'строка\nвторая');

    expect(link).toContain('%0A');
    expect(link).not.toContain('\n');
  });

  /*
   * Негативная фикстура к обещанию «ничего сверх этого»: в сообщении
   * не должно быть ни ИИН, ни ФИО, ни дома — проверяется тем, что функция
   * их просто не принимает, а шаблон подставляет ровно три значения.
   */
  it('подставляются ровно три значения и никакие другие', () => {
    const text = welcomeMessageFor('{url}|{login}|{password}|{iin}|{house}|{fullName}', {
      phone: '87012345678',
      password: 'X',
      url: 'nice.aqy.kz',
    });

    expect(text).toBe('nice.aqy.kz|+7 701 234 56 78|X|{iin}|{house}|{fullName}');
  });
});
