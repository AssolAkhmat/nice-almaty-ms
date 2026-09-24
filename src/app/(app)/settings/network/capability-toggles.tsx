'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { CAPABILITY_KEYS, type AdminCapability } from '@/lib/permissions';

import { setCapabilityAction, type NetworkActionState } from './actions';

const INITIAL: NetworkActionState = {};

/**
 * Полномочия админа, которыми распоряжается сеть (указание владельца,
 * 23 сентября 2026).
 *
 * Не `Switch`, а кнопка «Включить»/«Выключить» отдельной формой: право
 * меняется действием, у которого есть подтверждение и запись в журнал,
 * а не движением ползунка, которое легко сделать мимоходом. Заодно
 * переключатель работает без JavaScript.
 */
function Toggle({ capability, enabled }: { capability: AdminCapability; enabled: boolean }) {
  const t = useTranslations('settings.network.capabilities');
  const [state, action, isPending] = useActionState(setCapabilityAction, INITIAL);

  return (
    <div className="border-border flex flex-wrap items-start justify-between gap-4 border-t py-3 first:border-t-0">
      <div className="flex max-w-md flex-col gap-1">
        <span className="text-[15px]">{t(`${capability}.title`)}</span>
        <span className="text-text-muted text-[13px]">{t(`${capability}.hint`)}</span>

        {state.error !== undefined && (
          <span className="text-danger text-[13px]" role="alert">
            {t(state.error)}
          </span>
        )}
      </div>

      <form action={action} className="flex items-center gap-3">
        <input name="capability" type="hidden" value={capability} />
        <input name="enabled" type="hidden" value={enabled ? '0' : '1'} />

        <span className={enabled ? 'text-[13px]' : 'text-text-muted text-[13px]'}>
          {enabled ? t('on') : t('off')}
        </span>

        <Button
          data-testid={`capability-${capability}`}
          disabled={isPending}
          size="sm"
          type="submit"
          variant={enabled ? 'ghost' : 'secondary'}
        >
          {enabled ? t('disable') : t('enable')}
        </Button>
      </form>
    </div>
  );
}

export function CapabilityToggles({
  capabilities,
}: {
  capabilities: Readonly<Record<AdminCapability, boolean>>;
}) {
  const t = useTranslations('settings.network.capabilities');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>

      <div className="flex flex-col p-4 pt-0">
        <p className="text-text-muted pb-2 text-[13px]">{t('hint')}</p>

        {CAPABILITY_KEYS.map((capability) => (
          <Toggle capability={capability} enabled={capabilities[capability]} key={capability} />
        ))}
      </div>
    </Card>
  );
}
