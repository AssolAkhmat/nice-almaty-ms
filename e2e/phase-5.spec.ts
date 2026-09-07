import { expect, test, type Page } from '@playwright/test';

import { E2E_ACCOUNTS, E2E_PASSWORD } from './global-setup';
import {
  assignBed,
  createResident,
  createRoomWithBed,
  fillProfile,
  payDeposit,
  RESIDENT_PASSWORD,
  signInAs,
  unique,
} from './support/onboarding';

/**
 * Приёмка фазы 5 (docs/07-ROADMAP.md).
 *
 * Рейтинг падает от действий админа, пересечённый порог сам заводит долг
 * и штраф, суперадмин штраф отменяет. Одобренное долгосрочное отсутствие
 * уменьшает долю коммуналки ровно на дни строго между датами. Жилец при
 * этом видит только своё число: ни истории, ни чужого рейтинга.
 *
 * Дом у каждой ширины свой: период коммуналки у дома один на месяц,
 * и три прогона в общем доме отбирали бы его друг у друга.
 */
const HOUSE_BY_PROJECT: Readonly<Record<string, { name: string; admin: string }>> = {
  'mobile-375': { name: 'Дом 6', admin: E2E_ACCOUNTS.adminHouse6 },
  'tablet-768': { name: 'Дом 7', admin: E2E_ACCOUNTS.adminHouse7 },
  'desktop-1440': { name: 'Дом 8', admin: E2E_ACCOUNTS.adminHouse8 },
};

const UTILITIES = 30_000;

/** Сегодня по календарю Алматы (UTC+5, без переходов). */
function almatyToday(): Date {
  return new Date(Date.now() + 5 * 60 * 60 * 1000);
}

