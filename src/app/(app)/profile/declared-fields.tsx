'use client';

import { useLocale, useTranslations } from 'next-intl';

import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, Input, Select } from '@/components/ui/input';

import { displayValue } from '@/domain/profile-fields';

import type { DeclaredFieldView } from '@/services/profile-fields';

/**
 * Дополнительные поля профиля в форме (T12.2).
 *
 * Поля рисуются по объявлению сети, а не по коду: название берётся
 * из `name_i18n` на языке читающего, тип решает, какой это элемент ввода.
 * Словарь здесь только для заголовка раздела и подписей да/нет — названия
 * заводит суперадмин, и в словарях их быть не может.
 *
 * Архивированное поле показывается только со значением и только для чтения:
 * на него ссылаются подписанные договоры, а заполнять его больше нельзя.
 *
 * Список кодов уходит скрытым полем: снятый флажок в форму не попадает,
 * и без списка «нет» было бы не отличить от «не присылали».
 */
export function DeclaredFields({ fields }: { fields: DeclaredFieldView[] }) {
  const locale = useLocale();
  const t = useTranslations('profile');

  if (fields.length === 0) {
    return null;
  }

  const editable = fields.filter((field) => !field.isArchived);

  function label(field: DeclaredFieldView): string {
    return field.nameI18n[locale] ?? field.nameI18n.ru ?? field.code;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('sections.declared')}</CardTitle>
      </CardHeader>

      <input name="declaredCodes" type="hidden" value={editable.map((one) => one.code).join(',')} />

      <div className="flex flex-col gap-4">
        {fields.map((field) => {
          const name = `field_${field.code}`;
          const testId = `declared-${field.code}`;

          if (field.isArchived) {
            return (
              <div className="flex flex-col gap-1" key={field.id}>
                <span className="text-text-muted text-[13px]">
                  {label(field)} — {t('declared.archived')}
                </span>
                <span data-testid={testId}>
                  {field.value === null
                    ? ''
                    : displayValue(
                        {
                          code: field.code,
                          isRequired: field.isRequired,
                          options: field.options,
                          type: field.type,
                        },
                        field.value,
                        { no: t('declared.no'), yes: t('declared.yes') },
                      )}
                </span>
              </div>
            );
          }

          if (field.type === 'boolean') {
            return (
              <label className="flex items-center gap-3 text-[15px]" key={field.id}>
                <Checkbox
                  data-testid={testId}
                  defaultChecked={field.value === 'true'}
                  name={name}
                  value="on"
                />
                {label(field)}
                {field.isRequired ? ' *' : ''}
              </label>
            );
          }

          return (
            <Field
              htmlFor={name}
              key={field.id}
              label={`${label(field)}${field.isRequired ? ' *' : ''}`}
            >
              {field.type === 'choice' ? (
                <Select
                  data-testid={testId}
                  defaultValue={field.value ?? ''}
                  id={name}
                  name={name}
                  required={field.isRequired}
                >
                  <option value="">{t('fields.notChosen')}</option>
                  {field.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  data-testid={testId}
                  defaultValue={field.value ?? ''}
                  id={name}
                  inputMode={field.type === 'number' ? 'decimal' : undefined}
                  name={name}
                  required={field.isRequired}
                  type={field.type === 'date' ? 'date' : 'text'}
                />
              )}
            </Field>
          );
        })}
      </div>
    </Card>
  );
}
