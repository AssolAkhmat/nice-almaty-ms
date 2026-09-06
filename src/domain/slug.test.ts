import { describe, expect, it } from 'vitest';

import { slugify, uniqueSlug } from './slug';

describe('слаг из названия', () => {
  it('переводит кириллицу в латиницу', () => {
    expect(slugify('Дом 1')).toBe('dom-1');
    expect(slugify('Общежитие Алматы')).toBe('obschezhitie-almaty');
  });

  it('понимает казахские буквы', () => {
    expect(slugify('Үй Қазақ')).toBe('uy-qazaq');
    expect(slugify('Әсем')).toBe('asem');
  });

  it('схлопывает разделители и обрезает края', () => {
    expect(slugify('  Дом   №  3 !!! ')).toBe('dom-3');
    // «ы» и «й» дают одну и ту же латинскую y — это допустимо для пути хранения.
    expect(slugify('Дом--первый')).toBe('dom-pervyy');
  });

  it('латиницу оставляет как есть', () => {
    expect(slugify('Nice Almaty House')).toBe('nice-almaty-house');
  });

  it('не оставляет дефис на конце после обрезки', () => {
    expect(slugify('a'.repeat(59) + ' хвост')).not.toMatch(/-$/);
  });

  it('пустой результат — ошибка, а не пустой путь хранения', () => {
    expect(() => slugify('!!!')).toThrow(/слаг/i);
    expect(() => slugify('   ')).toThrow(/слаг/i);
    expect(() => slugify('')).toThrow(/слаг/i);
  });
});

describe('уникальность слага', () => {
  it('свободный отдаётся как есть', () => {
    expect(uniqueSlug('Дом 1', new Set())).toBe('dom-1');
  });

  it('занятый получает числовой хвост', () => {
    expect(uniqueSlug('Дом 1', new Set(['dom-1']))).toBe('dom-1-2');
    expect(uniqueSlug('Дом 1', new Set(['dom-1', 'dom-1-2']))).toBe('dom-1-3');
  });

  it('разные названия не сталкиваются без нужды', () => {
    const taken = new Set(['dom-1']);

    expect(uniqueSlug('Дом 2', taken)).toBe('dom-2');
  });
});