/** Первое число следующего месяца: в нём и считается коммуналка приёмки. */
function nextMonthStart(): string {
  const almaty = almatyToday();

  return new Date(Date.UTC(almaty.getUTCFullYear(), almaty.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 10);
}

/**
 * Дата в следующем месяце: отсутствие ставится туда целиком, иначе в конце
 * месяца диапазон уезжал бы за его границу и дни вычитались бы из другого.
 */
function nextMonthDay(day: number): string {
  const month = nextMonthStart();

  return `${month.slice(0, 8)}${String(day).padStart(2, '0')}`;
}

/**
 * Дни жильца в распределении коммуналки.
 *
 * Таблица на узком экране превращается в карточки, поэтому значение
 * берётся из видимой раскладки, а не из той, что оказалась первой в DOM.
 */
async function daysOf(page: Page, name: string): Promise<number> {
  const card = page.locator('li').filter({ hasText: name }).first();

  if (await card.isVisible()) {
    return Number((await card.locator('dd').nth(1).innerText()).trim());
  }

  const row = page.locator('tr').filter({ hasText: name }).first();

  return Number((await row.locator('td').nth(1).innerText()).trim());
}

/** Жилец с местом в доме приёмки: имя, телефон и заведённая комната. */
async function moveIn(
  page: Page,
  house: { name: string; admin: string },
  prefix: string,
): Promise<{ fullName: string; phone: string }> {
  // Заселение начинается с суперадмина: сессия предыдущего шага мешает
  // форме входа — по живой куке /login уводит внутрь приложения.
  await page.context().clearCookies();

  const phone = await createResident(page, house.name);
  const lastName = unique(prefix);
  const fullName = `${lastName} Тест`;

  await signInAs(page, phone, RESIDENT_PASSWORD);
  await fillProfile(page, lastName);

  await signInAs(page, house.admin, E2E_PASSWORD);

  const { room, bed } = await createRoomWithBed(page);
  await assignBed(page, fullName, room, bed);

  // Проживание становится активным после оплаты депозита: до этого жильца
  // нет ни в ротациях, ни в рейтинге дома.
  await payDeposit(page, lastName);

  return { fullName, phone };
}

test.describe('приёмка фазы 5', () => {
  test.describe.configure({ mode: 'serial' });

  test('порог рейтинга заводит долг и штраф, суперадмин его отменяет', async ({
    page,
  }, testInfo) => {
    test.setTimeout(420_000);

    const house = HOUSE_BY_PROJECT[testInfo.project.name];
    if (house === undefined) {
      throw new Error(`Дом приёмки не задан для ширины ${testInfo.project.name}`);
    }

    const { fullName, phone } = await moveIn(page, house, 'Рейтингов');

    // Три строгих выговора: 50 → 40 → 30 → 20. Пороги 40 и 30 пересечены.
    await page.goto('/rating');
    await page.getByTestId('house-rating').getByRole('link', { name: fullName }).click();
    await expect(page.getByTestId('resident-rating')).toHaveText('50');

    for (let index = 0; index < 3; index += 1) {
      await page.getByTestId('event-type').selectOption('severe_reprimand');
      await page.getByTestId('event-reason').fill(`Проверка ${String(index + 1)}`);
      await page.getByTestId('add-event').getByRole('button', { name: 'Записать' }).click();
      await expect(page.getByTestId('event-added')).toBeVisible();
      await page.reload();
    }

    await expect(page.getByTestId('resident-rating')).toHaveText('20');

    // Долг по дополнительной ротации и штраф 2 500 ₸ — от порогов 40 и 30 (§5.3).
    await expect(page.locator('main')).toContainText('Долгов по дополнительным ротациям: 2');
    const fines = page.getByTestId('rating-fines');
    await expect(fines).toContainText('ждёт счёта');

    // Жилец видит только число: ни истории, ни списка дома (§5.6).
    await signInAs(page, phone, RESIDENT_PASSWORD);
    await page.goto('/rating');
    await expect(page.getByTestId('my-rating')).toHaveText('20');
    await expect(page.getByTestId('house-rating')).toHaveCount(0);
    await expect(page.getByTestId('rating-history')).toHaveCount(0);

    // Штраф отменяет суперадмин, и в карточке это видно (§5.5).
    await signInAs(page, E2E_ACCOUNTS.superadmin, E2E_PASSWORD);
    await page.goto('/rating');
    // Своего дома у суперадмина нет: дом он выбирает сам.
    await page.getByTestId('rating-houses').getByRole('link', { name: house.name }).click();
    await page.getByTestId('house-rating').getByRole('link', { name: fullName }).click();

    await page.getByTestId('fine-reason').first().fill('Разобрались');
    await page
      .getByTestId('rating-fines')
      .getByRole('button', { name: 'Отменить' })
      .first()
      .click();

    await expect(page.getByTestId('rating-fines')).toContainText('отменён');
  });

  test('одобренное отсутствие уменьшает долю коммуналки', async ({ page }, testInfo) => {
    // Два полных заселения через интерфейс: это дольше одного сценария фазы 3.
    test.setTimeout(600_000);

    const house = HOUSE_BY_PROJECT[testInfo.project.name];
    if (house === undefined) {
      throw new Error(`Дом приёмки не задан для ширины ${testInfo.project.name}`);
    }

    const away = await moveIn(page, house, 'Уезжаев');
    const stays = await moveIn(page, house, 'Домоседов');

    // Отъезд с 5 по 9 число следующего месяца: 6, 7 и 8 не считаются (§4.2).
    await signInAs(page, away.phone, RESIDENT_PASSWORD);
    await page.goto('/absences');
    await page.getByTestId('absence-type').selectOption('long');
    await page.getByTestId('absence-start').fill(nextMonthDay(5));
    await page.getByTestId('absence-end').fill(nextMonthDay(9));
    await page.getByTestId('absence-reason').fill('Уезжаю к родным');
    await page.getByTestId('absence-submit').click();
    await expect(page.locator('main')).toContainText('Ждёт решения');

    await signInAs(page, house.admin, E2E_PASSWORD);
    await page.goto('/absences');
    await page
      .getByTestId('absence-queue')
      .locator('[data-testid^="absence-approve-"]')
      .first()
      .click();
    await expect(page.getByTestId('absence-queue')).toHaveCount(0);

    // Коммуналка следующего месяца: доля отсутствовавшего меньше на три дня.
    await page.goto(`/utilities?month=${nextMonthStart()}`);
    await page.getByTestId('utility-title').fill('Электричество');
    await page.getByTestId('utility-amount').fill(String(UTILITIES));
    await page.getByRole('button', { name: 'Добавить строку' }).click();
    await expect(page.locator('main')).toContainText('Электричество');

    await page.getByTestId('close-period').click();
    await expect(page.locator('main').getByText('Закрыт', { exact: true })).toBeVisible();

    const awayDays = await daysOf(page, away.fullName);
    const staysDays = await daysOf(page, stays.fullName);

    // 5 и 9 числа прожиты, 6, 7 и 8 — нет: ровно дни строго между (§4.2).
    expect(staysDays - awayDays).toBe(3);
  });
});
