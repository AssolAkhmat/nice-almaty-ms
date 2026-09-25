'use client';

import { Eye } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { PhoneInput } from '@/components/ui/phone-input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, Input, Select } from '@/components/ui/input';

import {
  revealAction,
  saveProfileAction,
  type ProfileActionState,
  type RevealState,
} from './actions';

export interface ProfileFormValues {
  lastName: string;
  firstName: string;
  middleName: string;
  sex: string;
  birthDate: string;
  phone: string;
  idDocIssuer: string;
  registrationAddress: string;
  university: string;
  course: string;
  major: string;
  emergencyName: string;
  emergencyPhone: string;
  emergencyRelation: string;
  preferredPayment: string;
  noEpilepsy: boolean;
  noAsthma: boolean;
  iinMasked: string | null;
  idDocNumberMasked: string | null;
}

export interface PlacementView {
  room: string | null;
  bed: string | null;
}

const INITIAL: ProfileActionState = {};
const INITIAL_REVEAL: RevealState = {};

export function ProfileForm({
  values,
  placement,
  userId,
  canReplaceSecrets = false,
}: {
  values: ProfileFormValues;
  placement: PlacementView;
  /**
   * Чей профиль. Пусто — свой: так эту форму открывает жилец. Заполнено —
   * чужой, и тогда её открывает карточка жильца: форма одна на оба случая,
   * иначе копия однажды разошлась бы с оригиналом (25 сентября 2026).
   */
  userId?: string;
  /** Исправлять уже введённые ИИН и номер удостоверения (суперадмин). */
  canReplaceSecrets?: boolean;
}) {
  const t = useTranslations();
  const [state, action, isPending] = useActionState(saveProfileAction, INITIAL);
  const [reveal, revealFormAction, isRevealPending] = useActionState(revealAction, INITIAL_REVEAL);

  function revealed(field: 'iin' | 'idDocNumber'): string | null {
    return reveal.field === field ? (reveal.value ?? null) : null;
  }

  return (
    <div className="flex flex-col gap-6">
      {/*
        Комната и место только для чтения: их назначает админ (модуль 1).
        Жилец не может изменить ни место, ни цену, ни статус, ни даты договора.
      */}
      <Card>
        <CardHeader>
          <CardTitle>{t('profile.placement.title')}</CardTitle>
        </CardHeader>
        <dl className="flex flex-wrap gap-6 text-[15px]">
          <div>
            <dt className="text-label">{t('profile.placement.room')}</dt>
            <dd>{placement.room ?? t('profile.placement.notAssigned')}</dd>
          </div>
          <div>
            <dt className="text-label">{t('profile.placement.bed')}</dt>
            <dd>{placement.bed ?? t('profile.placement.notAssigned')}</dd>
          </div>
        </dl>
      </Card>

      <form action={action} className="flex flex-col gap-6" data-testid="profile-form">
        {/* Чей профиль: пусто — свой. Право на чужой проверяет сервис. */}
        {userId !== undefined && <input name="userId" type="hidden" value={userId} />}
        <Card>
          <CardHeader>
            <CardTitle>{t('profile.sections.personal')}</CardTitle>
          </CardHeader>

          <div className="grid gap-3 md:grid-cols-2">
            <Field htmlFor="lastName" label={t('profile.fields.lastName')}>
              <Input
                data-testid="last-name"
                defaultValue={values.lastName}
                id="lastName"
                name="lastName"
              />
            </Field>
            <Field htmlFor="firstName" label={t('profile.fields.firstName')}>
              <Input defaultValue={values.firstName} id="firstName" name="firstName" />
            </Field>
            <Field htmlFor="middleName" label={t('profile.fields.middleName')}>
              <Input defaultValue={values.middleName} id="middleName" name="middleName" />
            </Field>
            <Field htmlFor="sex" label={t('profile.fields.sex')}>
              <Select defaultValue={values.sex} id="sex" name="sex">
                <option value="">{t('profile.fields.notChosen')}</option>
                <option value="male">{t('profile.sex.male')}</option>
                <option value="female">{t('profile.sex.female')}</option>
              </Select>
            </Field>
            <Field htmlFor="birthDate" label={t('profile.fields.birthDate')}>
              <Input defaultValue={values.birthDate} id="birthDate" name="birthDate" type="date" />
            </Field>
            <Field htmlFor="phone" label={t('profile.fields.phone')}>
              <PhoneInput defaultValue={values.phone} id="phone" name="phone" />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('profile.sections.documents')}</CardTitle>
          </CardHeader>

          <div className="grid gap-3 md:grid-cols-2">
            <SensitiveInput
              canReplace={canReplaceSecrets}
              current={values.iinMasked}
              hint={t('profile.fields.iinHint')}
              label={t('profile.fields.iin')}
              name="iin"
              revealed={revealed('iin')}
            />
            <SensitiveInput
              canReplace={canReplaceSecrets}
              current={values.idDocNumberMasked}
              hint={t('profile.fields.idDocHint')}
              label={t('profile.fields.idDocNumber')}
              name="idDocNumber"
              revealed={revealed('idDocNumber')}
            />
            {/*
              Орган выдачи и адрес прописки лежали в карточке «Учёба» —
              ошибка вёрстки: это реквизиты удостоверения, и человек искал
              их здесь (отзыв владельца, 25 сентября 2026).
            */}
            <Field htmlFor="idDocIssuer" label={t('profile.fields.idDocIssuer')}>
              <Input defaultValue={values.idDocIssuer} id="idDocIssuer" name="idDocIssuer" />
            </Field>
            <Field htmlFor="registrationAddress" label={t('profile.fields.registrationAddress')}>
              <Input
                defaultValue={values.registrationAddress}
                id="registrationAddress"
                name="registrationAddress"
              />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('profile.sections.study')}</CardTitle>
          </CardHeader>

          <div className="grid gap-3 md:grid-cols-3">
            <Field htmlFor="university" label={t('profile.fields.university')}>
              <Input defaultValue={values.university} id="university" name="university" />
            </Field>
            <Field htmlFor="course" label={t('profile.fields.course')}>
              <Input
                defaultValue={values.course}
                id="course"
                inputMode="numeric"
                max={8}
                min={1}
                name="course"
                type="number"
              />
            </Field>
            <Field htmlFor="major" label={t('profile.fields.major')}>
              <Input defaultValue={values.major} id="major" name="major" />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('profile.sections.emergency')}</CardTitle>
          </CardHeader>

          <div className="grid gap-3 md:grid-cols-3">
            <Field htmlFor="emergencyName" label={t('profile.fields.emergencyName')}>
              <Input defaultValue={values.emergencyName} id="emergencyName" name="emergencyName" />
            </Field>
            <Field htmlFor="emergencyPhone" label={t('profile.fields.emergencyPhone')}>
              <Input
                defaultValue={values.emergencyPhone}
                id="emergencyPhone"
                inputMode="tel"
                name="emergencyPhone"
              />
            </Field>
            <Field htmlFor="emergencyRelation" label={t('profile.fields.emergencyRelation')}>
              <Input
                defaultValue={values.emergencyRelation}
                id="emergencyRelation"
                name="emergencyRelation"
              />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('profile.sections.other')}</CardTitle>
          </CardHeader>

          <div className="flex flex-col gap-4">
            <Field htmlFor="preferredPayment" label={t('profile.fields.preferredPayment')}>
              <Select
                defaultValue={values.preferredPayment}
                id="preferredPayment"
                name="preferredPayment"
              >
                <option value="">{t('profile.fields.notChosen')}</option>
                <option value="kaspi">Kaspi</option>
                <option value="cash">{t('profile.payment.cash')}</option>
              </Select>
            </Field>

            <label className="flex items-center gap-3 text-[15px]">
              <Checkbox defaultChecked={values.noEpilepsy} name="noEpilepsy" value="on" />
              {t('profile.fields.noEpilepsy')}
            </label>
            <label className="flex items-center gap-3 text-[15px]">
              <Checkbox defaultChecked={values.noAsthma} name="noAsthma" value="on" />
              {t('profile.fields.noAsthma')}
            </label>
          </div>
        </Card>

        {state.error !== undefined ? (
          <p className="text-danger text-[13px]" data-testid="profile-error" role="alert">
            {t(state.error)}
          </p>
        ) : null}
        {state.done !== undefined ? (
          <p className="text-success text-[13px]" data-testid="profile-saved" role="status">
            {t(state.done)}
          </p>
        ) : null}

        <div>
          <Button data-testid="profile-submit" disabled={isPending} type="submit">
            {isPending ? t('common.loading') : t('profile.submit')}
          </Button>
        </div>
      </form>

      {/* Раскрытие вынесено в отдельную форму: это отдельное действие с записью в журнал. */}
      <form action={revealFormAction} className="hidden" id="reveal-form">
        {userId !== undefined && <input name="userId" type="hidden" value={userId} />}
        <input name="field" type="hidden" />
      </form>

      {reveal.error !== undefined ? (
        <p className="text-danger text-[13px]" role="alert">
          {t(reveal.error)}
        </p>
      ) : null}

      <RevealButtons isPending={isRevealPending} />
    </div>
  );
}

