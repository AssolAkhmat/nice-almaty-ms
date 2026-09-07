import { describe, expect, it } from 'vitest';

import { parseBusinessDate } from '@/lib/time';

import { buildDayTemplate, type TemplateEntry } from './rotation-template';

/**
 * Шаблон дня для группы (docs/03-BUSINESS-RULES.md §6.7):
 * `шапка + дата + зоны с исполнителями + футер`, plain text.
 */
const DATE = parseBusinessDate('2026-09-07');

/** Подписи приходят из словаря интерфейса — ядро своих слов не знает. */
const LABELS = { empty: 'Сегодня ротаций нет', unassigned: 'не назначен' };

const ENTRIES: TemplateEntry[] = [
  { areaName: 'Двор', checklistTitle: 'Обычная', people: ['Азамат', 'Данияр'] },
  { areaName: 'Кухня', checklistTitle: 'Обычная', people: ['Алия'] },
];

describe('шаблон дня', () => {
  it('собирает шапку, дату, зоны с исполнителями и футер', () => {
    expect(
      buildDayTemplate({
        header: 'Дежурства на',
        footer: 'Спасибо!',
        date: DATE,
        entries: ENTRIES,
        labels: LABELS,
      }),
    ).toBe(
      ['Дежурства на 07.09.2026', '', 'Двор — Азамат, Данияр', 'Кухня — Алия', '', 'Спасибо!'].join(
        '\n',
      ),
    );
  });

  it('дата пишется по-человечески, а не в формате базы', () => {
    expect(
      buildDayTemplate({ header: 'На', footer: '', date: DATE, entries: [], labels: LABELS }),
    ).toContain('07.09.2026');
  });

  it('пустая шапка не оставляет пустой строки в начале', () => {
    const text = buildDayTemplate({
      header: '',
      footer: 'Всё',
      date: DATE,
      entries: ENTRIES,
      labels: LABELS,
    });

    expect(text.startsWith('07.09.2026')).toBe(true);
  });

  it('пустой футер не оставляет хвоста', () => {
    const text = buildDayTemplate({
      header: 'На',
      footer: '',
      date: DATE,
      entries: ENTRIES,
      labels: LABELS,
    });

    expect(text.endsWith('Кухня — Алия')).toBe(true);
  });

  it('зона без исполнителя названа, а не пропущена', () => {
    const text = buildDayTemplate({
      header: '',
      footer: '',
      date: DATE,
      entries: [{ areaName: 'Двор', checklistTitle: 'Обычная', people: [] }],
      labels: LABELS,
    });

    expect(text).toContain('Двор — не назначен');
  });

  it('день без ротаций честно об этом говорит', () => {
    const text = buildDayTemplate({
      header: 'На',
      footer: 'Спасибо',
      date: DATE,
      entries: [],
      labels: LABELS,
    });

    expect(text).toContain('ротаций нет');
  });

  it('переносы строк из шапки сохраняются: её пишет человек', () => {
    const text = buildDayTemplate({
      header: 'Доброе утро!\nДежурства на',
      footer: '',
      date: DATE,
      entries: ENTRIES,
      labels: LABELS,
    });

    expect(text.startsWith('Доброе утро!\nДежурства на 07.09.2026')).toBe(true);
  });
});
