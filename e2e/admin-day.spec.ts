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
import { approveDocuments, buildContract, signContract, uploadDocuments } from './support/contract';
import { visible } from './support/table';
import { openUtilityPeriod } from './support/utilities';

/**
 * Сквозная приёмка «рабочий день админа» (указание владельца, 27 сентября 2026).
 *
 * Смысл её не в новых проверках, а в том, что весь рабочий день админа
 * проходится **целиком, одним подряд**. Находки боевой эксплуатации 27 сентября
 * — счёт на ноль тенге, который нельзя закрыть (P1-3), отсутствие отметки
 * оплаты (P1-4), раздел бухгалтерии у админа дома (P0-2), коммуналка без
 * корректировки суток (P2-6) — это не сложные ошибки. Это шаги, которые
 * по отдельности проверены, а подряд не прошёл ни один тест.
 *
 * Поэтому здесь ничего не создаётся мимо экранов и ни один шаг не пропускается
 * ради скорости: день админа выглядит так, как он выглядит у него.
 *
 * Заселение и деньги за месяц подробно разобраны приёмками фаз 2 и 3; здесь
 * они идут короче и общими шагами, зато к ним пристроено то, что до 27 сентября
 * не проходил никто подряд: корректировка суток, доля дома, переселение внутри
 * дома, нарушение и закрытие месяца.
 */
const RENT = 60_000;
const UTILITIES = 24_000;
const PART = 20_000;

/** Первое число текущего месяца по календарю Алматы (UTC+5, без переходов). */
function monthStart(offset: number): string {
  const almaty = new Date(Date.now() + 5 * 60 * 60 * 1000);
  const month = new Date(Date.UTC(almaty.getUTCFullYear(), almaty.getUTCMonth() + offset, 1));

  return month.toISOString().slice(0, 10);
}

/**
 * Дом на каждую ширину свой: коммунальный период у дома один на месяц,
 * и три копии приёмки в общем доме отбирали бы его друг у друга.
 */
const HOUSE_BY_PROJECT: Readonly<Record<string, { name: string; admin: string }>> = {
  'mobile-375': { name: 'Дом 15', admin: E2E_ACCOUNTS.adminHouse15 },
  'tablet-768': { name: 'Дом 16', admin: E2E_ACCOUNTS.adminHouse16 },
  'desktop-1440': { name: 'Дом 17', admin: E2E_ACCOUNTS.adminHouse17 },
};

/**
 * Раздел бухгалтерии админу дома закрыт (P0-2): ни в меню, ни по прямой
 * ссылке. Скрытая ссылка на открытый роут исправлением не считается,
 * поэтому проверяются оба.
 */
async function accountingIsClosed(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('a[href="/accounting"]')).toHaveCount(0);

  await page.goto('/accounting');
  await expect(page.locator('main')).toContainText('Раздел для суперадмина');
}

