import { describe, expect, it } from 'vitest';

import { LOCALES } from './config';
import { notificationLines, notificationTexts } from './notification-texts';

/**
 * Тексты уведомлений собираются из словаря, а не пишутся в коде задания:
 * уведомление хранит все три локали, и пустая означала бы пустой экран
 * у жильца с этим языком.
 */
describe('тексты уведомления', () => {
  it('заголовок и текст заполнены во всех трёх локалях', async () => {
    const texts = await notificationTexts('rotationToday');

    for (const locale of LOCALES) {
      expect(texts.title[locale].trim(), locale).not.toBe('');
      expect(texts.body[locale].trim(), locale).not.toBe('');
    }
  });

  it('локали различаются: это перевод, а не копия русского', async () => {
    const texts = await notificationTexts('rotationToday');

    expect(texts.title.ru).not.toBe(texts.title.en);
    expect(texts.title.ru).not.toBe(texts.title.kk);
  });

  it('значения подставляются в каждую локаль', async () => {
    const texts = await notificationTexts('rotationMissed', { date: '2026-09-07' });

    for (const locale of LOCALES) {
      expect(texts.body[locale], locale).toContain('2026-09-07');
    }
  });

  it('название, живущее на трёх языках, подставляется своим переводом', async () => {
    const texts = await notificationTexts('documentExpiring', {
      document: { ru: 'Справка 086/у', kk: '086/у анықтамасы', en: 'Certificate 086/u' },
      date: '2026-10-01',
    });

    expect(texts.body.ru).toContain('Справка 086/у');
    expect(texts.body.kk).toContain('086/у анықтамасы');
    expect(texts.body.en).toContain('Certificate 086/u');
  });

  it('числовое значение подставляется как число, а не как код', async () => {
    const texts = await notificationTexts('presenceNight', {
      date: '2026-09-07',
      declared: 3,
      expired: 0,
      declaredList: '—',
      expiredList: '—',
    });

    for (const locale of LOCALES) {
      expect(texts.body[locale], locale).toContain('3');
    }
  });

  /*
   * Строки списка переводятся в каждой локали отдельно (сводка отсутствий,
   * 30 сентября 2026): собрать список на одном языке и раздать его всем
   * значило бы вернуть захардкоженную строку в уведомление.
   */
  it('строки списка приходят на всех языках', async () => {
    const lines = await notificationLines([
      {
        code: 'presenceNightRowMinor',
        values: { name: 'Иванов И.', until: '2026-10-02', reason: 'к родителям' },
      },
      {
        code: 'presenceNightRow',
        values: { name: 'Петров П.', until: '2026-10-01', reason: 'ночная смена' },
      },
    ]);

    for (const locale of LOCALES) {
      expect(lines[locale], locale).toContain('Иванов И.');
      expect(lines[locale].split('\n'), locale).toHaveLength(2);
    }

    /* Пометка несовершеннолетнего — своя в каждой локали, а не одна на все. */
    expect(lines.ru).toContain('несовершеннолетний');
    expect(lines.kk).toContain('кәмелетке толмаған');
    expect(lines.en).toContain('minor');
  });

  it('пустой список — пустая строка, а не слово на одном языке', async () => {
    const lines = await notificationLines([]);

    for (const locale of LOCALES) {
      expect(lines[locale], locale).toBe('');
    }
  });
});
