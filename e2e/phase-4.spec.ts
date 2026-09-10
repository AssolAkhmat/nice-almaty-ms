import { expect, test, type Page } from '@playwright/test';

import { E2E_ACCOUNTS, E2E_PASSWORD } from './global-setup';
import {
  assignBed,
  createResident,
  fillProfile,
  payDeposit,
  RESIDENT_PASSWORD,
  signInAs,
  unique,
} from './support/onboarding';

/**
 * Приёмка фазы 4 (docs/07-ROADMAP.md).
 *
 * Ряд из шести мест и пяти зон собирается через интерфейс, расписание
 * материализуется кнопкой, и дальше проверяется то, ради чего всё это:
 * зоны чередуются по неделям, пустующее место просит решения, а жилец
 * подтверждает свою уборку и оценки не видит.
 *
 * Дом у каждой ширины свой: ряд у дома один, и три прогона в общем доме
 * собирали бы его друг поверх друга.
 */
const HOUSES: Record<string, { name: string; admin: string }> = {
  'mobile-375': { name: 'Дом 6', admin: E2E_ACCOUNTS.adminHouse6 },
  'tablet-768': { name: 'Дом 7', admin: E2E_ACCOUNTS.adminHouse7 },
  'desktop-1440': { name: 'Дом 8', admin: E2E_ACCOUNTS.adminHouse8 },
};

/** Ближайший понедельник по календарю Алматы: с него и стартует ряд. */
function nextMonday(): string {
  const almaty = new Date(Date.now() + 5 * 60 * 60 * 1000);
  const shift = (8 - almaty.getUTCDay()) % 7 || 7;
  const monday = new Date(almaty.getTime() + shift * 24 * 60 * 60 * 1000);

  return monday.toISOString().slice(0, 10);
}

function plusDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Комната приёмки с шестью местами: столько же слотов будет и в ряду. */
async function createRoomWithSixBeds(page: Page): Promise<{ room: string; beds: string[] }> {
  const room = unique('Комната приёмки');

  await page.goto('/settings/house');
  await page.locator('#new-area-name').fill(room);
  await page.locator('#new-area-order').fill('999');
  await page.getByTestId('add-area').click();

  const card = page.locator('.rounded-card').filter({ hasText: room });
  await expect(card).toBeVisible();

  const beds: string[] = [];

  for (let index = 0; index < 6; index += 1) {
    const bed = unique('Место приёмки');

    // Поля формы добавления, а не уже заведённых мест: у них одинаковые
    // имена, и после первого места локатор по имени стал бы неоднозначным.
    await card.locator('input[id^="new-label"]').fill(bed);
    await card.locator('input[id^="new-number"]').fill(String(index + 1));
    await card.locator('input[id^="new-price"]').fill('70000');
    await card.getByTestId('add-bed').click();
    await expect(page.locator('li').filter({ hasText: bed })).toBeVisible();

    beds.push(bed);
  }

  return { room, beds };
}

/** Пять общих зон с обычным чек-листом на одного человека. */
async function createFiveZones(page: Page): Promise<string[]> {
  const zones: string[] = [];

  await page.goto('/settings/house');

  for (let index = 0; index < 5; index += 1) {
    const zone = unique('Зона e2e');

    await page.locator('#new-area-name').fill(zone);
    await page.locator('#new-area-type').selectOption('common');
    await page.locator('#new-area-order').fill(String(900 + index));
    await page.getByTestId('add-area').click();
    await expect(page.locator('.rounded-card').filter({ hasText: zone })).toBeVisible();

    zones.push(zone);
  }

  await page.goto('/settings/house/rotations');

  for (const zone of zones) {
    const card = page.locator('.rounded-card').filter({ hasText: zone });

    await card.locator('input[name="title"]').first().fill(`Уборка ${zone}`);
    await card.locator('input[name="peopleNeeded"]').first().fill('1');
    await card.getByRole('button', { name: 'Сохранить', exact: true }).first().click();
    await expect(card.getByText('Человек: 1', { exact: true }).first()).toBeVisible();

    // Каждое сохранение перерисовывает раздел: следующая зона правится
    // на свежей странице, иначе нажатие попадает в исчезающий узел.
    await page.reload();
  }

  return zones;
}

/**
 * Состав и норма дня — своими версиями с даты старта ряда (фаза 10 §2.2, §2.3).
 * Каждое сохранение перерисовывает раздел, поэтому норма правится на свежей
 * странице. Порядок мест и зон — их порядок в списке.
 */
