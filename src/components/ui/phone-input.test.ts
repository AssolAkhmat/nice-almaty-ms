import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { normalizePhone } from '@/domain/phone';

import { PhoneInput } from './phone-input';

/**
 * Поле телефона не спорит с тем, кто заполняет его не по одной букве
 * (322 упавших проверки приёмки, 25 сентября 2026).
 *
 * Пока поле было управляемым, подстановка `+7 ` доходила до узла после
 * события фокуса — то есть после того, как заполняющая сторона выделила
 * прежнее содержимое под замену. Перерисовка снимала выделение, номер
 * приклеивался к префиксу, и на верном номере человек читал
 * «Неверный телефон или пароль».
 *
 * Обработчики здесь вызываются напрямую, с поддельным узлом: проверяется
 * ровно то свойство, которое и было сломано, — что поле пишет в узел,
 * а не в состояние. Браузер для этого не нужен, а приёмка на трёх ширинах
 * проверяет то же самое настоящей формой.
 */
const SOURCE = readFileSync('src/components/ui/phone-input.tsx', 'utf8');

/** Признаки управляемого поля: значение из состояния и само состояние. */
const CONTROLLED = /\bvalue=\{|useState/;

interface FakeNode {
  value: string;
}

function handlers() {
  const field = PhoneInput({}) as unknown as {
    props: {
      onBlur: (event: { target: FakeNode }) => void;
      onFocus: (event: { target: FakeNode }) => void;
      onPaste: (event: {
        clipboardData: { getData: (format: string) => string };
        currentTarget: FakeNode;
        preventDefault: () => void;
      }) => void;
    };
  };

  return field.props;
}

describe('поле телефона', () => {
  it('подставляет +7 прямо в узел', () => {
    const node: FakeNode = { value: '' };

    handlers().onFocus({ target: node });

    expect(node.value).toBe('+7 ');
  });

  it('не трогает уже вставленный номер при переходе в поле', () => {
    const node: FakeNode = { value: '+77010000000' };

    handlers().onFocus({ target: node });

    expect(node.value).toBe('+77010000000');
  });

  it('при уходе показывает номер так, как его понял сервер', () => {
    const node: FakeNode = { value: '87010000000' };

    handlers().onBlur({ target: node });

    expect(node.value).toBe('+7 701 000 00 00');
  });

  it('непонятое при уходе оставляет как набрано', () => {
    const node: FakeNode = { value: '701' };

    handlers().onBlur({ target: node });

    expect(node.value).toBe('701');
  });

  it('вставка заменяет содержимое целиком, а не приклеивается к префиксу', () => {
    const node: FakeNode = { value: '+7 ' };
    let prevented = false;

    handlers().onPaste({
      clipboardData: { getData: () => '8 (701) 000-00-00' },
      currentTarget: node,
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(prevented).toBe(true);
    expect(node.value).toBe('+7 701 000 00 00');
  });

  it('приклеенный второй префикс номером не считается', () => {
    /*
     * Именно это уходило на сервер от приёмки и ушло бы от автозаполнения:
     * ответ «Неверный телефон или пароль» на верный номер.
     */
    expect(() => normalizePhone('+7 +77010000000')).toThrow();
  });

  it('поле неуправляемое: значения из состояния в нём нет', () => {
    expect(CONTROLLED.test(SOURCE)).toBe(false);
  });

  it('запрет живой: управляемое поле детектор краснит', () => {
    expect(CONTROLLED.test('const [value, setValue] = useState("");')).toBe(true);
    expect(CONTROLLED.test('<Input value={value} />')).toBe(true);
  });
});
