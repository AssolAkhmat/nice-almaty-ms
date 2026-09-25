import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { normalizePhone } from '@/domain/phone';

import { PHONE_PREFIX, PhoneInput } from './phone-input';

/**
 * Поле телефона не спорит с тем, кто заполняет его не по одной букве
 * (305 упавших проверок приёмки, 25 сентября 2026).
 *
 * Драйвер приёмки и автозаполнение браузера делают три шага в таком порядке:
 * `input.select()`, `input.focus()`, вставка текста поверх выделения. Порядок
 * взят из кода `playwright-core` (`selectText`), а не предположен, и здесь
 * повторяется шаг в шаг: подстановка на фокусе приходила после выделения,
 * снимала его, и номер приклеивался к префиксу.
 *
 * Обработчики вызываются напрямую, с поддельным узлом: браузер для этого
 * не нужен, а приёмка на трёх ширинах проверяет то же настоящей формой.
 */
const SOURCE = readFileSync('src/components/ui/phone-input.tsx', 'utf8');

/** Признаки поля, спорящего с вставкой: состояние и подстановка на фокусе. */
const FIGHTS_INPUT = /\bvalue=\{|useState|onFocus=\{/;

interface FakeNode {
  selectionEnd: number;
  selectionStart: number;
  value: string;
}

function node(value: string): FakeNode {
  return { selectionEnd: value.length, selectionStart: value.length, value };
}

interface FieldProps {
  defaultValue?: unknown;
  onBlur: (event: { target: FakeNode }) => void;
  onFocus?: (event: { target: FakeNode }) => void;
  onPaste: (event: {
    clipboardData: { getData: (format: string) => string };
    currentTarget: FakeNode;
    preventDefault: () => void;
  }) => void;
}

function field(defaultValue?: string): FieldProps {
  const element = PhoneInput(defaultValue === undefined ? {} : { defaultValue }) as unknown as {
    props: FieldProps;
  };

  return element.props;
}

/**
 * Заполнение чужими руками: выделить всё, перевести фокус, вставить текст
 * поверх выделения. Ровно эти три шага и в этом порядке.
 */
function fillLikeDriver(props: FieldProps, target: FakeNode, text: string): string {
  target.selectionStart = 0;
  target.selectionEnd = target.value.length;

  props.onFocus?.({ target });

  target.value =
    target.value.slice(0, target.selectionStart) + text + target.value.slice(target.selectionEnd);

  /* Нажатие на кнопку уводит фокус из поля. */
  props.onBlur({ target });

  return target.value;
}

describe('поле телефона', () => {
  it('пустое поле показывает префикс начальным значением', () => {
    expect(field().defaultValue).toBe(PHONE_PREFIX);
  });

  it('заполненное поле показывает номер разобранным', () => {
    expect(field('87010000000').defaultValue).toBe('+7 701 000 00 00');
  });

  it('заполнение чужими руками кладёт в поле ровно вставленный номер', () => {
    const props = field();
    const target = node(String(props.defaultValue));

    const filled = fillLikeDriver(props, target, '+77010000000');

    expect(filled).toBe('+7 701 000 00 00');
    expect(normalizePhone(filled)).toBe('+77010000000');
  });

  it('заполнение поверх прежнего номера тоже заменяет его целиком', () => {
    const props = field('+77010000000');
    const target = node(String(props.defaultValue));

    expect(normalizePhone(fillLikeDriver(props, target, '87055550001'))).toBe('+77055550001');
  });

  it('при уходе из поля один префикс стирается: required ловит незаполненное', () => {
    const props = field();
    const target = node(PHONE_PREFIX);

    props.onBlur({ target });

    expect(target.value).toBe('');
  });

  it('непонятое при уходе оставляет как набрано', () => {
    const target = node('701');

    field().onBlur({ target });

    expect(target.value).toBe('701');
  });

  it('вставка заменяет содержимое целиком, а не приклеивается к префиксу', () => {
    const target = node(PHONE_PREFIX);
    let prevented = false;

    field().onPaste({
      clipboardData: { getData: () => '8 (701) 000-00-00' },
      currentTarget: target,
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(prevented).toBe(true);
    expect(target.value).toBe('+7 701 000 00 00');
  });

  it('приклеенный второй префикс номером не считается', () => {
    /*
     * Именно это уходило на сервер от приёмки и ушло бы от автозаполнения:
     * ответ «Неверный телефон или пароль» на верный номер.
     */
    expect(() => normalizePhone('+7 +77010000000')).toThrow();
  });

  it('поле не спорит с вставкой: ни состояния, ни подстановки на фокусе', () => {
    expect(FIGHTS_INPUT.test(SOURCE)).toBe(false);
  });

  it('запрет живой: состояние и обработчик фокуса детектор краснит', () => {
    expect(FIGHTS_INPUT.test('const [value, setValue] = useState("");')).toBe(true);
    expect(FIGHTS_INPUT.test('<Input value={value} />')).toBe(true);
    expect(FIGHTS_INPUT.test('onFocus={(event) => { event.target.value = "+7 "; }}')).toBe(true);
  });
});
