'use client';

import { useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';

export interface ActorOption {
  id: string;
  phone: string;
}

/** Фильтры живут в адресе: ссылку на выборку можно передать другому суперадмину. */
export function AuditFilters({
  actors,
  entityTypes,
  selected,
}: {
  actors: readonly ActorOption[];
  entityTypes: readonly string[];
  selected: { actor: string; entity: string; from: string; to: string };
}) {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function apply(formData: FormData) {
    const next = new URLSearchParams(params.toString());

    for (const name of ['actor', 'entity', 'from', 'to']) {
      const value = formData.get(name);

      if (typeof value === 'string' && value !== '') {
        next.set(name, value);
      } else {
        next.delete(name);
      }
    }

    router.push(`${pathname}?${next.toString()}`);
  }

  return (
    <form action={apply} className="flex flex-wrap items-end gap-3" data-testid="audit-filters">
      <Field htmlFor="actor" label={t('audit.filters.actor')}>
        <Select data-testid="filter-actor" defaultValue={selected.actor} id="actor" name="actor">
          <option value="">{t('audit.filters.any')}</option>
          {actors.map((actor) => (
            <option key={actor.id} value={actor.id}>
              {actor.phone}
            </option>
          ))}
        </Select>
      </Field>

      <Field htmlFor="entity" label={t('audit.filters.entity')}>
        <Select
          data-testid="filter-entity"
          defaultValue={selected.entity}
          id="entity"
          name="entity"
        >
          <option value="">{t('audit.filters.any')}</option>
          {entityTypes.map((type) => (
            <option key={type} value={type}>
              {t.has(`audit.entities.${type}`) ? t(`audit.entities.${type}`) : type}
            </option>
          ))}
        </Select>
      </Field>

      <Field htmlFor="from" label={t('audit.filters.from')}>
        <Input defaultValue={selected.from} id="from" name="from" type="date" />
      </Field>

      <Field htmlFor="to" label={t('audit.filters.to')}>
        <Input defaultValue={selected.to} id="to" name="to" type="date" />
      </Field>

      <Button data-testid="apply-filters" type="submit" variant="secondary">
        {t('audit.filters.apply')}
      </Button>
    </form>
  );
}
