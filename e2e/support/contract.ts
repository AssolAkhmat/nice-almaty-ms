import { expect, type Page } from '@playwright/test';

/**
 * Шаги договора и документов, которыми пользуется больше одной приёмки.
 *
 * Раньше они жили внутри приёмки фазы 2, а сквозной приёмке «рабочий день
 * админа» (27 сентября 2026) понадобились те же двадцать строк. Второй
 * экземпляр разошёлся бы с первым: селекторы этих шагов уже дважды менялись
 * вслед за экранами. Всё идёт через интерфейс — ни одна запись не создаётся
 * мимо экранов.
 */

/** Прозрачный PNG 1×1: содержимое документа для проверки роли не важно. */
export const PNG_1X1 = Buffer.from(
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

export async function buildContract(page: Page, resident: string): Promise<void> {
  await page.goto('/contract');

  const row = page.getByTestId('contract-row').filter({ hasText: resident });
  await row.getByRole('button', { name: 'Собрать договор' }).click();

  /*
   * Сборка подтверждается тем, что кнопка стала «Собрать заново»: файл есть.
   * Ссылки «Открыть договор» у админа нет и не должно быть — чтение готового
   * договора сеть админу по умолчанию не включает (D28), а сборка остаётся
   * шагом заселения. Раньше здесь ждали именно ссылку, и приёмка ловила
   * не поломку, а собственное устаревшее ожидание.
   */
  await expect(row).toContainText('Собрать заново', { timeout: CONTRACT_BUILD_TIMEOUT });
}

export async function signContract(page: Page): Promise<void> {
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

  /*
   * Ждём исчезновения самой формы, а не текста рядом с ней: подпись уходит
   * файлом, и на загруженной машине шаг не укладывается в общее ожидание.
   * Форма пропадает ровно тогда, когда подпись сохранена.
   */
  await expect(page.getByTestId('sign-submit')).toHaveCount(0, { timeout: 45_000 });
  await expect(page.locator('main')).toContainText('Договор подписан');
}

/** Шаг 6 §1.2: жилец загружает документы, админ проверяет каждый. */
export async function uploadDocuments(page: Page): Promise<void> {
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

export async function approveDocuments(page: Page, resident: string): Promise<void> {
  await page.goto('/documents');

  const items = page.getByTestId('review-item').filter({ hasText: resident });

  for (let left = 3; left > 0; left -= 1) {
    await items.first().getByRole('button', { name: 'Принять' }).click();
    await expect(items).toHaveCount(left - 1);
  }
}
