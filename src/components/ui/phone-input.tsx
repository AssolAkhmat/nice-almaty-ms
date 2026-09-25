'use client';

import { useState, type ClipboardEvent, type FocusEvent } from 'react';

import { formatPhone } from '@/domain/phone';

import { Input } from './input';

/**
 * Поле телефона (отзыв жильца, 25 сентября 2026).
 *
 * Делает три вещи, которых не хватало:
 *
 * 1. Подставляет `+7 ` в пустое поле при переходе в него, чтобы человек
 *    не гадал, с чего начинать.
 * 2. Вставку обрабатывает целиком: скопированный номер заменяет содержимое,
 *    а не приклеивается к уже набранному `+7` — ровно от этого получался
 *    мусор вида `+7+7 705…`.
 * 3. При уходе из поля показывает номер так, как его понял сервер:
 *    `+7 705 410 00 20`. Что не разобралось — остаётся как набрано,
 *    поле не должно молча портить непонятое.
 *
 * Разбирать номер здесь нечем и незачем: разбор один на всё приложение,
 * в `src/domain/phone.ts`, и отправляется на сервер исходная строка —
 * нормализацию всё равно делает он.
 */
export function PhoneInput({
  defaultValue = '',
  ...rest
}: Omit<React.ComponentProps<typeof Input>, 'onFocus' | 'onBlur' | 'onPaste' | 'value'>) {
  const [value, setValue] = useState(defaultValue === '' ? '' : formatPhone(String(defaultValue)));

  return (
    <Input
      {...rest}
      autoComplete="tel"
      inputMode="tel"
      onBlur={(event: FocusEvent<HTMLInputElement>) => {
        setValue(formatPhone(event.target.value));
      }}
      onChange={(event) => {
        setValue(event.target.value);
      }}
      onFocus={(event: FocusEvent<HTMLInputElement>) => {
        if (event.target.value === '') {
          setValue('+7 ');
        }
      }}
      onPaste={(event: ClipboardEvent<HTMLInputElement>) => {
        event.preventDefault();
        setValue(formatPhone(event.clipboardData.getData('text')));
      }}
      placeholder="+7 700 000 00 00"
      type="tel"
      value={value}
    />
  );
}
