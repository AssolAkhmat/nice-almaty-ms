import { describe, expect, it } from 'vitest';

import { DEFAULT_RETENTION, backupDate, backupName, planRetention } from './backup-retention';

/**
 * Ротация удаляет копии базы, поэтому проверяется числовыми примерами,
 * а не наблюдением за живой папкой: ошибка здесь стоит не места на диске,
 * а той самой копии, за которой однажды придут.
 */
function daysFrom(start: string, count: number): string[] {
  const names: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);

  for (let index = 0; index < count; index += 1) {
    names.push(backupName(cursor.toISOString().slice(0, 10)));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  return names;
}

describe('имя копии', () => {
  it('собирается и разбирается обратно', () => {
    expect(backupName('2026-09-20')).toBe('nice-almaty-2026-09-20.dump.age');
    expect(backupDate('nice-almaty-2026-09-20.dump.age')).toBe('2026-09-20');
  });

  it('чужое имя не опознаётся', () => {
    expect(backupDate('nice-almaty-2026-09-20.dump')).toBeNull();
    expect(backupDate('dump.age')).toBeNull();
    expect(backupDate('nice-almaty-20-09-2026.dump.age')).toBeNull();
  });
});

describe('ротация копий', () => {
  it('пустая папка — нечего удалять', () => {
    expect(planRetention([])).toEqual({ keep: [], remove: [], foreign: [] });
  });

  it('копий меньше предела — не удаляется ничего', () => {
    const names = daysFrom('2026-09-20', 5);

    expect(planRetention(names).remove).toEqual([]);
    expect(planRetention(names).keep).toHaveLength(5);
  });

  it('семь суточных остаются подряд, восьмая держится только как недельная', () => {
    const plan = planRetention(daysFrom('2026-09-20', 30));

    expect(plan.keep.slice(0, 7)).toEqual(daysFrom('2026-09-20', 7));
    expect(plan.keep).toContain(backupName('2026-09-13'));
    expect(plan.remove).toContain(backupName('2026-09-12'));
  });

  it('за год остаются ровно суточные, недельные и месячные', () => {
    const plan = planRetention(daysFrom('2026-09-20', 365));

    // 7 суток + 4 недели + 6 месяцев, пересечения схлопнуты множеством.
    expect(plan.keep.length).toBeLessThanOrEqual(
      DEFAULT_RETENTION.daily + DEFAULT_RETENTION.weekly + DEFAULT_RETENTION.monthly,
    );
    expect(plan.keep.length).toBeGreaterThanOrEqual(DEFAULT_RETENTION.monthly);
    expect(plan.keep.length + plan.remove.length).toBe(365);
    expect(
      new Set(plan.keep.map((name) => backupDate(name)?.slice(0, 7))).size,
    ).toBeGreaterThanOrEqual(DEFAULT_RETENTION.monthly);
  });

  /*
   * Прогон, не случившийся в воскресенье, не должен стоить недельной копии:
   * неделя считается по тому, что есть.
   */
  it('пропуски в днях не съедают недельные копии', () => {
    const names = [
      backupName('2026-09-20'),
      backupName('2026-09-16'),
      backupName('2026-09-09'),
      backupName('2026-09-02'),
      backupName('2026-08-26'),
      backupName('2026-08-19'),
    ];

    const plan = planRetention(names, { daily: 1, weekly: 4, monthly: 1 });

    /*
     * 20 сентября — воскресенье, 16-е — среда той же ISO-недели: недельная
     * копия у них одна, новейшая. Дальше по одной на неделю, хотя прогонов
     * между ними не было вовсе — счёт идёт по копиям, а не по календарю.
     */
    expect(plan.keep).toEqual([
      backupName('2026-09-20'),
      backupName('2026-09-09'),
      backupName('2026-09-02'),
      backupName('2026-08-26'),
    ]);
    expect(plan.remove).toEqual([backupName('2026-09-16'), backupName('2026-08-19')]);
  });

  it('две даты одной недели дают одну недельную копию', () => {
    // 14 и 15 сентября 2026 — понедельник и вторник одной недели.
    const plan = planRetention([backupName('2026-09-15'), backupName('2026-09-14')], {
      daily: 0,
      weekly: 1,
      monthly: 0,
    });

    expect(plan.keep).toEqual([backupName('2026-09-15')]);
    expect(plan.remove).toEqual([backupName('2026-09-14')]);
  });

  it('месячная копия — новейшая в своём месяце', () => {
    const plan = planRetention([backupName('2026-08-31'), backupName('2026-08-01')], {
      daily: 0,
      weekly: 0,
      monthly: 1,
    });

    expect(plan.keep).toEqual([backupName('2026-08-31')]);
    expect(plan.remove).toEqual([backupName('2026-08-01')]);
  });

  it('чужие файлы не удаляются и не считаются копиями', () => {
    const plan = planRetention(['README.txt', backupName('2026-09-20'), 'dump.sql'], {
      daily: 1,
      weekly: 0,
      monthly: 0,
    });

    expect(plan.foreign).toEqual(['README.txt', 'dump.sql']);
    expect(plan.remove).toEqual([]);
  });

  it('неделя на стыке годов не теряется: 31 декабря и 1 января одной ISO-недели', () => {
    const plan = planRetention([backupName('2027-01-01'), backupName('2026-12-31')], {
      daily: 0,
      weekly: 1,
      monthly: 0,
    });

    expect(plan.keep).toEqual([backupName('2027-01-01')]);
    expect(plan.remove).toEqual([backupName('2026-12-31')]);
  });
});
