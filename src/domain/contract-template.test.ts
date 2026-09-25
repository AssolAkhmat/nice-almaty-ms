import { describe, expect, it } from 'vitest';

import {
  CONTRACT_TOKENS,
  SAMPLE_CONTRACT_VALUES,
  hasToken,
  renderContractTemplate,
  unknownTokens,
} from './contract-template';

/**
 * Подстановка в шаблон договора (docs/04-MODULES/11-users-settings.md).
 *
 * Палитра токенов задана документацией, и именно она проверяется здесь:
 * шаблон пишет суперадмин, а значения подставляет сервер, поэтому ошибка
 * в токене должна быть видна при сохранении шаблона, а не в готовом PDF.
 */
const VALUES = {
  'resident.full_name': 'Иванов Иван Иванович',
  'resident.iin': '990101300123',
  'residency.contract_start': '01.09.2026',
  'residency.contract_end': '01.07.2027',
  'bed.room': 'Комната 3',
  'bed.label': 'Место 2, верхний ярус',
  'bed.price': '120 000 ₸',
  'house.name': 'Дом 1',
  'house.address': 'Алматы, ул. Абая, 1',
  today: '15.03.2027',
  'resident.id_doc_issuer': 'МВД РК',
  'resident.registration_address': 'Алматы, ул. Сатпаева, 22, кв. 5',
  'residency.contract_number': '2026-0007',
};

describe('палитра токенов', () => {
  it('совпадает со списком из модуля 11', () => {
    expect([...CONTRACT_TOKENS]).toEqual([
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
      // T8.1: реквизиты нанимателя и номер договора.
      'resident.id_doc_issuer',
      'resident.registration_address',
      'residency.contract_number',
      // Номер документа, депозит, контакты и учёба нанимателя (сентябрь 2026).
      'resident.id_doc_number',
      'residency.deposit_amount',
      'resident.phone',
      'resident.emergency_name',
      'resident.emergency_phone',
      'resident.university',
      'resident.course',
      'resident.signature',
      // Подпись исполнителя — владелицы сети (22 сентября 2026).
      'owner.signature',
    ]);
  });
});

describe('подстановка значений', () => {
  it('заменяет токен значением', () => {
    expect(renderContractTemplate('<p>Наниматель: {{resident.full_name}}</p>', VALUES)).toBe(
      '<p>Наниматель: Иванов Иван Иванович</p>',
    );
  });

  it('заменяет все вхождения одного токена', () => {
    expect(renderContractTemplate('{{house.name}} и ещё раз {{house.name}}', VALUES)).toBe(
      'Дом 1 и ещё раз Дом 1',
    );
  });

  it('терпит пробелы внутри скобок', () => {
    expect(renderContractTemplate('{{ house.name }}', VALUES)).toBe('Дом 1');
  });

  it('оставляет текст вне токенов нетронутым', () => {
    const template = '<h1>Договор найма</h1><p>от {{today}}</p>';

    expect(renderContractTemplate(template, VALUES)).toBe(
      '<h1>Договор найма</h1><p>от 15.03.2027</p>',
    );
  });
});

describe('значения не становятся разметкой', () => {
  it('угловые скобки в значении экранируются', () => {
    const rendered = renderContractTemplate('<p>{{resident.full_name}}</p>', {
      ...VALUES,
      'resident.full_name': '<script>alert(1)</script>',
    });

    expect(rendered).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(rendered).not.toContain('<script>');
  });

  it('кавычки и амперсанд тоже экранируются', () => {
    expect(
      renderContractTemplate('{{house.address}}', {
        ...VALUES,
        'house.address': 'ул. "Абая" & Достык',
      }),
    ).toBe('ул. &quot;Абая&quot; &amp; Достык');
  });
});

