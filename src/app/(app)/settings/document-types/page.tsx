import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { listDocumentTypes } from '@/services/document-types';

import { DocumentTypesManager, type DocumentTypeRow } from './document-types-manager';

export const dynamic = 'force-dynamic';

/**
 * Типы документов сети (модуль 11). До T8.2 их заводил только сид,
 * и после очистки боевой базы сеть осталась без них.
 */
export default async function DocumentTypesPage() {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const { context } = session;

  if (!can(context, 'settings.org.read')) {
    redirect('/settings');
  }

  const t = await getTranslations('documentTypes');
  const types = await listDocumentTypes({ context }, { includeArchived: true });

  const rows: DocumentTypeRow[] = types.map((type) => {
    const names = type.nameI18n as Record<string, string>;

    return {
      id: type.id,
      code: type.code,
      nameRu: names.ru ?? type.code,
      nameKk: names.kk ?? '',
      nameEn: names.en ?? '',
      validityMonths: type.validityMonths,
      requiresIssueDate: type.requiresIssueDate,
      isRequired: type.isRequired,
      sortOrder: type.sortOrder,
      isArchived: type.archivedAt !== null,
    };
  });

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
      </div>

      <DocumentTypesManager canManage={can(context, 'settings.org.write')} rows={rows} />
    </section>
  );
}