export function SensitiveInput({
  name,
  label,
  hint,
  current,
  revealed,
  canReplace = false,
}: {
  name: 'iin' | 'idDocNumber';
  label: string;
  hint: string;
  current: string | null;
  revealed: string | null;
  /**
   * Можно ли исправить уже введённое значение (указание владельца,
   * 25 сентября 2026). Поле исчезало навсегда после первого ввода,
   * а опечатка в ИИН — вещь обычная, и исправить её было нечем.
   *
   * Право узкое: исправляет суперадмин. Сохранение и запись в журнал
   * у этого пути те же, что у первого ввода, — сервис перезаписывает
   * значение и пишет разницу.
   */
  canReplace?: boolean;
}) {
  const t = useTranslations();
  const [replacing, setReplacing] = useState(false);

  if (current !== null && replacing) {
    return (
      <Field hint={t('profile.fields.replaceHint')} htmlFor={name} label={label}>
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            data-testid={`${name}-replace`}
            id={name}
            inputMode="numeric"
            name={name}
          />
          <Button
            onClick={() => {
              setReplacing(false);
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t('common.close')}
          </Button>
        </div>
      </Field>
    );
  }

  return (
    <Field hint={hint} htmlFor={name} label={label}>
      {current === null ? (
        <Input data-testid={name} id={name} inputMode="numeric" name={name} />
      ) : (
        <div className="flex items-center gap-2">
          <span className="tabular text-[15px]" data-testid={`${name}-masked`}>
            {revealed ?? current}
          </span>
          {revealed === null ? (
            <Button
              aria-label={t('profile.reveal')}
              data-testid={`reveal-${name}`}
              form="reveal-form"
              name="field"
              size="sm"
              type="submit"
              value={name}
              variant="ghost"
            >
              <Eye aria-hidden="true" size={16} strokeWidth={1.5} />
            </Button>
          ) : (
            <Badge tone="warning">{t('profile.revealed')}</Badge>
          )}

          {canReplace && (
            <Button
              data-testid={`replace-${name}`}
              onClick={() => {
                setReplacing(true);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t('profile.replace')}
            </Button>
          )}
        </div>
      )}
    </Field>
  );
}

function RevealButtons({ isPending }: { isPending: boolean }) {
  const t = useTranslations();

  return isPending ? (
    <p className="text-text-muted text-[13px]" role="status">
      {t('common.loading')}
    </p>
  ) : null;
}
