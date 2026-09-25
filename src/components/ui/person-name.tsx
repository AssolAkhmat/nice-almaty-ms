import { useTranslations } from 'next-intl';

/**
 * Имя человека на экране (указание владельца, 25 сентября 2026).
 *
 * Профиль заполнен — показывается ФИО. Не заполнен — телефон и пометка
 * об этом: «кто не заполнил профиль» должно читаться со списка, а не
 * выясняться переходом в карточку.
 *
 * Идентификатора здесь нет и быть не может: компонент его просто
 * не принимает. Так третий случай «на экране uuid вместо человека»
 * не превратится в четвёртый.
 */
export interface PersonNameView {
  /** ФИО; пусто — профиль ещё не заполнен. */
  name: string | null;
  phone: string;
}

export function PersonName({ person, className }: { person: PersonNameView; className?: string }) {
  const t = useTranslations('users');

  if (person.name !== null) {
    return <span className={className}>{person.name}</span>;
  }

  return (
    <span className={className}>
      {person.phone}
      <span className="text-text-muted ml-2 text-[13px]">{t('profileMissing')}</span>
    </span>
  );
}

/** То же одной строкой — там, где нужна строка, а не разметка. */
export function personText(person: PersonNameView): string {
  return person.name ?? person.phone;
}