test.describe('сквозная приёмка: рабочий день админа', () => {
  test('от заведения жильца до закрытия месяца', async ({ page }, testInfo) => {
    /*
     * Бюджет как у приёмки фазы 2: путь тот же, и так же печатается PDF
     * договора, а три ширины делают это на одной машине.
     */
    test.setTimeout(480_000);

    const house = HOUSE_BY_PROJECT[testInfo.project.name];
    if (house === undefined) {
      throw new Error(`Дом приёмки не задан для ширины ${testInfo.project.name}`);
    }

    const lastName = unique('Деньков');
    const fullName = `${lastName} Тест`;

    /* 1. Жилец заведён и заполнил профиль. */
    const phone = await createResident(page, house.name);
    await signInAs(page, phone, RESIDENT_PASSWORD);
    await fillProfile(page, lastName);

    /* 2. Место и цена — работа админа. */
    await signInAs(page, house.admin, E2E_PASSWORD);
    await accountingIsClosed(page);

    const first = await createRoomWithBed(page, String(RENT));
    await assignBed(page, fullName, first.room, first.bed);
    await buildContract(page, lastName);

    /* 3. Договор подписывает жилец, документы загружает он же. */
    await signInAs(page, phone, RESIDENT_PASSWORD);
    await signContract(page);
    await uploadDocuments(page);

    /*
     * Проверяет документы суперадмин: доступ админа к ним сеть по умолчанию
     * не включает (D28), и очередь у админа пуста — так же, как в приёмке
     * фазы 2.
     */
    await signInAs(page, E2E_ACCOUNTS.superadmin, E2E_PASSWORD);
    await approveDocuments(page, lastName);

    await signInAs(page, house.admin, E2E_PASSWORD);
    await payDeposit(page, lastName);

    /* 4. Коммуналка за неполный месяц: жилец заехал сегодня. */
    await openUtilityPeriod(page, monthStart(0));

    const utilityTitle = unique('Электричество');
    await page.getByTestId('utility-title').fill(utilityTitle);
    await page.getByTestId('utility-amount').fill(String(UTILITIES));
    await page.getByRole('button', { name: 'Добавить строку' }).click();
    await expect(page.locator('main')).toContainText(utilityTitle);

    /*
     * Доля дома в человеко-днях (P2-7): общие помещения греются независимо
     * от заселённости. Ненулевая доля без причины не сохраняется.
     */
    await page.getByTestId('house-days').fill('5');
    await page.getByTestId('house-days-comment').fill('Общие помещения');
    await page.getByTestId('house-share-save').click();
    await expect(page.getByTestId('house-share-done')).toBeVisible();

    /*
     * Корректировка суток (P2-6): уменьшение проходит с причиной,
     * увеличение — только с подтверждением. Здесь уменьшение.
     */
    await page.getByTestId('days-value').fill('1');
    await page.getByTestId('days-comment').fill('Уезжал, отсутствие не оформлял');
    await page.getByTestId('days-preview-submit').click();
    await expect(page.getByTestId('days-preview')).toBeVisible();

    await page.getByTestId('days-save').click();
    await expect(page.getByTestId('days-done')).toBeVisible();

    /* 5. Счёт: проживание одной строкой на следующий месяц. */
    const nextMonth = monthStart(1);
    await page.goto('/invoices');

    /* Отказ называет причину, а не выглядит таймаутом выбора (см. фазу 3). */
    await expect(
      page.getByTestId('invoice-residency').locator('option', { hasText: fullName }),
      'жильца нет в списке формы счёта — подпись собралась пустой?',
    ).toHaveCount(1, { timeout: 15_000 });

    await page.getByTestId('invoice-residency').selectOption({ label: fullName });
    await page.getByTestId('line-title').fill('Проживание');
    await page.getByTestId('line-amount').fill(String(RENT));
    await page.getByRole('button', { name: 'Добавить строку' }).click();
    await page.locator('#invoice-period').fill(nextMonth);
    await page.getByRole('button', { name: 'Выставить', exact: true }).click();
    await expect(page.locator('main')).toContainText('Счёт выставлен');

    /* 6. Закрытие месяца: доля коммуналки дописывается в этот же счёт (§4). */
    await openUtilityPeriod(page, monthStart(0));
    await page.getByTestId('close-period').click();
    await expect(page.locator('main').getByText('Закрыт', { exact: true })).toBeVisible();

    /* 7. Частичная оплата и добивание счёта до «Оплачен» (P1-4). */
    await page.goto(`/invoices?month=${nextMonth}`);
    await page.getByRole('link', { name: lastName }).first().click();

    const main = page.locator('main');
    await expect(main).toContainText('Проживание');
    await expect(main).toContainText('Коммунальные услуги за');

    const payment = page.getByTestId('invoice-payment-amount');
    const total = Number(await payment.inputValue());
    expect(total).toBeGreaterThan(RENT);

    await payment.fill(String(PART));
    await page.getByRole('button', { name: 'Отметить оплату' }).click();
    await expect(main.getByText('Частично оплачен', { exact: true })).toBeVisible();

    /* Остаток — деньгами, а не числом счетов (P1-3). */
    expect(Number(await payment.inputValue())).toBe(total - PART);

    await page.getByRole('button', { name: 'Отметить оплату' }).click();
    await expect(main.getByText('Оплачен', { exact: true })).toBeVisible();

    /*
     * 8. Переселение внутри дома (P1-5): назначение закрывается датой
     * и открывается новое. Цена места та же, поэтому согласие не требуется.
     */
    const second = await createRoomWithBed(page, String(RENT));

    await page.goto('/residents');
    await page.getByRole('link', { name: lastName }).first().click();

    const movePanel = page.getByTestId('bed-move-panel');
    await expect(movePanel).toBeVisible();

    await movePanel.getByTestId('move-kind').selectOption('permanent');
    await movePanel
      .getByTestId('move-bed')
      .selectOption({ label: `${second.room}, ${second.bed} — ${String(RENT)}` });
    await movePanel.getByTestId('move-reason').fill('Переселение по просьбе жильца');
    await movePanel.getByTestId('move-submit').click();

    await expect(movePanel.getByTestId('bed-move-error')).toHaveCount(0);

    /*
     * Доказательство переселения — не надпись, а последствие: занятое место
     * уходит из списка свободных. Надпись могла бы остаться и от прежнего
     * состояния экрана.
     */
    await page.reload();
    await expect(page.getByTestId('move-bed')).not.toContainText(second.bed);

    /* 9. Нарушение: событие рейтинга с причиной. */
    await page.goto('/rating');
    await visible(page, 'house-rating').getByRole('link', { name: lastName }).first().click();

    await page.getByTestId('event-type').selectOption('violation');
    await page.getByTestId('event-reason').fill(unique('Шум после 23:00'));
    await page.getByRole('button', { name: 'Записать' }).click();
    await expect(page.getByTestId('event-added')).toBeVisible();
  });
});