async function setRosterAndNorm(
  page: Page,
  rowName: string,
  beds: readonly string[],
  zones: readonly string[],
): Promise<void> {
  const card = page.locator('.rounded-card').filter({ hasText: rowName });
  await expect(card.locator('[data-testid^="day-form-"]')).toBeVisible();

  for (const [index, bed] of beds.entries()) {
    await card
      .locator('label')
      .filter({ hasText: bed })
      .locator('input[type="number"]')
      .fill(String(index));
  }
  await card.locator('[data-testid^="roster-save-"]').click();
  await expect(card.getByText('Состав сохранён')).toBeVisible();
  await page.reload();

  const fresh = page.locator('.rounded-card').filter({ hasText: rowName });

  for (const [index, zone] of zones.entries()) {
    await fresh
      .locator('[data-testid^="norm-row-"]')
      .filter({ hasText: zone })
      .locator('[data-testid^="norm-zone-"]')
      .fill(String(index));
  }
  await fresh.locator('[data-testid^="norm-save-"]').click();
  await expect(fresh.getByText('Норма сохранена')).toBeVisible();
  await page.reload();
}

test.describe('приёмка фазы 4', () => {
  /*
   * Последовательно: ряд у дома один, а дом у ширины тоже один. Параллельно
   * два сценария собирали бы ряд друг поверх друга, и второй видел бы
   * в календаре чужие зоны.
   */
  test.describe.configure({ mode: 'serial' });

  // Сценарий длинный: шесть мест, пять зон, ряд, расписание и уборка за собой.
  test.setTimeout(300_000);

  test('ряд из шести мест и пяти зон даёт ожидаемую матрицу за четыре недели', async ({
    page,
  }, testInfo) => {
    const house = HOUSES[testInfo.project.name];

    if (house === undefined) {
      throw new Error(`Нет дома приёмки для ширины ${testInfo.project.name}`);
    }

    await signInAs(page, house.admin, E2E_PASSWORD);

    const { room, beds } = await createRoomWithSixBeds(page);
    const zones = await createFiveZones(page);

    // Ряд: шесть слотов и пять зон, старт — ближайший понедельник.
    const start = nextMonday();
    await page.goto('/settings/house/rotations');

    const form = page.getByTestId('row-form-new');
    const rowName = unique('Ряд приёмки');
    await form.getByTestId('row-name-new').fill(rowName);
    await form.getByTestId('row-weekday-new').selectOption('1');
    await form.getByTestId('row-start-new').fill(start);
    await form.getByTestId('row-save-new').click();

    // Ряд сохранён: его имя появилось в форме правки. Перезагрузка до этого
    // показала бы страницу без ряда, и состав было бы некуда записать.
    await expect(page.locator(`input[value="${rowName}"]`)).toBeVisible();
    await page.reload();

    // Шесть мест в составе и пять зон в норме — с даты старта ряда.
    await setRosterAndNorm(page, rowName, beds, zones);

    // Расписание на четыре недели вперёд.
    await page.getByTestId('schedule-until').fill(plusDays(start, 21));
    await page.getByTestId('schedule-generate').click();
    await expect(page.getByTestId('schedule-done')).toBeVisible();

    // Первая неделя: пять зон ряда, каждая по одному разу.
    await page.goto(`/rotations?mode=day&date=${start}`);
    const firstDay = page.locator('main');

    for (const zone of zones) {
      await expect(firstDay.getByText(zone, { exact: false }).first()).toBeVisible();
    }

    // Четвёртая неделя: те же пять зон, но у слотов они уже другие —
    // сетка сдвинулась на три позиции (§6.2).
    await page.goto(`/rotations?mode=day&date=${plusDays(start, 21)}`);

    for (const zone of zones) {
      await expect(page.locator('main').getByText(zone, { exact: false }).first()).toBeVisible();
    }

    // Пустующее место просит решения, а не исчезает (§6.3).
    await expect(page.locator('main').getByText('Требует решения').first()).toBeVisible();

    // Уборка за собой: ряд выключается, места и зоны уходят в архив.
    // Зона с местами не архивируется, поэтому места убираются первыми.
    await page.goto('/settings/house/rotations');
    await page
      .locator('form')
      .filter({ hasText: 'Выключить ряд' })
      .first()
      .getByRole('button', { name: 'Выключить ряд' })
      .click();

    await page.goto('/settings/house');
    const roomCard = page.locator('.rounded-card').filter({ hasText: room });

    for (const bed of beds) {
      await roomCard
        .locator('li')
        .filter({ hasText: bed })
        .getByRole('button', { name: 'Убрать место в архив' })
        .click();
      await expect(page.getByText(bed)).toHaveCount(0);
    }

    for (const name of [room, ...zones]) {
      await page
        .locator('.rounded-card')
        .filter({ hasText: name })
        .getByRole('button', { name: 'Убрать зону в архив' })
        .click();
      await expect(page.getByText(name)).toHaveCount(0);
    }
  });

  test('жилец подтверждает свою ротацию и не видит оценки', async ({ page }, testInfo) => {
    const house = HOUSES[testInfo.project.name];

    if (house === undefined) {
      throw new Error(`Нет дома приёмки для ширины ${testInfo.project.name}`);
    }

    // Жилец с местом: только у него появится своя ротация.
    const phone = await createResident(page, house.name);
    const lastName = unique('Дежурин');
    const fullName = `${lastName} Тест`;

    await signInAs(page, phone, RESIDENT_PASSWORD);
    await fillProfile(page, lastName);

    await signInAs(page, house.admin, E2E_PASSWORD);

    const room = unique('Комната приёмки');
    const bed = unique('Место приёмки');

    await page.goto('/settings/house');
    await page.locator('#new-area-name').fill(room);
    await page.locator('#new-area-order').fill('998');
    await page.getByTestId('add-area').click();

    const roomCard = page.locator('.rounded-card').filter({ hasText: room });
    await expect(roomCard).toBeVisible();
    await roomCard.locator('input[name="label"]').fill(bed);
    await roomCard.locator('input[name="defaultPrice"]').fill('70000');
    await roomCard.getByTestId('add-bed').click();
    await expect(page.locator('li').filter({ hasText: bed })).toBeVisible();

    await assignBed(page, fullName, room, bed);
    await payDeposit(page, lastName);

    // Зона с чек-листом и ряд из одного места: ротация достаётся жильцу.
    const zone = unique('Зона e2e');
    await page.goto('/settings/house');
    await page.locator('#new-area-name').fill(zone);
    await page.locator('#new-area-type').selectOption('common');
    await page.locator('#new-area-order').fill('997');
    await page.getByTestId('add-area').click();
    await expect(page.locator('.rounded-card').filter({ hasText: zone })).toBeVisible();

    await page.goto('/settings/house/rotations');
    const zoneCard = page.locator('.rounded-card').filter({ hasText: zone });
    await zoneCard.locator('input[name="title"]').first().fill(`Уборка ${zone}`);
    await zoneCard.getByRole('button', { name: 'Сохранить', exact: true }).first().click();
    await expect(zoneCard.getByText('Человек: 1', { exact: true }).first()).toBeVisible();

    const start = nextMonday();
    await page.reload();

    const form = page.getByTestId('row-form-new');
    const rowName = unique('Ряд приёмки');
    await form.getByTestId('row-name-new').fill(rowName);
    await form.getByTestId('row-weekday-new').selectOption('1');
    await form.getByTestId('row-start-new').fill(start);
    await form.getByTestId('row-save-new').click();
    await expect(page.locator(`input[value="${rowName}"]`)).toBeVisible();

    await page.reload();
    await setRosterAndNorm(page, rowName, [bed], [zone]);
    await page.getByTestId('schedule-until').fill(start);
    await page.getByTestId('schedule-generate').click();
    await expect(page.getByTestId('schedule-done')).toBeVisible();

    // Админ ставит оценку — жилец её не увидит.
    await page.goto(`/rotations?mode=day&date=${start}`);
    await page.locator('main').locator('[data-testid^="mark-score-"]').first().fill('9');
    await page.locator('main').getByRole('button', { name: 'Отметить' }).first().click();
    await expect(page.locator('main').getByText('Отметка сохранена').first()).toBeVisible();

    // Жилец видит свою ротацию, но не оценку.
    await signInAs(page, phone, RESIDENT_PASSWORD);
    await page.goto(`/rotations?mode=day&date=${start}`);

    const residentMain = page.locator('main');
    await expect(residentMain.getByText('Моя').first()).toBeVisible();
    await expect(residentMain.getByText('Оценка:')).toHaveCount(0);
  });
});
