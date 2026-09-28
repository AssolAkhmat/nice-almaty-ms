import { expect, test } from '@playwright/test';

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

/**
 * Приёмка фазы 2 (docs/07-ROADMAP.md).
 *
 * Полный цикл идёт через интерфейс от начала до конца: аккаунт, профиль,
 * место, договор с подписью, документы, депозит — и обратно, до счёта
 * возврата. Обходных путей нет: ни одна запись не создаётся мимо экранов,
 * иначе проверялась бы не система, а фикстура.
 *
 * Три полных месяца в браузере не прожить, поэтому здесь проверяется
 * сгорание депозита (§2.2, меньше трёх месяцев). Ветка возврата — числами
 * в `src/domain/deposit.test.ts` и на живой базе в
 * `src/services/terminations.db-test.ts`.
 */
test.describe('приёмка фазы 2', () => {
  test('полный цикл заселения и обратный путь до счёта возврата', async ({ page }) => {
    /*
     * Бюджет как у приёмки фазы 3: путь тот же и так же печатает PDF,
     * а три ширины делают это на одной машине. Пока приёмка падала на шаге
     * с договором, до конца она и не доходила — и трёх минут «хватало»
     * только потому, что половина сценария не выполнялась.
     */
    test.setTimeout(420_000);

    const phone = await createResident(page, 'Дом 1');
    // Фамилия уникальна: база между прогонами общая, и однофамильцы
    // превратили бы поиск карточки в лотерею.
    const lastName = unique('Тестов');

    await signInAs(page, phone, RESIDENT_PASSWORD);
    // Пока депозит не оплачен, закрытые модули не открываются и по ссылке (§1.2).
    await page.goto('/rotations');
    await expect(page).toHaveURL(/\/$/);
    await fillProfile(page, lastName);

    await signInAs(page, E2E_ACCOUNTS.adminHouse1, E2E_PASSWORD);
    const { room, bed } = await createRoomWithBed(page);
    await assignBed(page, `${lastName} Тест`, room, bed);
    await buildContract(page, lastName);

    await signInAs(page, phone, RESIDENT_PASSWORD);
    await signContract(page);
    await uploadDocuments(page);

    /*
     * Документы проверяет суперадмин: доступ админа к документам сеть
     * по умолчанию не включает (D28), и очередь у него пуста — экран
     * объясняет это вместо отказа. Приёмка ждала кнопку «Принять»
     * в пустой очереди и висела до таймаута, а не проверяла систему.
     * Что админ с включённым полномочием очередь видит — держат
     * `documents.spec.ts` и интеграционные фикстуры доступа к файлам.
     */
    await signInAs(page, E2E_ACCOUNTS.superadmin, E2E_PASSWORD);
    await approveDocuments(page, lastName);

    await signInAs(page, E2E_ACCOUNTS.adminHouse1, E2E_PASSWORD);
    await payDeposit(page, lastName);

    // Шаг 8 закрыт: жилец заселён, и закрытые модули открылись.
    await signInAs(page, phone, RESIDENT_PASSWORD);
    await page.goto('/rotations');
    await expect(page).toHaveURL(/\/rotations$/);

    await page.goto('/');
    await expect(page.getByTestId('onboarding-wizard')).toHaveCount(0);

    // Обратный путь: расторжение — счёт возврата — архив.
    await signInAs(page, E2E_ACCOUNTS.adminHouse1, E2E_PASSWORD);
    await page.goto('/residents');
    await page
      .getByRole('link', { name: `${lastName} Тест` })
      .first()
      .click();

    await page.getByTestId('terminate-open').click();
    await page.locator('#reason').fill('Приёмка фазы 2');
    await page.getByTestId('terminate-confirm').click();

    const panel = page.getByTestId('termination-panel');
    await expect(panel).toBeVisible();
    // Тридцать дней от даты расторжения — крайний срок возврата (§2.3 п.4).
    await expect(page.getByTestId('termination-days-left')).toContainText('30');
    // Заезд и выезд в один день: полных месяцев нет, депозит сгорает (§2.2).
    await expect(page.getByTestId('termination-outcome')).toContainText('Сгорание');

    await page.getByTestId('create-refund').click();
    await expect(panel).toContainText('Сожжён');

    await page.getByTestId('archive-residency').click();
    await expect(page.locator('main')).toContainText('В архиве');

    // Жильцу остались только профиль и депозит: остальное закрыто (§2.3 п.2).
    await signInAs(page, phone, RESIDENT_PASSWORD);
    await page.goto('/rotations');
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/deposit');
    await expect(page).toHaveURL(/\/deposit$/);
  });
});
