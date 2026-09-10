import { expect, test, type Page } from '@playwright/test';

import { E2E_ACCOUNTS, E2E_PASSWORD } from './global-setup';
import { signInAs } from './support/onboarding';
import {
  buildPhaseTenHouse,
  PHASE_TEN_ZONES,
  type PhaseTenHouse,
  type PhaseTenZone,
} from './support/phase-10-house';

/**
 * Приёмка фазы 10: сценарий раздела 3 плана (`docs/tasks/PHASE-10.md`).
 *
 * Дом на пятнадцать жильцов, ряды среды, пятницы и воскресенья делят их
 * 4 + 4 + 7, нормы дней — списки зон с числом людей. Проверяется матрица
 * двух недель из раздела 3, затем заселяются двое: составы и нормы среды
 * и пятницы правятся «с даты», вторая неделя пересобирается, воскресенье
 * не трогается. Жильцы и зоны строятся в базе (`support/phase-10-house`),
 * всё остальное — ряды, составы, нормы, расписание, правки — через экраны.
 *
 * Дом у каждой ширины свой: ряды у дома одни, и три прогона в общем доме
 * собирали бы их друг поверх друга.
 */
const HOUSES: Record<string, { number: number; admin: string }> = {
  'mobile-375': { number: 12, admin: E2E_ACCOUNTS.adminHouse12 },
  'tablet-768': { number: 13, admin: E2E_ACCOUNTS.adminHouse13 },
  'desktop-1440': { number: 14, admin: E2E_ACCOUNTS.adminHouse14 },
};

