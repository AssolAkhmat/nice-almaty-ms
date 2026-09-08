import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { CONTRACT_TOKENS } from '@/domain/contract-template';
import { can } from '@/lib/authz';
import { NotFoundError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { readContractTemplate } from '@/services/contract-templates';

import { TemplateEditor } from './template-editor';

export const dynamic = 'force-dynamic';

/**
 * Шаблон договора (модуль 11). Правит суперадмин: договор один на сеть,
 * и его текст — обязательство перед жильцом, а не настройка дома.
 */
export default async function ContractTemplatePage() {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const { context } = session;

  if (!can(context, 'settings.org.read')) {
    redirect('/settings');
  }

  const t = await getTranslations('contractTemplate');

  const template = await readContractTemplate({ context }).catch((error: unknown) => {
    if (error instanceof NotFoundError) {
      return null;
    }

    throw error;
  });

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
      </div>

      {template === null ? (
        <p className="text-danger text-[13px]" role="alert">
          {t('missing')}
        </p>
      ) : (
        <TemplateEditor
          bodyHtml={template.bodyHtml}
          canManage={can(context, 'settings.org.write')}
          name={template.name}
          tokens={CONTRACT_TOKENS}
          version={template.version}
        />
      )}
    </section>
  );
}
