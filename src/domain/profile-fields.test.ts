import { describe, expect, it } from 'vitest';

import {
  canonicalValue,
  displayValue,
  missingRequiredFields,
  sampleValue,
  validateDeclaredValues,
  type FieldDeclaration,
} from './profile-fields';

/**
 * Разбор значений объявленных полей (T12.2).
 *
 * Ядро чистое: ни базы, ни `Date.now()`. Числовые и текстовые примеры —
 * из решения D31: число без пробелов, дата `ГГГГ-ММ-ДД`, да/нет `true`/`false`,
 * выбор — код варианта.
 */
/**
 * Отказ читается кодом и полем: правило увиденного отказа требует, чтобы
 * сообщение называло причину, а не факт. Поэтому проверяется не только то,
 * что отказ был, но и то, о каком поле он говорит.
 */
function failure(body: () => unknown): { code: string; field: unknown } {
  try {
    body();
  } catch (error) {
    const refusal = error as { details?: { field?: unknown }; message: string };

    return { code: refusal.message, field: refusal.details?.field };
  }

  throw new Error('ожидался отказ, а его не было');
}

function declaration(patch: Partial<FieldDeclaration> = {}): FieldDeclaration {
  return {
    code: 'kafedra',
    isRequired: false,
    options: [],
    type: 'text',
    ...patch,
  };
}

describe('приведение значения к каноническому виду', () => {
  it('строку обрезает по краям', () => {
    expect(canonicalValue(declaration(), '  Механика  ')).toBe('Механика');
  });

  it('пустую строку считает отсутствием значения', () => {
    expect(canonicalValue(declaration(), '   ')).toBeNull();
    expect(canonicalValue(declaration(), '')).toBeNull();
  });

  it('число принимает с запятой и с пробелами разрядов, отдаёт с точкой', () => {
    const number = declaration({ type: 'number' });

    expect(canonicalValue(number, '1 234,5')).toBe('1234.5');
    expect(canonicalValue(number, '-7')).toBe('-7');
    expect(canonicalValue(number, '3.25')).toBe('3.25');
  });

  it('не число отвергает с причиной', () => {
    expect(() => canonicalValue(declaration({ type: 'number' }), 'скоро')).toThrow(
      /profileFieldNotNumber/,
    );
  });

  it('дату принимает и в точках, и в ISO', () => {
    const date = declaration({ type: 'date' });

    expect(canonicalValue(date, '07.09.2026')).toBe('2026-09-07');
    expect(canonicalValue(date, '2026-09-07')).toBe('2026-09-07');
  });

  it('несуществующую дату отвергает', () => {
    const date = declaration({ type: 'date' });

    expect(() => canonicalValue(date, '31.02.2026')).toThrow(/profileFieldNoSuchDate/);
    expect(() => canonicalValue(date, 'вчера')).toThrow(/profileFieldNotDate/);
  });

  it('да/нет понимает отметку флажка и слова', () => {
    const flag = declaration({ type: 'boolean' });

    expect(canonicalValue(flag, 'on')).toBe('true');
    expect(canonicalValue(flag, 'true')).toBe('true');
    expect(canonicalValue(flag, '')).toBe('false');
    expect(canonicalValue(flag, 'false')).toBe('false');
  });

  it('выбор принимает только объявленный вариант', () => {
    const choice = declaration({ type: 'choice', options: ['grant', 'platnoe'] });

    expect(canonicalValue(choice, 'grant')).toBe('grant');
    expect(() => canonicalValue(choice, 'skidka')).toThrow(/profileFieldNoSuchOption/);
  });
});

