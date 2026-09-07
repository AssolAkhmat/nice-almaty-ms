/**
 * Рейтинг (docs/03-BUSINESS-RULES.md §5).
 *
 * Чистые функции: дельты, границы и пороги с перезарядкой. Сами правила —
 * данные, а не код: §5.5 отдаёт их суперадмину с переопределением на дом,
 * поэтому каждая функция получает их аргументом.
 */
export const RATING_MIN = 0;
export const RATING_MAX = 100;
export const RATING_START = 50;

export interface DownThresholdRule {
  threshold: number;
  /** Что происходит при пересечении: доп. ротация, штраф или оба (§5.3). */
  actions: string[];
  /** Сумма штрафа в тенге; ноль — штрафа нет. */
  fineAmount: number;
}

export interface UpThresholdRule {
  threshold: number;
  /** Сумма скидки на проживание в тенге (§5.4). */
  discountAmount: number;
}

export interface RatingRules {
  /** Дельта за оценку уборки 1–10. */
  scoreDeltas: Readonly<Record<number, number>>;
  /** Дельта за действие админа: акт помощи, нарушение, выговор и прочие. */
  actionDeltas: Readonly<Record<string, number>>;
  downThresholds: readonly DownThresholdRule[];
  upThresholds: readonly UpThresholdRule[];
}

/** Значения по умолчанию из §5.2–5.4: их правит суперадмин, но начинают с этих. */
export const DEFAULT_RATING_RULES: RatingRules = {
  scoreDeltas: { 10: 3, 9: 2, 8: 1, 7: 0, 6: -1, 5: -2, 4: -2, 3: -2, 2: -2, 1: -2 },
  actionDeltas: {
    help: 2,
    violation: -1,
    warning: -3,
    reprimand: -5,
    severe_reprimand: -10,
  },
  downThresholds: [
    { threshold: 40, actions: ['extra_rotation'], fineAmount: 0 },
    { threshold: 30, actions: ['extra_rotation', 'fine'], fineAmount: 2_500 },
    { threshold: 20, actions: ['fine'], fineAmount: 5_000 },
    { threshold: 10, actions: ['fine'], fineAmount: 10_000 },
  ],
  upThresholds: [
    { threshold: 70, discountAmount: 2_500 },
    { threshold: 90, discountAmount: 5_000 },
  ],
};

export function deltaForScore(rules: RatingRules, score: number): number {
  const delta = rules.scoreDeltas[score];

  if (delta === undefined) {
    throw new RangeError(`Оценка уборки бывает от 1 до 10, получено: ${String(score)}`);
  }

  return delta;
}

/**
 * Применение дельты с жёсткими границами 0 и 100 (§5.1, инвариант 7).
 *
 * Границы именно жёсткие: рейтинг не «уходит в минус, но показывается нулём» —
 * иначе один тяжёлый месяц копил бы отрицательный запас, из которого человек
 * не выбрался бы и безупречным поведением.
 */
export function applyDelta(current: number, delta: number): number {
  if (!Number.isInteger(delta)) {
    throw new RangeError(`Дельта рейтинга должна быть целой, получено: ${String(delta)}`);
  }

  return Math.min(RATING_MAX, Math.max(RATING_MIN, current + delta));
}

export interface ThresholdState {
  threshold: number;
  /** Взведён — сработает при пересечении; снят — молчит до перезарядки. */
  armed: boolean;
}

export interface TriggeredDown extends DownThresholdRule {
  threshold: number;
}

export interface CrossResult<T> {
  triggered: T[];
  states: ThresholdState[];
}

function stateOf(states: readonly ThresholdState[], threshold: number): boolean {
  return states.find((state) => state.threshold === threshold)?.armed ?? true;
}

/**
 * Пороги вниз (§5.3).
 *
 * Срабатывает всякий взведённый порог, ниже которого оказался рейтинг, —
 * пример 5.2 требует именно этого: «31 → 25» задевает и порог 40, если он
 * взведён, хотя сверху вниз его в этом событии не пересекали. Прежнее
 * значение в расчёте не участвует: память о прошлом — это и есть состояние
 * порога. Перезарядка идёт обратным движением: рейтинг на уровне порога
 * и выше снова его взводит.
 */
export function crossDown(
  rules: RatingRules,
  rating: number,
  states: readonly ThresholdState[],
): CrossResult<TriggeredDown> {
  const triggered: TriggeredDown[] = [];
  const next: ThresholdState[] = [];

  for (const rule of rules.downThresholds) {
    const armed = stateOf(states, rule.threshold);

    if (rating >= rule.threshold) {
      next.push({ threshold: rule.threshold, armed: true });
      continue;
    }

    if (armed) {
      triggered.push(rule);
      next.push({ threshold: rule.threshold, armed: false });
      continue;
    }

    next.push({ threshold: rule.threshold, armed: false });
  }

  return { triggered, states: next };
}

export interface TriggeredUp extends UpThresholdRule {
  threshold: number;
}

/**
 * Пороги вверх (§5.4): предложение скидки, а не сама скидка.
 *
 * Порог берётся строго: «> 70» означает, что ровно 70 предложения не даёт.
 * Перезарядка симметрична порогам вниз — падение на уровень порога и ниже
 * снова взводит его.
 */
export function crossUp(
  rules: RatingRules,
  rating: number,
  states: readonly ThresholdState[],
): CrossResult<TriggeredUp> {
  const triggered: TriggeredUp[] = [];
  const next: ThresholdState[] = [];

  for (const rule of rules.upThresholds) {
    const armed = stateOf(states, rule.threshold);

    if (rating <= rule.threshold) {
      next.push({ threshold: rule.threshold, armed: true });
      continue;
    }

    if (armed) {
      triggered.push(rule);
      next.push({ threshold: rule.threshold, armed: false });
      continue;
    }

    next.push({ threshold: rule.threshold, armed: false });
  }

  return { triggered, states: next };
}