describe('неизвестные токены', () => {
  it('перечисляются для проверки шаблона', () => {
    expect(unknownTokens('{{resident.full_name}} {{resident.salary}} {{house.floor}}')).toEqual([
      'resident.salary',
      'house.floor',
    ]);
  });

  it('корректный шаблон не даёт замечаний', () => {
    expect(unknownTokens('{{today}} {{ bed.price }}')).toEqual([]);
  });

  it('в готовом документе неизвестный токен — ошибка, а не дыра', () => {
    expect(() => renderContractTemplate('{{resident.salary}}', VALUES)).toThrow(/resident\.salary/);
  });

  it('пропущенное значение известного токена — тоже ошибка', () => {
    const withoutIin: Record<string, string> = { ...VALUES };
    delete withoutIin['resident.iin'];

    expect(() => renderContractTemplate('{{resident.iin}}', withoutIin)).toThrow(/resident\.iin/);
  });
});

/**
 * Предпросмотр шаблона (T8.4). Суперадмин правит договор до того, как по нему
 * заселят живого человека, и смотреть на него он должен на выдуманных данных —
 * лезть за чужим ИИН ради предпросмотра нельзя.
 */
describe('образец для предпросмотра', () => {
  it('у каждого токена палитры есть значение', () => {
    for (const token of CONTRACT_TOKENS) {
      expect(SAMPLE_CONTRACT_VALUES[token], token).toBeTruthy();
    }
  });

  it('в предпросмотре не остаётся ни одного нераскрытого токена', () => {
    const template = CONTRACT_TOKENS.map((token) => `<p>{{${token}}}</p>`).join('');

    expect(renderContractTemplate(template, SAMPLE_CONTRACT_VALUES)).not.toContain('{{');
  });
});

/**
 * Подпись жильца встаёт на место токена (указание владельца, 21 сентября 2026,
 * пересмотр P2-17). Её значение — единственное, которое вставляется разметкой:
 * это `<img>`, собранный сервером из байтов файла.
 */
describe('токен подписи', () => {
  const SIGNATURE = '<img alt="" src="data:image/png;base64,AAAA" style="max-height:120px" />';

  it('есть в палитре', () => {
    expect(CONTRACT_TOKENS).toContain('resident.signature');
  });

  it('подставляется разметкой, а не текстом', () => {
    const html = renderContractTemplate('<p>Наниматель: {{resident.signature}}</p>', {
      'resident.signature': SIGNATURE,
    });

    expect(html).toBe(`<p>Наниматель: ${SIGNATURE}</p>`);
    expect(html).not.toContain('&lt;img');
  });

  it('встаёт именно туда, где стоит токен', () => {
    const html = renderContractTemplate('<p>A{{resident.signature}}B</p>', {
      'resident.signature': SIGNATURE,
    });

    expect(html.indexOf('<img')).toBeGreaterThan(html.indexOf('A'));
    expect(html.indexOf('<img')).toBeLessThan(html.indexOf('B'));
  });

  it('до подписания раскрывается пустым значением, а не остаётся скобками', () => {
    expect(
      renderContractTemplate('<p>{{resident.signature}}</p>', { 'resident.signature': '' }),
    ).toBe('<p></p>');
  });

  /*
   * Негативная фикстура к правилу «разметкой вставляется только подпись»
   * (CLAUDE.md §2): если бы исключение распространилось на прочие токены,
   * поле профиля стало бы способом положить разметку в договор.
   */
  it('остальные значения по-прежнему экранируются', () => {
    const attack = '<script>alert(1)</script>';

    /*
     * Разметкой вставляются только подписи: их собирает сервер из байтов
     * файла. Всё остальное — данные, пришедшие от человека, и экранируется
     * без исключений. Список закрыт, и этот цикл проверяет именно закрытость.
     */
    for (const token of CONTRACT_TOKENS) {
      if (token === 'resident.signature' || token === 'owner.signature') {
        continue;
      }

      const html = renderContractTemplate(`<p>{{${token}}}</p>`, { [token]: attack });

      expect(html, token).toContain('&lt;script&gt;');
      expect(html, token).not.toContain('<script>');
    }
  });

  it('находит токен в шаблоне и не путает его с другими', () => {
    expect(hasToken('<p>{{ resident.signature }}</p>', 'resident.signature')).toBe(true);
    expect(hasToken('<p>{{resident.full_name}}</p>', 'resident.signature')).toBe(false);
    expect(hasToken('<p>подпись</p>', 'resident.signature')).toBe(false);
  });
});
