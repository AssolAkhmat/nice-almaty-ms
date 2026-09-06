import { splitCeil } from './money';

/**
 * Ущерб и его деление (docs/03-BUSINESS-RULES.md §8).
 * Чистые функции: кто участвует и сколько с каждого. Списание с депозитов
 * и проводка — дело сервиса.
 */
export type DamageSplitMode = 'single' | 'room' | 'all' | 'all_except' | 'custom';

export interface DamageSplitConfig {
  /** Для `single`, `all_except` и `custom`. */
  userIds?: readonly string[];
  /** Для `room`. */
  areaId?: string | null;
}

export interface DamageSplit {
  mode: DamageSplitMode;
  config: DamageSplitConfig;
}

/** Житель дома на момент проведения ущерба: кто и в какой комнате живёт. */
export interface DamageRosterEntry {
  userId: string;
  areaId: string | null;
}

export interface DamageShare {
  userId: string;
  amount: number;
}

export interface DamageSplitResult {
  shares: DamageShare[];
  /** Излишек округления — в фонд дома (§0, §8). */
  surplus: number;
}

/**
 * Участники деления по режиму §8. Пустой список — ошибка: сумма, которую
 * не с кого списать, тихо исчезла бы, а ущерб остался бы неоплаченным.
 */
export function resolveDamageParticipants(
  split: DamageSplit,
  roster: readonly DamageRosterEntry[],
): string[] {
  const living = roster.map((entry) => entry.userId);
  const chosen = new Set(split.config.userIds ?? []);

  let participants: string[];

  switch (split.mode) {
    case 'single':
    case 'custom':
      participants = living.filter((userId) => chosen.has(userId));
      break;
    case 'room':
      participants = roster
        .filter((entry) => entry.areaId !== null && entry.areaId === split.config.areaId)
        .map((entry) => entry.userId);
      break;
    case 'all':
      participants = living;
      break;
    case 'all_except':
      participants = living.filter((userId) => !chosen.has(userId));
      break;
  }

  if (participants.length === 0) {
    throw new RangeError('Не выбран ни один участник деления ущерба');
  }

  return participants;
}

/** Сумма делится поровну: вес каждого участника — единица (§8). */
export function splitDamage(total: number, participants: readonly string[]): DamageSplitResult {
  const { shares, surplus } = splitCeil(
    total,
    participants.map(() => 1),
  );

  return {
    shares: participants.map((userId, index) => ({ userId, amount: shares[index] ?? 0 })),
    surplus,
  };
}
