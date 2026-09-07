import { expect, test, type Page } from '@playwright/test';

import { E2E_ACCOUNTS, E2E_PASSWORD } from './global-setup';
import { login } from './support/login';

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
const RESIDENT_PASSWORD = 'parol-zhiltsa-priemka';

/** Прозрачный PNG 1×1: содержимое документа для проверки роли не важно. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function unique(prefix: string): string {
  return `${prefix}-${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`;
}

function uniquePhone(): string {
  return `+7707${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
}

async function signInAs(
  page: Page,
  phone: string,
  password: string,
  options: { temporary?: boolean } = {},
): Promise<void> {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByTestId('phone').fill(phone);
  await page.getByTestId('password').fill(password);
  await page.getByTestId('submit').click();

  // С временным паролем открыт только экран смены: там нет ни меню, ни модулей.
  if (options.temporary === true) {
    await expect(page).toHaveURL(/\/change-password$/);
    return;
  }

  await expect(page.getByTestId('sidebar')).toBeAttached();
}

/** Шаг 1–2 §1.2: суперадмин заводит аккаунт, жилец меняет временный пароль. */
async function createResident(page: Page, houseName: string): Promise<string> {
  const phone = uniquePhone();

  await login(page, E2E_ACCOUNTS.superadmin);
  await page.goto('/settings/users');
  await page.getByTestId('new-phone').fill(phone);
  await page.getByTestId('new-role').selectOption('resident');
  await page.getByTestId('new-house').selectOption({ label: houseName });
  await page.getByTestId('create-submit').click();

  await expect(page.getByTestId('temporary-password')).toBeVisible();
  const temporary = (await page.getByTestId('temporary-password-value').innerText()).trim();

  await signInAs(page, phone, temporary, { temporary: true });

  await page.getByTestId('new-password').fill(RESIDENT_PASSWORD);
  await page.getByTestId('confirmation').fill(RESIDENT_PASSWORD);
  await page.getByTestId('submit').click();
  await expect(page).toHaveURL(/\/login/);

  return phone;
}

/** Шаг 3 §1.2: профиль заполняет сам жилец; комнату и цену он не трогает. */
async function fillProfile(page: Page, lastName: string): Promise<void> {
  await page.goto('/profile');

  await page.locator('#lastName').fill(lastName);
  await page.locator('#firstName').fill('Тест');
  await page.locator('#sex').selectOption('male');
  await page.locator('#birthDate').fill('2005-05-05');
  await page.locator('#phone').fill('+77010000001');
  await page.locator('#iin').fill('050505500505');
  await page.locator('#idDocNumber').fill('N01234567');
  await page.locator('#university').fill('КазНУ');
  await page.locator('#course').fill('2');
  await page.locator('#major').fill('Информатика');
  await page.locator('#emergencyName').fill('Тестова Мать');
  await page.locator('#emergencyPhone').fill('+77010000002');
  await page.locator('#preferredPayment').selectOption('kaspi');

  await page.getByTestId('profile-submit').click();
  await expect(page.getByTestId('profile-saved')).toBeVisible();
}

/** Комната и место заводятся настройкой дома — тем же экраном, что у админа. */
async function createRoomWithBed(page: Page): Promise<{ room: string; bed: string }> {
  const room = unique('Комната приёмки');
  const bed = unique('Место приёмки');

  await page.goto('/settings/house');
  await page.locator('#new-area-name').fill(room);
  await page.locator('#new-area-order').fill('999');
  await page.getByTestId('add-area').click();

  const card = page.locator('.rounded-card').filter({ hasText: room });
  await expect(card).toBeVisible();

  await card.locator('input[name="label"]').fill(bed);
  await card.locator('input[name="defaultPrice"]').fill('70000');
  await card.getByTestId('add-bed').click();
  await expect(page.locator('li').filter({ hasText: bed })).toBeVisible();

  return { room, bed };
}

/**
 * Шаг 4 §1.2: место и цену назначает админ.
 *
 * Жилец, комната и место выбираются поимённо: на одном доме одновременно
 * идут три прогона — по одному на ширину, — и «первая строка списка»
 * означала бы чужого жильца.
 */
async function assignBed(page: Page, resident: string, room: string, bed: string): Promise<void> {
  await page.goto('/beds');
  await page.getByRole('button', { name: 'Назначить место' }).click();

  await page.locator('#assign-resident').selectOption({ label: resident });
  await page.locator('#assign-room').selectOption({ label: room });
  await page.locator('#assign-bed').selectOption({ label: bed });
  await page.getByRole('button', { name: 'Назначить', exact: true }).click();

  await expect(page.getByText('Место назначено')).toBeVisible();
}

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

/** Шаги 7–8 §1.2: счёт на депозит и оплата, которая и есть заселение. */
async function payDeposit(page: Page, residentName: string): Promise<void> {
  await page.goto('/deposit');

  const card = page.getByTestId('deposit-card').filter({ hasText: residentName });
  await card.getByRole('button', { name: 'Выставить счёт' }).click();
  await expect(card).toContainText('Выставлен');

  await card.getByTestId('payment-amount').fill('45000');
  await card.getByRole('button', { name: 'Отметить оплату' }).click();
  await expect(card).toContainText('Оплачен');
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
