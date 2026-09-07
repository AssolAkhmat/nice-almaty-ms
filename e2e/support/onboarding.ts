import { expect, type Page } from '@playwright/test';

import { E2E_ACCOUNTS } from '../global-setup';
import { login } from './login';

/**
 * Шаги заселения, которыми пользуется больше одной приёмки.
 *
 * Приёмка фазы 2 проходит §1.2 целиком и живёт в своём файле; приёмке
 * фазы 3 нужен готовый жилец с оплаченным депозитом, а не второй экземпляр
 * тех же двадцати строк. Всё здесь идёт через интерфейс: ни одна запись
 * не создаётся мимо экранов, иначе проверялась бы фикстура, а не система.
 */
export const RESIDENT_PASSWORD = 'parol-zhiltsa-priemka';

export function unique(prefix: string): string {
  return `${prefix}-${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`;
}

/**
 * Номер из диапазона, который прогон убирает за собой (`e2e/global-setup.ts`):
 * иначе база растёт от запуска к запуску и набор начинает падать от загрузки,
 * а не от поведения системы (инцидент I3).
 */
export function uniquePhone(): string {
  return `+7707${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
}

export async function signInAs(
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
export async function createResident(page: Page, houseName: string): Promise<string> {
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

/** Фамилия и способ оплаты: по ним приёмки находят жильца и его задачи. */
export async function fillProfile(
  page: Page,
  lastName: string,
  payment: 'kaspi' | 'cash' = 'kaspi',
): Promise<void> {
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
  await page.locator('#preferredPayment').selectOption(payment);

  await page.getByTestId('profile-submit').click();
  await expect(page.getByTestId('profile-saved')).toBeVisible();
}

/** Комната и место заводятся настройкой дома — тем же экраном, что у админа. */
export async function createRoomWithBed(
  page: Page,
  price = '70000',
): Promise<{ room: string; bed: string }> {
  const room = unique('Комната приёмки');
  const bed = unique('Место приёмки');

  await page.goto('/settings/house');
  await page.locator('#new-area-name').fill(room);
  await page.locator('#new-area-order').fill('999');
  await page.getByTestId('add-area').click();

  const card = page.locator('.rounded-card').filter({ hasText: room });
  await expect(card).toBeVisible();

  await card.locator('input[name="label"]').fill(bed);
  await card.locator('input[name="defaultPrice"]').fill(price);
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
export async function assignBed(
  page: Page,
  resident: string,
  room: string,
  bed: string,
): Promise<void> {
  await page.goto('/beds');
  await page.getByRole('button', { name: 'Назначить место' }).click();

  await page.locator('#assign-resident').selectOption({ label: resident });
  await page.locator('#assign-room').selectOption({ label: room });
  await page.locator('#assign-bed').selectOption({ label: bed });
  await page.getByRole('button', { name: 'Назначить', exact: true }).click();

  await expect(page.getByText('Место назначено')).toBeVisible();
}

/**
 * Шаги 7–8 §1.2: счёт на депозит и оплата, которая и есть заселение.
 *
 * Состояние читается по значку, а не по тексту карточки: подпись «Оплачено»
 * стоит на ней всегда, и проверка вхождением проходила бы, даже если счёт
 * не оплачен вовсе.
 */
export async function payDeposit(page: Page, residentName: string): Promise<void> {
  await page.goto('/deposit');

  const card = page.getByTestId('deposit-card').filter({ hasText: residentName });
  await card.getByRole('button', { name: 'Выставить счёт' }).click();
  await expect(card.getByText('Выставлен', { exact: true })).toBeVisible();

  await card.getByTestId('payment-amount').fill('45000');
  await card.getByRole('button', { name: 'Отметить оплату' }).click();
  await expect(card.getByText('Оплачен', { exact: true })).toBeVisible();
}