/** Ближайший день недели строго после сегодняшнего по календарю Алматы. */
function nextWeekday(weekday: number): string {
  const almaty = new Date(Date.now() + 5 * 60 * 60 * 1000);
  const shift = (weekday - almaty.getUTCDay() + 7) % 7 || 7;

  return new Date(almaty.getTime() + shift * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function plusDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Заводит ряд формой и возвращает его идентификатор по карточке состава. */
async function createRow(page: Page, name: string, weekday: number, start: string) {
  await page.goto('/settings/house/rotations');

  const form = page.getByTestId('row-form-new');
  await form.getByTestId('row-name-new').fill(name);
  await form.getByTestId('row-weekday-new').selectOption(String(weekday));
  await form.getByTestId('row-start-new').fill(start);
  await form.getByTestId('row-save-new').click();
  await expect(page.locator(`input[value="${name}"]`)).toBeVisible();
  await page.reload();

  const card = page.locator('.rounded-card').filter({ hasText: name });
  const dayForm = card.locator('[data-testid^="day-form-"]');
  await expect(dayForm).toBeVisible();

  return (await dayForm.getAttribute('data-testid'))?.replace('day-form-', '') ?? '';
}

/** Версия состава: места по порядку позиций; дата вступления — если правка «с даты». */
async function saveRoster(
  page: Page,
  rowId: string,
  from: string | null,
  bedIds: readonly string[],
): Promise<void> {
  await page.goto('/settings/house/rotations');

  const form = page.getByTestId(`day-form-${rowId}`);
  await expect(form).toBeVisible();

  if (from !== null) {
    await form.getByTestId(`roster-from-${rowId}`).fill(from);
  }

  for (const [position, bedId] of bedIds.entries()) {
    await form.getByTestId(`roster-bed-${rowId}-${bedId}`).fill(String(position));
  }

  await form.getByTestId(`roster-save-${rowId}`).click();
  await expect(form.getByText('Состав сохранён')).toBeVisible();
}

/** Версия нормы: зоны по порядку, у каждой число людей. */
async function saveNorm(
  page: Page,
  rowId: string,
  from: string | null,
  zones: readonly { areaId: string; people?: number }[],
): Promise<void> {
  await page.goto('/settings/house/rotations');

  const form = page.getByTestId(`day-form-${rowId}`);
  await expect(form).toBeVisible();

  if (from !== null) {
    await form.getByTestId(`norm-from-${rowId}`).fill(from);
  }

  for (const [position, zone] of zones.entries()) {
    await form.getByTestId(`norm-zone-${rowId}-${zone.areaId}`).fill(String(position));
    if (zone.people !== undefined) {
      await form.getByTestId(`norm-people-${rowId}-${zone.areaId}`).fill(String(zone.people));
    }
  }

  await form.getByTestId(`norm-save-${rowId}`).click();
  await expect(form.getByText('Норма сохранена')).toBeVisible();
}

/** День календаря: у каждой названной зоны — названные исполнители. */
async function expectDay(
  page: Page,
  date: string,
  expected: readonly [PhaseTenZone, readonly string[]][],
): Promise<void> {
  await page.goto(`/rotations?mode=day&date=${date}`);

  const cards = page.locator('main').locator('[data-testid^="occurrence-"]');

  for (const [zone, names] of expected) {
    const card = cards.filter({ hasText: PHASE_TEN_ZONES[zone] });
    await expect(card).toHaveCount(1);

    for (const name of names) {
      await expect(card).toContainText(name);
    }
  }
}

function helpers(house: PhaseTenHouse) {
  const by = (letter: string) => {
    const resident = house.residents.find((item) => item.letter === letter);

    if (resident === undefined) {
      throw new Error(`Жилец ${letter} не построен`);
    }

    return resident;
  };

  return {
    beds: (letters: string) => [...letters].map((letter) => by(letter).bedId),
    names: (letters: string) => [...letters].map((letter) => by(letter).name),
    zone: (key: PhaseTenZone, people?: number) => ({
      areaId: house.zoneIds[key],
      ...(people === undefined ? {} : { people }),
    }),
  };
}

test.describe('приёмка фазы 10', () => {
  test.describe.configure({ mode: 'serial' });
  // Три ряда, три нормы, расписание и четыре правки: долгий путь по экранам.
  test.setTimeout(480_000);

  test('дом на 15 жильцов: ряды 4 + 4 + 7 дают матрицу раздела 3 и переживают заселение двоих', async ({
    page,
  }, testInfo) => {
    const house = HOUSES[testInfo.project.name];

    if (house === undefined) {
      throw new Error(`Нет дома приёмки для ширины ${testInfo.project.name}`);
    }

    const built = await buildPhaseTenHouse(house.number);
    const { beds, names, zone } = helpers(built);

    const wednesday = nextWeekday(3);
    const friday = plusDays(wednesday, 2);
    const sunday = plusDays(wednesday, 4);

    await signInAs(page, house.admin, E2E_PASSWORD);

    // Ряды делят жильцов по дням: среда — A, B, C, D; пятница — E, F, G, H;
    // воскресенье — I…O. Нормы — списки зон раздела 3, двор на двоих.
    const weekdayNorm = [zone('kitchen'), zone('bathroom'), zone('corridor'), zone('hall')];

    const wedRow = await createRow(page, 'Среда', 3, wednesday);
    await saveRoster(page, wedRow, null, beds('ABCD'));
    await saveNorm(page, wedRow, null, weekdayNorm);

    const friRow = await createRow(page, 'Пятница', 5, friday);
    await saveRoster(page, friRow, null, beds('EFGH'));
    await saveNorm(page, friRow, null, weekdayNorm);

    const sunRow = await createRow(page, 'Воскресенье', 0, sunday);
    await saveRoster(page, sunRow, null, beds('IJKLMNO'));
    await saveNorm(page, sunRow, null, [
      zone('yard', 2),
      zone('fridge'),
      zone('kitchen'),
      zone('bathroom'),
      zone('corridor'),
      zone('hall'),
    ]);

    // Расписание на две недели: k = 0 и k = 1 у каждого ряда.
    await page.goto('/settings/house/rotations');
    await page.getByTestId('schedule-until').fill(plusDays(sunday, 7));
    await page.getByTestId('schedule-generate').click();
    await expect(page.getByTestId('schedule-done')).toBeVisible();

    // Неделя k = 0 (таблица раздела 3).
    await expectDay(page, wednesday, [
      ['kitchen', names('A')],
      ['bathroom', names('B')],
      ['corridor', names('C')],
      ['hall', names('D')],
    ]);
    await expectDay(page, sunday, [
      ['yard', names('IJ')],
      ['fridge', names('K')],
      ['kitchen', names('L')],
      ['bathroom', names('M')],
      ['corridor', names('N')],
      ['hall', names('O')],
    ]);

    // Неделя k = 1: сдвиг на одну позицию внутри каждого ряда (§2.4).
    await expectDay(page, plusDays(wednesday, 7), [
      ['kitchen', names('D')],
      ['bathroom', names('A')],
      ['corridor', names('B')],
      ['hall', names('C')],
    ]);
    await expectDay(page, plusDays(sunday, 7), [
      ['yard', names('IO')],
      ['fridge', names('J')],
      ['kitchen', names('K')],
      ['bathroom', names('L')],
      ['corridor', names('M')],
      ['hall', names('N')],
    ]);

    // Заселились двое: P входит в среду, Q — в пятницу, в норме прибавляется
    // веранда — со второй недели. Нетронутые занятия пересобираются (§2.6).
    const secondWednesday = plusDays(wednesday, 7);
    const secondFriday = plusDays(friday, 7);

    await saveRoster(page, wedRow, secondWednesday, beds('ABCDP'));
    await expect(page.getByTestId(`day-form-${wedRow}`)).toContainText('пересобрано');
    await saveNorm(page, wedRow, secondWednesday, [...weekdayNorm, zone('veranda')]);

    await saveRoster(page, friRow, secondFriday, beds('EFGHQ'));
    await saveNorm(page, friRow, secondFriday, [...weekdayNorm, zone('veranda')]);

    // Пятеро на пять зон, счётчик недель не сброшен: та же сдвижка на одну позицию.
    await expectDay(page, secondWednesday, [
      ['kitchen', names('P')],
      ['bathroom', names('A')],
      ['corridor', names('B')],
      ['hall', names('C')],
      ['veranda', names('D')],
    ]);
    await expectDay(page, secondFriday, [
      ['kitchen', names('Q')],
      ['bathroom', names('E')],
      ['corridor', names('F')],
      ['hall', names('G')],
      ['veranda', names('H')],
    ]);

    // Воскресенье не тронуто и продолжает свой цикл.
    await expectDay(page, plusDays(sunday, 7), [
      ['yard', names('IO')],
      ['fridge', names('J')],
    ]);
  });
});
