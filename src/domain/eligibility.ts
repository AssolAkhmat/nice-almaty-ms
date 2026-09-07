/**
 * Группы допуска (docs/03-BUSINESS-RULES.md §6.1).
 *
 * Кто вправе убирать зону: предустановленная основа — все, парни, девушки,
 * жильцы комнаты — и поверх неё явные списки включений и исключений.
 * Чистые функции: кто сейчас живёт в доме, спрашивает сервис.
 */

/** Предустановленный фильтр, с которого начинается группа. */
export type EligibilityBase = 'all' | 'male' | 'female' | 'room';

export interface EligibilityRule {
  base: EligibilityBase;
  /** Комната для основы `room`. */
  areaId?: string | null;
  /** Добавленные вручную сверх основы. */
  includeUserIds?: readonly string[];
  /** Исключённые вручную — «двор: парни, кроме Азамата». */
  excludeUserIds?: readonly string[];
}

/** Правило в полном виде: списки существуют всегда, пусть и пустые. */
export interface ParsedEligibilityRule {
  base: EligibilityBase;
  areaId: string | null;
  includeUserIds: string[];
  excludeUserIds: string[];
}

/** Житель дома на дату: пол из профиля, комната из назначения места. */
export interface EligibilityMember {
  userId: string;
  sex: 'male' | 'female' | null;
  areaId: string | null;
}

const BASES: readonly EligibilityBase[] = ['all', 'male', 'female', 'room'];

function readStringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new RangeError(`Поле ${field} правила допуска должно быть списком строк`);
  }

  return value as string[];
}

/**
 * Разбор правила из `eligibility_groups.rule`.
 *
 * Незнакомая основа — ошибка: неизвестное правило, тихо превращённое
 * в «все», пустило бы к зоне тех, кого админ туда не пускал.
 */
export function parseEligibilityRule(value: unknown): ParsedEligibilityRule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RangeError('Правило допуска должно быть объектом');
  }

  const raw = value as Record<string, unknown>;
  const base = raw.base;

  if (typeof base !== 'string' || !BASES.includes(base as EligibilityBase)) {
    throw new RangeError(`Незнакомая основа группы допуска: ${String(base)}`);
  }

  const areaId = raw.areaId;

  return {
    base: base as EligibilityBase,
    areaId: typeof areaId === 'string' ? areaId : null,
    includeUserIds: readStringList(raw.includeUserIds, 'includeUserIds'),
    excludeUserIds: readStringList(raw.excludeUserIds, 'excludeUserIds'),
  };
}

/**
 * Кого группа допускает к зоне.
 *
 * Порядок повторяет порядок жильцов дома: список показывается человеку,
 * и он не должен перескакивать от того, в каком порядке админ добавлял
 * исключения. Исключение сильнее включения — спор решается в пользу
 * запрета: включить человека и тут же исключить его может только опечатка,
 * и безопаснее не пустить, чем пустить.
 *
 * Пустая группа ошибкой не считается: админ вправе временно закрыть зону
 * для всех. А вот основа `room` без комнаты — ошибка: она не «пустая»,
 * она недописанная.
 */
export function resolveEligibility(
  rule: EligibilityRule,
  members: readonly EligibilityMember[],
): string[] {
  const included = new Set(rule.includeUserIds ?? []);
  const excluded = new Set(rule.excludeUserIds ?? []);

  if (rule.base === 'room' && (rule.areaId === undefined || rule.areaId === null)) {
    throw new RangeError('Группа «жильцы комнаты» не знает своей комнаты');
  }

  return members
    .filter((member) => {
      if (excluded.has(member.userId)) {
        return false;
      }

      if (included.has(member.userId)) {
        return true;
      }

      switch (rule.base) {
        case 'all':
          return true;
        case 'male':
        case 'female':
          return member.sex === rule.base;
        case 'room':
          return member.areaId !== null && member.areaId === rule.areaId;
      }
    })
    .map((member) => member.userId);
}
