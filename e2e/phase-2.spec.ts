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
/** Прозрачный PNG 1×1: содержимое документа для проверки роли не важно. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Шаг 5 §1.2: договор собирает админ, подписывает жилец — и только он.
 *
 * Ожидание здесь длиннее общего: сборка договора поднимает chromium
 * и печатает PDF (P2-46), а в полном прогоне это делают три копии сразу
 * на той же машине, где идут ещё девять наборов. Пятнадцати секунд шагу
 * иногда не хватает, и падение говорит о загрузке машины, а не о системе.
 */
const CONTRACT_BUILD_TIMEOUT = 60_000;

async function buildContract(page: Page, resident: string): Promise<void> {
  await page.goto('/contract');

  const row = page.getByTestId('contract-row').filter({ hasText: resident });
  await row.getByRole('button', { name: 'Собрать договор' }).click();

  await expect(row).toContainText('Открыть договор', { timeout: CONTRACT_BUILD_TIMEOUT });
}

async function signContract(page: Page): Promise<void> {
  await page.goto('/contract');

  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error('Поле подписи не отрисовано');
  }

  // Подпись рисуется указателем: и мышь, и палец приходят одними событиями.
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3, { steps: 8 });
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.7, { steps: 8 });
  await page.mouse.up();

  await page.getByRole('button', { name: 'Сохранить подпись' }).click();
  await page.getByTestId('sign-submit').click();

  await expect(page.locator('main')).toContainText('Договор подписан');
}

/** Шаг 6 §1.2: жилец загружает документы, админ проверяет каждый. */
async function uploadDocuments(page: Page): Promise<void> {
  await page.goto('/documents');

  const cards = ['Фото 3×4', 'Справка ПНД/нарко/пневмо', 'Флюорография'];

  for (const name of cards) {
    const card = page.locator('.rounded-card').filter({ hasText: name });

    await card.locator('input[type="file"]').setInputFiles({
      name: 'document.png',
      mimeType: 'image/png',
      buffer: PNG_1X1,
    });

    const issueDate = card.locator('input[type="date"]');
    if ((await issueDate.count()) > 0) {
      // Флюорография действует год от даты снимка, а не от дня загрузки (§1.3).
      await issueDate.fill('2026-08-01');
    }

    await card.getByRole('button', { name: 'Отправить' }).click();
    await expect(card).toContainText('На проверке');
  }
}

async function approveDocuments(page: Page, resident: string): Promise<void> {
  await page.goto('/documents');

  const items = page.getByTestId('review-item').filter({ hasText: resident });

  for (let left = 3; left > 0; left -= 1) {
    await items.first().getByRole('button', { name: 'Принять' }).click();
    await expect(items).toHaveCount(left - 1);
  }
}

test.describe('приёмка фазы 2', () => {
  test('полный цикл заселения и обратный путь до счёта возврата', async ({ page }) => {
    test.setTimeout(180_000);

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

    await signInAs(page, E2E_ACCOUNTS.adminHouse1, E2E_PASSWORD);
    await approveDocuments(page, lastName);
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
