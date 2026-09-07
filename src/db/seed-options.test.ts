import { describe, expect, it } from 'vitest';

import { parseSeedArguments } from './seed-options';

/**
 * Разбор аргументов `pnpm db:seed`.
 *
 * Скелет нужен там, где сеть уже живая: восстановить типы документов, шаблон
 * договора и счета сети, не заведя при этом пять демо-домов с жильцами.
 * Экранов у этих трёх сущностей нет (модули 10 и 11), поэтому единственный
 * способ их вернуть — сид, и он обязан уметь остановиться на скелете.
 */
describe('аргументы сида', () => {
  it('без аргументов сеть наполняется целиком', () => {
    expect(parseSeedArguments([])).toEqual({});
  });

  it('--skeleton не заводит ни домов, ни наполнения', () => {
    expect(parseSeedArguments(['--skeleton'])).toEqual({ houses: 0, withContent: false });
  });

  it('неизвестный аргумент останавливает сид, а не молча меняет его смысл', () => {
    expect(() => parseSeedArguments(['--skeletn'])).toThrow(/--skeletn/);
    expect(() => parseSeedArguments(['--skeletn'])).toThrow(/--skeleton/);
  });
});
