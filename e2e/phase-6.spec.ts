import { expect, test, type Page } from '@playwright/test';

import { E2E_ACCOUNTS, E2E_CRON_SECRET, E2E_PASSWORD } from './global-setup';
import {
  assignBed,
  createResident,
  fillProfile,
  payDeposit,
  RESIDENT_PASSWORD,
  signInAs,
  unique,
} from './support/onboarding';
import { setRosterAndNorm } from './support/rotations';

/**
 * Приёмка фазы 6 (docs/07-ROADMAP.md).
 *
 * Три критерия: приложение устанавливается на телефон, уведомление
 * о неподтверждённой уборке доходит до центра уведомлений, повторный
 * вызов задания ничего не дублирует.
 *
 * Дом у каждой ширины свой: задание напоминаний идёт по всей сети сразу,
 * и три копии приёмки в общем доме считали бы уведомления друг друга.
 */
const HOUSES: Readonly<Record<string, { name: string; admin: string }>> = {
  'mobile-375': { name: 'Дом 9', admin: E2E_ACCOUNTS.adminHouse9 },
  'tablet-768': { name: 'Дом 10', admin: E2E_ACCOUNTS.adminHouse10 },
  'desktop-1440': { name: 'Дом 11', admin: E2E_ACCOUNTS.adminHouse11 },
};

/**
 * Ширина, на которой идёт шаг с заданием.
 *
 * Задание рассылает по всей сети сразу и идемпотентно по паре «день
 * и слот» (P6-21): три копии приёмки в одном слоте физически не могут
 * разослать трижды — вторая и третья честно получат «уже разослано».
 * Это свойство системы, а не теста, поэтому шаг с заданием идёт один раз;
 * экраны, которые он затрагивает, проверяются на всех трёх ширинах
 * приёмкой установки и набором `notifications.spec` (P6-42).
 */
const JOB_PROJECT = 'mobile-375';

function almatyNow(): Date {
  return new Date(Date.now() + 5 * 60 * 60 * 1000);
}

/**
 * День, о котором напомнит задание прямо сейчас.
 *
 * Утренний прогон говорит о сегодняшней уборке, вечерний — о завтрашней
 * (P6-21). Приёмка идёт в любое время суток, поэтому уборка ставится
 * на тот день, который задание и назовёт.
 */
function targetDate(): string {
  const almaty = almatyNow();
  const shift = almaty.getUTCHours() < 12 ? 0 : 1;

  return new Date(almaty.getTime() + shift * 86_400_000).toISOString().slice(0, 10);
}

/** Номер дня недели в понимании ряда: 1 — понедельник, 7 — воскресенье. */
function weekdayOf(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();

  return String(day === 0 ? 7 : day);
}

/** Зона с чек-листом на одного человека: без неё ряду нечего раздавать. */
async function createZone(page: Page): Promise<string> {
  const zone = unique('Зона фазы 6');

  await page.goto('/settings/house');
  await page.locator('#new-area-name').fill(zone);
  await page.locator('#new-area-type').selectOption('common');
  await page.locator('#new-area-order').fill('980');
  await page.getByTestId('add-area').click();
  await expect(page.locator('.rounded-card').filter({ hasText: zone })).toBeVisible();

  await page.goto('/settings/house/rotations');
  const card = page.locator('.rounded-card').filter({ hasText: zone });
  await card.locator('input[name="title"]').first().fill(`Уборка ${zone}`);
  await card.locator('input[name="peopleNeeded"]').first().fill('1');
  await card.getByRole('button', { name: 'Сохранить', exact: true }).first().click();
  await expect(card.getByText('Человек: 1', { exact: true }).first()).toBeVisible();

  return zone;
}

