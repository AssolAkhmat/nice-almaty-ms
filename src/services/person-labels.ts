import { getDb, type Executor } from '@/db/client';
import { listProfileNames } from '@/db/repositories/resident-profiles';
import { listUsers } from '@/db/repositories/users';

import type { AccessContext } from '@/db/access';

/**
 * Подпись человека на экране: ФИО, а если профиля ещё нет — телефон
 * с пометкой (указание владельца, 25 сентября 2026).
 *
 * Появилось после трёх одинаковых дефектов подряд: в списке договоров
 * стоял uuid проживания, в списке пользователей — прочерк вместо дома,
 * а отличить одного жильца от другого было нельзя. Везде причина одна —
 * экран показывал идентификатор, когда имени не нашлось.
 *
 * Идентификатор человеку не нужен нигде. Поэтому запасной вариант тут
 * один и общий: телефон, по которому человек входит, плюс честная пометка
 * «профиль не заполнен» — это и есть ответ на вопрос «кто не заполнил».
 */
export interface PersonLabel {
  userId: string;
  /** ФИО; пусто — профиль ещё не заполнен. */
  name: string | null;
  /** Телефон-логин: показывается вместо имени и рядом с ним. */
  phone: string;
}

function joinName(parts: readonly (string | null)[]): string | null {
  const name = parts
    .filter((part) => part !== null && part.trim() !== '')
    .join(' ')
    .trim();

  return name === '' ? null : name;
}

/**
 * Подписи по списку людей. Неизвестный человек в ответ не попадает:
 * выдумывать подпись из идентификатора — ровно та ошибка, ради которой
 * функция и написана.
 */
export async function personLabels(
  context: AccessContext,
  userIds: readonly string[],
  executor: Executor = getDb(),
): Promise<Map<string, PersonLabel>> {
  const unique = [...new Set(userIds)];

  if (unique.length === 0) {
    return new Map();
  }

  const [names, users] = await Promise.all([
    listProfileNames(context, unique, executor),
    listUsers(context, executor),
  ]);

  const phones = new Map(users.map((user) => [user.id, user.phone]));
  const labels = new Map<string, PersonLabel>();

  for (const userId of unique) {
    const phone = phones.get(userId);

    if (phone === undefined) {
      continue;
    }

    const parts = names.get(userId);

    labels.set(userId, {
      userId,
      name: parts === undefined ? null : joinName([parts.lastName, parts.firstName]),
      phone,
    });
  }

  return labels;
}
