import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { readContractTemplate } from '@/services/contract-templates';
import { listDeclarations } from '@/services/profile-fields';

import { ProfileFieldsManager, type ProfileFieldRow } from './profile-fields-manager';

export const dynamic = 'force-dynamic';

/**
 * Дополнительные поля профиля (T12.3, указание владельца от 21 сентября 2026).
 *
 * Объявляет суперадмин: набор полей — правило всей сети, как срок годности
 * документа. Каждое поле становится токеном шаблона договора `profile.<код>`,
 * поэтому рядом с полем показан именно токен, а не внутренний код.
 */
export default async function ProfileFieldsPage() {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const { context } = session;

  if (!can(context, 'settings.org.read')) {
    redirect('/settings');
  }

  const t = await getTranslations('profileFields');
  const declarations = await listDeclarations({ context }, { includeArchived: true });

  /*
   * Текст действующего шаблона нужен, чтобы предупредить при архивации:
   * токен архивированного поля в новых договорах станет пустым. Шаблона
   * может не быть вовсе — тогда предупреждать не о чем.
   */
  const templateBody = await readContractTemplate({ context })
    .then((template) => template.bodyHtml)
    .catch(() => '');

  const rows: ProfileFieldRow[] = declarations.map((def) => {
    const names = def.nameI18n as Record<string, string>;

    return {
      id: def.id,
      code: def.code,
      nameRu: names.ru ?? def.code,
      nameKk: names.kk ?? '',
      nameEn: names.en ?? '',
      type: def.type,
      isRequired: def.isRequired,
      options: def.options as string[],
      sortOrder: def.sortOrder,
      isArchived: def.archivedAt !== null,
      usedInTemplate: templateBody.includes(`profile.${def.code}`),
    };
  });

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
      </div>

      <ProfileFieldsManager canManage={can(context, 'settings.org.write')} rows={rows} />
    </section>
  );
}
