import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/badge';

import type { OnboardingStep, OnboardingStepKey } from '@/services/onboarding';
import type { Route } from 'next';

/** Куда ведёт шаг. Место назначает админ, поэтому у него ссылки нет. */
const STEP_LINKS: Readonly<Partial<Record<OnboardingStepKey, Route>>> = {
  profile: '/profile',
  contract: '/contract',
  documents: '/documents',
  deposit: '/deposit',
};

/**
 * Мастер заселения (docs/04-MODULES/01-onboarding.md).
 *
 * Шаги идут в порядке §1.2 и ни один не пропускается. Первый незакрытый
 * шаг подсвечен: жилец должен видеть, что от него требуется сейчас,
 * а не читать список целиком.
 */
export async function OnboardingWizard({ steps }: { steps: readonly OnboardingStep[] }) {
  const t = await getTranslations('onboarding');
  const current = steps.find((step) => !step.done);

  return (
    <Card data-testid="onboarding-wizard">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <span className="text-text-muted text-[13px]">
          {t('progress', {
            done: steps.filter((step) => step.done).length,
            total: steps.length,
          })}
        </span>
      </CardHeader>

      <ol className="flex flex-col gap-2 p-4 pt-0">
        {steps.map((step) => {
          const href = STEP_LINKS[step.key];
          const isCurrent = current?.key === step.key;

          return (
            <li className="flex items-center justify-between gap-4" key={step.key}>
              <span className={isCurrent ? 'text-[13px] font-medium' : 'text-[13px]'}>
                {t(`steps.${step.key}`)}
              </span>

              <span className="flex items-center gap-3">
                {href !== undefined && !step.done && (
                  <Link className="text-accent text-[13px] underline" href={href}>
                    {t('open')}
                  </Link>
                )}
                <StatusPill kind={step.done ? 'done' : isCurrent ? 'attention' : 'muted'}>
                  {step.done ? t('done') : isCurrent ? t('now') : t('waiting')}
                </StatusPill>
              </span>
            </li>
          );
        })}
      </ol>

      <p className="text-text-muted p-4 pt-0 text-[13px]">{t('blockedHint')}</p>
    </Card>
  );
}
