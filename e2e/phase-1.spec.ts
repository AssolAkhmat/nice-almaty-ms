import { expect, test, type Page } from '@playwright/test';

import { E2E_ACCOUNTS, E2E_PASSWORD } from './global-setup';
import { login } from './support/login';
import { visibleTestId } from './support/visible';

/**
 * Приёмка фазы 1 (docs/07-ROADMAP.md):
 * суперадмин создаёт админа и жильца; админ не видит чужой дом;
 * каждое действие попадает в журнал.
 *
 * Проверки идут через настоящий интерфейс: обходных путей входа
 * и создания учётных записей в приложении нет.
 */
function uniquePhone(): string {
  const digits = String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0');

  return `+7708${digits}`;
}

async function createAccount(
  page: Page,
  phone: string,
  role: 'resident' | 'admin',
  // Дом обязателен обоим: у админа он в учётной записи, у жильца — в проживании.
  houseName = 'Дом 1',
): Promise<string> {
  await page.goto('/settings/users');
  await page.getByTestId('new-phone').fill(phone);
  await page.getByTestId('new-role').selectOption(role);

  await page.getByTestId('new-house').selectOption({ label: houseName });

  await page.getByTestId('create-submit').click();

  await expect(page.getByTestId('temporary-password')).toBeVisible();

  const temporaryPassword = (await page.getByTestId('temporary-password-value').innerText()).trim();

  // Двенадцать символов из алфавита без похожих начертаний.
  expect(temporaryPassword).toHaveLength(12);

  return temporaryPassword;
}

test.describe('приёмка фазы 1', () => {
  test('суперадмин создаёт жильца и админа', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.superadmin);

    const residentPhone = uniquePhone();
    await createAccount(page, residentPhone, 'resident');

    const adminPhone = uniquePhone();
    await createAccount(page, adminPhone, 'admin', 'Дом 3');

    await page.goto('/settings/users');
    const visible = await page.locator('main').innerText();

    expect(visible).toContain(residentPhone);
    expect(visible).toContain(adminPhone);
  });

  test('созданный аккаунт входит по временному паролю и обязан его сменить', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.superadmin);

    const phone = uniquePhone();
    const temporaryPassword = await createAccount(page, phone, 'resident');

    // Выходим из-под суперадмина: иначе форма входа увела бы обратно на дэшборд.
    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByTestId('phone').fill(phone);
    await page.getByTestId('password').fill(temporaryPassword);
    await page.getByTestId('submit').click();

    // До смены пароля остальные разделы закрыты.
    await expect(page).toHaveURL(/\/change-password$/);

    const newPassword = 'novy-parol-zhiltsa';
    await page.getByTestId('new-password').fill(newPassword);
    await page.getByTestId('confirmation').fill(newPassword);
    await page.getByTestId('submit').click();

    // Смена пароля отзывает все сессии, поэтому нужен новый вход.
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId('password-changed')).toBeVisible();

    await page.getByTestId('phone').fill(phone);
    await page.getByTestId('password').fill(newPassword);
    await page.getByTestId('submit').click();

    await expect(page).toHaveURL(/\/$/);
  });

  test('разрешение сброса пускает один раз и требует новый пароль', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.superadmin);

    const phone = uniquePhone();
    await createAccount(page, phone, 'resident');

    await visibleTestId(page, `allow-reset-${phone}`).click();
    await expect(page.getByTestId('reset-allowed')).toBeVisible();

    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByTestId('phone').fill(phone);
    await page.getByTestId('password').fill('sovershenno-lyuboy-parol');
    await page.getByTestId('submit').click();

    await expect(page).toHaveURL(/\/change-password$/);
  });

  test('действия попадают в журнал аудита', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.superadmin);

    const phone = uniquePhone();
    await createAccount(page, phone, 'resident');

    await page.goto('/settings/audit');
    await expect(page.getByTestId('audit-list')).toBeVisible();

    const visible = await page.locator('main').innerText();

    expect(visible).toContain('user.created');
    expect(visible).toContain(phone);
  });

  test('журнал показывает вход, а не только изменения', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.superadmin);

    await page.goto('/settings/audit');

    expect(await page.locator('main').innerText()).toContain('auth.sign_in');
  });
});

test.describe('админ не видит чужого', () => {
  test('в списке домов только свой дом', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);

    await page.goto('/settings/houses');

    /*
     * Сравнивается видимый текст: таблица и мобильные карточки существуют
     * в разметке одновременно, и поиск по элементу нашёл бы скрытую копию.
     */
    const visible = await page.locator('main').innerText();

    expect(visible).toContain('Дом 1');
    for (const name of ['Дом 2', 'Дом 3', 'Дом 4', 'Дом 5', 'Дом 6', 'Дом 7', 'Дом 8']) {
      expect(visible, name).not.toContain(name);
    }
  });

  test('настройки сети по прямой ссылке недоступны', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);

    await page.goto('/settings/network');

    // Раздел вне области видимости роли неотличим от несуществующего (P1-1).
    await expect(page).toHaveURL(/\/settings$/);
  });

  test('журнал аудита по прямой ссылке недоступен', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);

    await page.goto('/settings/audit');

    await expect(page).toHaveURL(/\/settings$/);
  });

  test('создавать учётные записи админ не может', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);

    await page.goto('/settings/users');

    await expect(page.getByTestId('create-account-form')).toHaveCount(0);
  });

  test('дом соседа не появляется и после его входа', async ({ page }) => {
    // Вход другого админа не должен ничего менять в видимости первого.
    await login(page, E2E_ACCOUNTS.adminHouse2);
    await page.goto('/settings/houses');

    const visible = await page.locator('main').innerText();

    expect(visible).toContain('Дом 2');
    expect(visible).not.toContain('Дом 1');
  });
});

test.describe('вход', () => {
  test('неверный пароль не пускает и не раскрывает существование номера', async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('phone').fill(E2E_ACCOUNTS.superadmin);
    await page.getByTestId('password').fill('nepravilny-parol');
    await page.getByTestId('submit').click();

    const withExistingPhone = await page.getByTestId('login-error').innerText();

    await page.goto('/login');
    await page.getByTestId('phone').fill('+77089999999');
    await page.getByTestId('password').fill(E2E_PASSWORD);
    await page.getByTestId('submit').click();

    const withUnknownPhone = await page.getByTestId('login-error').innerText();

    expect(withExistingPhone).toBe(withUnknownPhone);
  });

  test('защищённая зона без входа уводит на форму', async ({ page }) => {
    await page.context().clearCookies();

    await page.goto('/settings/users');

    await expect(page).toHaveURL(/\/login$/);
  });
});