describe('проверка набора значений', () => {
  const defs = [
    declaration({ code: 'kafedra', isRequired: true }),
    declaration({ code: 'kurs', type: 'number' }),
    declaration({ code: 'soglasie', type: 'boolean', isRequired: true }),
  ];

  it('принимает заполненное и возвращает канонические значения', () => {
    const result = validateDeclaredValues(defs, {
      kafedra: 'Механика',
      kurs: '3',
      soglasie: 'on',
    });

    expect(result).toEqual({ kafedra: 'Механика', kurs: '3', soglasie: 'true' });
  });

  it('пустое необязательное поле означает стирание значения', () => {
    const result = validateDeclaredValues(defs, { kafedra: 'Механика', kurs: '', soglasie: 'on' });

    expect(result.kurs).toBeNull();
  });

  it('незаполненное обязательное поле называет себя', () => {
    expect(failure(() => validateDeclaredValues(defs, { kurs: '3', soglasie: 'on' }))).toEqual({
      code: 'profileFieldRequired',
      field: 'kafedra',
    });
  });

  it('обязательное да/нет требует отметки, а не просто наличия', () => {
    expect(
      failure(() => validateDeclaredValues(defs, { kafedra: 'Механика', soglasie: '' })),
    ).toEqual({ code: 'profileFieldNeedsMark', field: 'soglasie' });
  });

  it('неизвестный код не проходит молча', () => {
    expect(
      failure(() =>
        validateDeclaredValues(defs, { kafedra: 'Механика', soglasie: 'on', vydumka: 'x' }),
      ),
    ).toEqual({ code: 'profileFieldUnknown', field: 'vydumka' });
  });

  it('архивированное поле в наборе не принимается', () => {
    const archived = [...defs, declaration({ code: 'staroe', isArchived: true })];

    expect(
      failure(() =>
        validateDeclaredValues(archived, {
          kafedra: 'Механика',
          soglasie: 'on',
          staroe: 'что-то',
        }),
      ),
    ).toEqual({ code: 'profileFieldArchived', field: 'staroe' });
  });

  it('архивированное обязательное поле не требуется заполнять', () => {
    const archived = [
      declaration({ code: 'staroe', isArchived: true, isRequired: true }),
      declaration({ code: 'kafedra', isRequired: true }),
    ];

    expect(validateDeclaredValues(archived, { kafedra: 'Механика' })).toEqual({
      kafedra: 'Механика',
    });
  });
});

describe('показ значения человеку', () => {
  it('да/нет и дату показывает по-человечески, прочее как есть', () => {
    const labels = { no: 'нет', yes: 'да' };

    expect(displayValue(declaration({ type: 'boolean' }), 'true', labels)).toBe('да');
    expect(displayValue(declaration({ type: 'boolean' }), 'false', labels)).toBe('нет');
    expect(displayValue(declaration({ type: 'date' }), '2026-09-07', labels)).toBe('07.09.2026');
    expect(displayValue(declaration(), 'Механика', labels)).toBe('Механика');
  });
});

describe('образец значения для предпросмотра договора', () => {
  it('есть на каждый из пяти типов', () => {
    expect(sampleValue(declaration({ type: 'text' }))).not.toBe('');
    expect(sampleValue(declaration({ type: 'number' }))).not.toBe('');
    expect(sampleValue(declaration({ type: 'date' }))).not.toBe('');
    expect(sampleValue(declaration({ type: 'boolean' }))).not.toBe('');
    expect(sampleValue(declaration({ type: 'choice', options: ['grant'] }))).toBe('grant');
  });
});

describe('незаполненные обязательные поля', () => {
  it('перечисляет только действующие и только пустые', () => {
    const defs = [
      declaration({ code: 'kafedra', isRequired: true }),
      declaration({ code: 'kurs', isRequired: true, type: 'number' }),
      declaration({ code: 'soglasie', isRequired: true, type: 'boolean' }),
      declaration({ code: 'staroe', isArchived: true, isRequired: true }),
      declaration({ code: 'neobyazatelnoe' }),
    ];

    expect(
      missingRequiredFields(defs, {
        kafedra: 'Механика',
        kurs: null,
        soglasie: 'false',
        staroe: null,
      }),
    ).toEqual(['kurs', 'soglasie']);
  });

  it('на заполненном наборе пусто', () => {
    const defs = [declaration({ code: 'kafedra', isRequired: true })];

    expect(missingRequiredFields(defs, { kafedra: 'Механика' })).toEqual([]);
  });
});
