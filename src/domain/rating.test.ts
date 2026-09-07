import { describe, expect, it } from 'vitest';

import { parseBusinessDate } from '@/lib/time';

import {
  applyDelta,
  crossDown,
  crossUp,
  deltaForScore,
  DEFAULT_RATING_RULES,
  ratingYearStart,
  foldRating,
  type ThresholdState,
} from './rating';

/**
 * Рейтинг (docs/03-BUSINESS-RULES.md §5).
 * Числовые примеры 5.1 и 5.2 — здесь, до кода.
 */
const RULES = DEFAULT_RATING_RULES;

describe('дельты за оценку уборки (§5.2)', () => {
  it('таблица дельт покрывает все оценки от 1 до 10', () => {
    expect([10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((score) => deltaForScore(RULES, score))).toEqual([
      3, 2, 1, 0, -1, -2, -2, -2, -2, -2,
    ]);
  });

  it('оценка вне 1–10 — ошибка, а не молчаливый ноль', () => {
    expect(() => deltaForScore(RULES, 0)).toThrow(/оценк/i);
    expect(() => deltaForScore(RULES, 11)).toThrow(/оценк/i);
  });
});

describe('границы рейтинга (§5.1)', () => {
  it('старт 50, обычное событие двигает на дельту', () => {
    expect(applyDelta(50, 3)).toBe(53);
    expect(applyDelta(50, -10)).toBe(40);
  });

  it('ниже нуля не уходит', () => {
    expect(applyDelta(5, -10)).toBe(0);
  });

  it('выше ста не поднимается', () => {
    expect(applyDelta(98, 3)).toBe(100);
  });

  it('дробная дельта — ошибка: рейтинг целый', () => {
    expect(() => applyDelta(50, 1.5)).toThrow(/цел/i);
  });
});

/** Состояние порогов: все взведены, как после сброса года. */
function armed(): ThresholdState[] {
  return RULES.downThresholds.map((rule) => ({ threshold: rule.threshold, armed: true }));
}

describe('пороги вниз, пример 5.1', () => {
  it('41 → 39: порог 40 срабатывает', () => {
    const result = crossDown(RULES, 39, armed());

    expect(result.triggered.map((item) => item.threshold)).toEqual([40]);
  });

  it('39 → 38 → 35: сработавший порог молчит', () => {
    const first = crossDown(RULES, 39, armed());
    const second = crossDown(RULES, 38, first.states);
    const third = crossDown(RULES, 35, second.states);

    expect(second.triggered).toEqual([]);
    expect(third.triggered).toEqual([]);
  });

  it('35 → 42: порог перезаряжается', () => {
    const dropped = crossDown(RULES, 39, armed());
    const raised = crossDown(RULES, 42, dropped.states);

    expect(raised.triggered).toEqual([]);
    expect(raised.states.find((state) => state.threshold === 40)?.armed).toBe(true);
  });

  it('42 → 39: перезаряженный порог срабатывает снова', () => {
    const dropped = crossDown(RULES, 39, armed());
    const raised = crossDown(RULES, 42, dropped.states);
    const again = crossDown(RULES, 39, raised.states);

    expect(again.triggered.map((item) => item.threshold)).toEqual([40]);
  });
});

describe('пороги вниз, пример 5.2', () => {
  it('одним событием срабатывают все пересечённые взведённые пороги', () => {
    const result = crossDown(RULES, 25, armed());

    // Взведены были все: сработали и 40, и 30 — каждый по одному разу.
    expect(result.triggered.map((item) => item.threshold)).toEqual([40, 30]);
  });

  it('каждый порог срабатывает по одному разу, даже если падение продолжается', () => {
    const first = crossDown(RULES, 25, armed());
    const second = crossDown(RULES, 22, first.states);

    expect(second.triggered).toEqual([]);
  });

  it('падение до нуля собирает все пороги разом', () => {
    const result = crossDown(RULES, 0, armed());

    expect(result.triggered.map((item) => item.threshold)).toEqual([40, 30, 20, 10]);
  });

  it('порог несёт с собой последствия: доп. ротацию и сумму штрафа', () => {
    const result = crossDown(RULES, 25, armed());
    const thirty = result.triggered.find((item) => item.threshold === 30);

    expect(thirty?.actions).toContain('extra_rotation');
    expect(thirty?.fineAmount).toBe(2_500);
  });
});

describe('пороги вверх (§5.4)', () => {
  it('переход выше 70 предлагает скидку 2 500', () => {
    const result = crossUp(
      RULES,
      72,
      RULES.upThresholds.map((rule) => ({ threshold: rule.threshold, armed: true })),
    );

    expect(result.triggered.map((item) => item.discountAmount)).toEqual([2_500]);
  });

  it('строго выше порога: ровно 70 скидки не даёт', () => {
    const states = RULES.upThresholds.map((rule) => ({ threshold: rule.threshold, armed: true }));

    expect(crossUp(RULES, 70, states).triggered).toEqual([]);
  });

  it('второй раз подряд предложение не создаётся', () => {
    const states = RULES.upThresholds.map((rule) => ({ threshold: rule.threshold, armed: true }));
    const first = crossUp(RULES, 72, states);
    const second = crossUp(RULES, 75, first.states);

    expect(second.triggered).toEqual([]);
  });

  it('падение ниже порога перезаряжает его', () => {
    const states = RULES.upThresholds.map((rule) => ({ threshold: rule.threshold, armed: true }));
    const first = crossUp(RULES, 72, states);
    const back = crossUp(RULES, 65, first.states);
    const again = crossUp(RULES, 71, back.states);

    expect(again.triggered.map((item) => item.discountAmount)).toEqual([2_500]);
  });

  it('прыжок за оба порога предлагает обе скидки: выбор — дело счёта', () => {
    const states = RULES.upThresholds.map((rule) => ({ threshold: rule.threshold, armed: true }));
    const result = crossUp(RULES, 95, states);

    expect(result.triggered.map((item) => item.threshold)).toEqual([70, 90]);
  });
});

describe('год рейтинга (§5.1)', () => {
  it('год начинается 1 июля', () => {
    expect(ratingYearStart(parseBusinessDate('2026-07-01'))).toBe('2026-07-01');
    expect(ratingYearStart(parseBusinessDate('2026-09-07'))).toBe('2026-07-01');
    expect(ratingYearStart(parseBusinessDate('2026-12-31'))).toBe('2026-07-01');
  });

  it('до июля год ещё прошлогодний', () => {
    expect(ratingYearStart(parseBusinessDate('2026-06-30'))).toBe('2025-07-01');
    expect(ratingYearStart(parseBusinessDate('2026-01-01'))).toBe('2025-07-01');
  });
});

describe('свёртка событий в число (§5.1)', () => {
  it('начинает с 50 и складывает дельты', () => {
    expect(foldRating([3, 2, -1])).toBe(54);
  });

  it('границы держатся на каждом шаге, а не в конце', () => {
    // Минус сорок девять и плюс сорок девять: без ограничения на шаге
    // получилось бы 50, с ограничением — 1 плюс 49.
    expect(foldRating([-100, 49])).toBe(49);
    expect(foldRating([100, -30])).toBe(70);
  });

  it('пустая история — старт', () => {
    expect(foldRating([])).toBe(50);
  });
});
