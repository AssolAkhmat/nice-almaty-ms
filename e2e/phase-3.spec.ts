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
 * Приёмка фазы 3 (docs/07-ROADMAP.md).
 *
 * Деньги за месяц идут через интерфейс от начисления до оплаты: счёт
 * собирается из проживания, ручной строки и доли коммуналки, платится
 * частями до статуса «Оплачен», а ущерб списывается с депозита и виден
 * жильцу в движении депозита.
 *
 * Жилец заселяется сегодня, поэтому прошлый месяц он не жил ни дня и в его
 * распределении не участвует (§4.2). Коммуналка здесь — за текущий месяц,
 * и попадает она в счёт следующего: §3 ведёт коммуналку за прошлый месяц,
 * и другого способа увидеть это в тот же день нет.
 *
 * Обходных путей нет: ни одна запись не создаётся мимо экранов, иначе
 * проверялась бы фикстура, а не система.
 */
const RENT = 70_000;
const UTILITIES = 30_000;
const EXTRA = 5_000;
const DAMAGE = 20_000;

/** Первое число месяца по календарю Алматы (UTC+5, без переходов). */
function monthStart(offset: number): string {
  const almaty = new Date(Date.now() + 5 * 60 * 60 * 1000);
  const month = new Date(Date.UTC(almaty.getUTCFullYear(), almaty.getUTCMonth() + offset, 1));

  return month.toISOString().slice(0, 10);
}

/** Ручной счёт: проживание плюс ручная строка. Коммуналку допишет период. */
async function issueInvoice(
  page: Page,
  resident: string,
  note: string,
  month: string,
): Promise<void> {
  await page.goto('/invoices');

  await page.getByTestId('invoice-residency').selectOption({ label: resident });

  await page.getByTestId('line-title').fill('Проживание');
  await page.getByTestId('line-amount').fill(String(RENT));
  await page.getByRole('button', { name: 'Добавить строку' }).click();

  await page.getByTestId('line-title').fill(note);
  await page.getByTestId('line-amount').fill(String(EXTRA));
  await page.getByRole('button', { name: 'Добавить строку' }).click();

  await page.locator('#invoice-period').fill(month);
  await page.getByRole('button', { name: 'Выставить', exact: true }).click();

  await expect(page.locator('main')).toContainText('Счёт выставлен');
}

/**
 * Период коммуналки за текущий месяц: строка, итог, закрытие.
 * Закрытие дописывает долю в уже выставленный счёт следующего месяца (§4).
 */
async function closePeriod(page: Page, title: string): Promise<void> {
  await page.goto(`/utilities?month=${monthStart(0)}`);

  await page.getByTestId('utility-title').fill(title);
  await page.getByTestId('utility-amount').fill(String(UTILITIES));
  await page.getByRole('button', { name: 'Добавить строку' }).click();
  await expect(page.locator('main')).toContainText(title);

  await page.getByTestId('close-period').click();

  // Именно значок состояния, а не кнопка «Закрыть период» рядом с ним.
  await expect(page.locator('main').getByText('Закрыт', { exact: true })).toBeVisible();
}

/**
 * Дом на каждую ширину свой: коммунальный период у дома один на месяц,
 * и три копии приёмки в общем доме отбирали бы его друг у друга.
 */
const HOUSE_BY_PROJECT: Readonly<Record<string, { name: string; admin: string }>> = {
  'mobile-375': { name: 'Дом 3', admin: E2E_ACCOUNTS.adminHouse3 },
  'tablet-768': { name: 'Дом 4', admin: E2E_ACCOUNTS.adminHouse4 },
  'desktop-1440': { name: 'Дом 5', admin: E2E_ACCOUNTS.adminHouse5 },
};

test.describe('приёмка фазы 3', () => {
  test('счёт за месяц от начисления до оплаты и ущерб на депозите', async ({ page }, testInfo) => {
    test.setTimeout(240_000);

    const house = HOUSE_BY_PROJECT[testInfo.project.name];
    if (house === undefined) {
      throw new Error(`Дом приёмки не задан для ширины ${testInfo.project.name}`);
    }

    const phone = await createResident(page, house.name);
    // Фамилия уникальна: база между прогонами общая, и однофамильцы
    // превратили бы поиск строки в лотерею.
    const lastName = unique('Деньгин');
    const fullName = `${lastName} Тест`;

    await signInAs(page, phone, RESIDENT_PASSWORD);
    await fillProfile(page, lastName);

    await signInAs(page, house.admin, E2E_PASSWORD);
    const { room, bed } = await createRoomWithBed(page, String(RENT));
    await assignBed(page, fullName, room, bed);
    await payDeposit(page, lastName);

    const extraTitle = unique('Замена ключа');
    const nextMonth = monthStart(1);
    await issueInvoice(page, fullName, extraTitle, nextMonth);

    const utilityTitle = unique('Электричество');
    await closePeriod(page, utilityTitle);

    /*
     * Счёт собран из трёх источников: проживание и ручная строка выставлены
     * руками, доля коммуналки дописана закрытием периода.
     */
    await page.goto(`/invoices?month=${nextMonth}`);
    await page.getByRole('link', { name: lastName }).first().click();

    const main = page.locator('main');
    await expect(main).toContainText('Проживание');
    await expect(main).toContainText(extraTitle);
    await expect(main).toContainText('Коммунальные услуги за');

    /*
     * Единственный жилец дома делит коммуналку один: 70 000 проживания,
     * 5 000 ручной строки и все 30 000 коммуналки. Остаток проверяется
     * числом, а не текстом: формат денег на экране к делу не относится.
     */
    const payment = page.getByTestId('invoice-payment-amount');
    expect(Number(await payment.inputValue())).toBe(RENT + EXTRA + UTILITIES);

    // Оплата частями: §3 разрешает несколько платежей на один счёт.
    await payment.fill('30000');
    await page.getByRole('button', { name: 'Отметить оплату' }).click();
    await expect(main.getByText('Частично оплачен', { exact: true })).toBeVisible();

    expect(Number(await payment.inputValue())).toBe(RENT + EXTRA + UTILITIES - 30_000);

    await page.getByRole('button', { name: 'Отметить оплату' }).click();
    await expect(main.getByText('Оплачен', { exact: true })).toBeVisible();

    /*
     * Ущерб: списывается с депозита участника и виден жильцу в движении
     * депозита с числом участников (§8, модуль 7).
     */
    const damageTitle = unique('Ручка в туалете');
    await page.goto('/damages');
    await page.getByTestId('damage-title').fill(damageTitle);
    await page.getByTestId('damage-amount').fill(String(DAMAGE));
    await page.getByTestId('damage-mode').selectOption('single');

    await page.locator('label').filter({ hasText: fullName }).getByRole('checkbox').click();
    await expect(page.getByTestId('damage-preview')).toBeVisible();

    await page.getByRole('button', { name: 'Провести и списать' }).click();
    await expect(main).toContainText('Ущерб проведён');

    await signInAs(page, phone, RESIDENT_PASSWORD);
    await page.goto('/deposit');

    const deposit = page.getByTestId('deposit-card');
    await expect(deposit).toContainText(damageTitle);
    await expect(deposit).toContainText('делили 1 чел.');
  });
});
