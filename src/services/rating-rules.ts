import { getDb, type Executor } from '@/db/client';
import { listRatingRules, putRatingRule } from '@/db/repositories/rating';
import { assertCan } from '@/lib/authz';
import { ValidationError } from '@/lib/errors';

import { AUDIT_ACTIONS, recordAudit } from './audit';
import { resolveRatingRules } from './rating';

import type { RatingRules } from '@/domain/rating';
import type { RatingRule } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Редактор правил рейтинга (docs/03-BUSINESS-RULES.md §5.5).
 *
 * Уровень сети с переопределением на дом. Правит суперадмин: дельты и суммы
 * штрафов — это деньги и наказания всей сети, и админ дома не должен уметь
 * назначить себе свои. Считает по правилам ядро, а не экран.
 */
export interface RatingRulesDeps {
  executor?: Executor;
}

export interface RatingRuleRow {
  id: string;
  kind: RatingRule['kind'];
  code: string;
  config: unknown;
  isActive: boolean;
  /** Где строка живёт: правило сети или переопределение дома. */
  level: 'network' | 'house';
}

export interface RatingRuleTable {
  /** Итоговый набор для расчётов: умолчания, сеть, поверх — дом. */
  rules: RatingRules;
  rows: RatingRuleRow[];
}

export interface SaveRatingRuleInput {
  /** `null` — правило сети; иначе переопределение дома (§5.5). */
  houseId: string | null;
  kind: RatingRule['kind'];
  code: string;
  config: unknown;
  isActive?: boolean;
}

function executorOf(deps: RatingRulesDeps): Executor {
  return deps.executor ?? getDb();
}

/** Таблица правил и то, что из неё получается: дом видит и своё, и сетевое. */
export async function readRatingRuleTable(
  actor: UserActor,
  houseId: string | null,
  deps: RatingRulesDeps = {},
): Promise<RatingRuleTable> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'rating.rules', houseId === null ? {} : { houseId });

  const [network, house, rules] = await Promise.all([
    listRatingRules(actor.context, { networkOnly: true }, executor),
    houseId === null
      ? Promise.resolve<RatingRule[]>([])
      : listRatingRules(actor.context, { houseId }, executor),
    resolveRatingRules(actor.context, houseId, executor),
  ]);

  const toRow = (rule: RatingRule, level: 'network' | 'house'): RatingRuleRow => ({
    id: rule.id,
    kind: rule.kind,
    code: rule.code,
    config: rule.config,
    isActive: rule.isActive,
    level,
  });

  return {
    rules,
    rows: [
      ...network.map((rule) => toRow(rule, 'network')),
      ...house.map((rule) => toRow(rule, 'house')),
    ],
  };
}

export async function saveRatingRule(
  actor: UserActor,
  input: SaveRatingRuleInput,
  deps: RatingRulesDeps = {},
): Promise<RatingRule> {
  const executor = executorOf(deps);

  assertCan(
    actor.context,
    'rating.rules',
    input.houseId === null ? {} : { houseId: input.houseId },
  );

  if (input.code.trim() === '') {
    throw new ValidationError('rating.errors.codeRequired');
  }

  return executor.transaction(async (tx) => {
    const rule = await putRatingRule(
      actor.context,
      {
        houseId: input.houseId,
        kind: input.kind,
        code: input.code.trim(),
        config: input.config,
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.ratingRuleSaved,
        entityType: 'rating_rule',
        entityId: rule.id,
        after: {
          level: input.houseId === null ? 'network' : 'house',
          code: rule.code,
          config: rule.config,
          isActive: rule.isActive,
        },
      },
      tx,
    );

    return rule;
  });
}

/**
 * «Скопировать правила из дома…» (§5.5).
 *
 * Переносятся только переопределения дома-источника: сетевые правила
 * и так действуют на оба дома, а копирование их в дом превратило бы
 * будущую правку сети в правку, которая до этого дома не доходит.
 */
export async function copyRatingRules(
  actor: UserActor,
  input: { fromHouseId: string; toHouseId: string },
  deps: RatingRulesDeps = {},
): Promise<number> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'rating.rules', { houseId: input.toHouseId });
  assertCan(actor.context, 'rating.rules', { houseId: input.fromHouseId });

  if (input.fromHouseId === input.toHouseId) {
    throw new ValidationError('rating.errors.sameHouse');
  }

  const source = await listRatingRules(actor.context, { houseId: input.fromHouseId }, executor);

  return executor.transaction(async (tx) => {
    for (const rule of source) {
      await putRatingRule(
        actor.context,
        {
          houseId: input.toHouseId,
          kind: rule.kind,
          code: rule.code,
          config: rule.config,
          isActive: rule.isActive,
        },
        tx,
      );
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.ratingRuleSaved,
        entityType: 'house',
        entityId: input.toHouseId,
        after: { copiedFrom: input.fromHouseId, count: source.length },
      },
      tx,
    );

    return source.length;
  });
}