test.describe('приёмка фазы 6', () => {
  test('напоминание об уборке доходит до центра уведомлений и не дублируется', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== JOB_PROJECT,
      'Задание сетевое и идемпотентное по слоту: второй копии оно ответит «уже разослано»',
    );
    test.setTimeout(240_000);

    const house = HOUSES[testInfo.project.name];

    if (house === undefined) {
      throw new Error(`Нет дома приёмки для ширины ${testInfo.project.name}`);
    }

    // Жилец с местом: назначение ряда идёт на место, а не на человека.
    const phone = await createResident(page, house.name);
    const lastName = unique('Уведомлин');
    const fullName = `${lastName} Тест`;

    await signInAs(page, phone, RESIDENT_PASSWORD);
    await fillProfile(page, lastName);

    await signInAs(page, house.admin, E2E_PASSWORD);

    const room = unique('Комната фазы 6');
    await page.goto('/settings/house');
    await page.locator('#new-area-name').fill(room);
    await page.locator('#new-area-order').fill('980');
    await page.getByTestId('add-area').click();

    const roomCard = page.locator('.rounded-card').filter({ hasText: room });
    const bed = unique('Место фазы 6');
    await roomCard.locator('input[id^="new-label"]').fill(bed);
    await roomCard.locator('input[id^="new-number"]').fill('1');
    await roomCard.locator('input[id^="new-price"]').fill('70000');
    await roomCard.getByTestId('add-bed').click();
    await expect(page.locator('li').filter({ hasText: bed })).toBeVisible();

    await assignBed(page, fullName, room, bed);
    await payDeposit(page, lastName);

    const zone = await createZone(page);

    // Ряд на тот день, о котором задание напомнит в этот час суток.
    const today = targetDate();
    await page.goto('/settings/house/rotations');

    const form = page.getByTestId('row-form-new');
    const rowName = unique('Ряд фазы 6');
    await form.getByTestId('row-name-new').fill(rowName);
    await form.getByTestId('row-weekday-new').selectOption(weekdayOf(today));
    await form.getByTestId('row-start-new').fill(today);
    await form.getByTestId('row-save-new').click();

    await expect(page.locator(`input[value="${rowName}"]`)).toBeVisible();
    await page.reload();

    // Состав из одного места и норма из одной зоны — с даты старта (фаза 10).
    await setRosterAndNorm(page, rowName, [bed], [zone]);

    await page.getByTestId('schedule-until').fill(today);
    await page.getByTestId('schedule-generate').click();
    await expect(page.getByTestId('schedule-done')).toBeVisible();

    // Уборка на нужный день есть и не подтверждена.
    await page.goto(`/rotations?mode=day&date=${today}`);
    await expect(page.locator('main')).toContainText(lastName);

    /*
     * Задание дёргается тем же путём, что и расписанием: HTTP с секретом.
     * Обходных путей у приёмки нет — иначе она проверяла бы не систему.
     */
    const first = await request.post('/api/v1/cron/rotations-remind', {
      headers: { 'x-cron-secret': E2E_CRON_SECRET },
    });
    expect(first.status()).toBe(200);

    await signInAs(page, phone, RESIDENT_PASSWORD);
    await page.goto('/notifications');

    const list = page.locator('main');
    await expect(list).toContainText('уборка');

    const before = await page.locator('main li').count();

    // Повторный вызов того же слота: рассылки не будет.
    const second = await request.post('/api/v1/cron/rotations-remind', {
      headers: { 'x-cron-secret': E2E_CRON_SECRET },
    });
    expect(second.status()).toBe(200);

    await page.reload();
    expect(await page.locator('main li').count()).toBe(before);
  });

  test('приложение устанавливается на телефон', async ({ page, request }) => {
    const manifest = await request.get('/manifest.webmanifest');
    expect(manifest.status()).toBe(200);

    const parsed = (await manifest.json()) as { display: string; icons: { sizes: string }[] };
    expect(parsed.display).toBe('standalone');
    expect(parsed.icons.map((icon) => icon.sizes)).toContain('192x192');

    const worker = await request.get('/sw.js');
    expect(worker.status()).toBe(200);

    await signInAs(page, E2E_ACCOUNTS.superadmin, E2E_PASSWORD);

    const registered = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();

      return registration !== undefined;
    });

    expect(registered).toBe(true);
  });
});
