'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Textarea } from '@/components/ui/input';

import { saveTemplateAction, type RotationSetupActionState } from './actions';

const INITIAL: RotationSetupActionState = {};

export interface TemplateBlock {
  /** Вид уборки: у каждого своя шапка и свой футер (§6.7). */
  type: 'regular' | 'general';
  header: string;
  footer: string;
}

/**
 * Шапки и футеры шаблона дня (§6.7): раздельно для обычной и генеральной
 * уборки. Текст пишется на языке дома — том, на котором открыт интерфейс.
 */
function TemplateForm({ block, houseId }: { block: TemplateBlock; houseId: string }) {
  const t = useTranslations('rotationTemplates');
  const tAll = useTranslations();
  const [state, save, isSaving] = useActionState(saveTemplateAction, INITIAL);
  const router = useRouter();

  useEffect(() => {
    if (state.done !== undefined) {
      router.refresh();
    }
  }, [router, state]);

  return (
    <form action={save} className="flex flex-col gap-2" data-testid={`template-form-${block.type}`}>
      <input name="houseId" type="hidden" value={houseId} />
      <input name="type" type="hidden" value={block.type} />

      <p className="text-[13px] font-medium">{t(`types.${block.type}`)}</p>

      <Field htmlFor={`template-header-${block.type}`} label={t('header')}>
        <Textarea
          data-testid={`template-header-${block.type}`}
          defaultValue={block.header}
          id={`template-header-${block.type}`}
          name="header"
          rows={2}
        />
      </Field>

      <Field htmlFor={`template-footer-${block.type}`} label={t('footer')}>
        <Textarea
          data-testid={`template-footer-${block.type}`}
          defaultValue={block.footer}
          id={`template-footer-${block.type}`}
          name="footer"
          rows={2}
        />
      </Field>

      <div>
        <Button
          data-testid={`template-save-${block.type}`}
          disabled={isSaving}
          size="sm"
          type="submit"
          variant="secondary"
        >
          {t('save')}
        </Button>
      </div>

      {state.error !== undefined && (
        <p className="text-danger text-[13px]" role="alert">
          {tAll(state.error)}
        </p>
      )}
      {state.done !== undefined && (
        <p className="text-success text-[13px]" data-testid={`template-done-${block.type}`}>
          {tAll(state.done)}
        </p>
      )}
    </form>
  );
}

export function TemplateSettings({
  blocks,
  houseId,
}: {
  blocks: readonly TemplateBlock[];
  houseId: string;
}) {
  const t = useTranslations('rotationTemplates');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>

      <div className="flex flex-col gap-5">
        <p className="text-text-muted text-[13px]">{t('hint')}</p>

        {blocks.map((block) => (
          <TemplateForm block={block} houseId={houseId} key={block.type} />
        ))}
      </div>
    </Card>
  );
}
