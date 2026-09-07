import { expect, test } from '@playwright/test';

import { E2E_ACCOUNTS, E2E_PASSWORD } from './global-setup';
import { signInAs, unique } from './support/onboarding';

/**
 * Приёмка фазы 7 (docs/07-ROADMAP.md).
 *
 * Три критерия: документация открывается, бот-токен читает свободные места
 * и не видит финансы, развёртывание с нуля доходит до работающей системы.
 *
 * Дом у каждой ширины свой — тот же, что в приёмке фазы 6: токен выдаётся
 * на него, и три копии приёмки не мешают друг другу.
 */
const HOUSES: Readonly<Record<string, { name: string; admin: string }>> = {
  'mobile-375': { name: 'Дом 9', admin: E2E_ACCOUNTS.adminHouse9 },
  'tablet-768': { name: 'Дом 10', admin: E2E_ACCOUNTS.adminHouse10 },
  'desktop-1440': { name: 'Дом 11', admin: E2E_ACCOUNTS.adminHouse11 },
};

test.describe('приёмка фазы 7', () => {
  test('документация открывается и описывает маршруты', async ({ page, request }) => {
    await page.goto('/api/docs');

    await expect(page.locator('body')).toContainText('Nice Almaty API');
    await expect(page.locator('body')).toContainText('/api/v1/houses');

    const spec = await request.get('/api/v1/openapi.json');
    expect(spec.status()).toBe(200);

    const document = (await spec.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths)).toContain('/houses/{id}/beds');
  });

  test('бот-токен читает свободные места и не видит финансы', async ({
    page,
    request,
  }, testInfo) => {
    const house = HOUSES[testInfo.project.name];

    if (house === undefined) {
      throw new Error(`Нет дома приёмки для ширины ${testInfo.project.name}`);
    }

    // Токен выдаётся через интерфейс: обходных путей у приёмки нет.
    await signInAs(page, E2E_ACCOUNTS.superadmin, E2E_PASSWORD);
    await page.goto('/settings/api-tokens');

    await page.getByTestId('token-name').fill(unique('Бот приёмки'));
    await page.getByTestId('scope-beds:read').check();
    await page.getByTestId('scope-houses:read').check();
    await page.getByTestId('token-issue').click();

    const value = await page.getByTestId('token-value').innerText();
    expect(value.startsWith('nak_')).toBe(true);

    const headers = { authorization: `Bearer ${value}` };

    // Дома читаются: скоуп выдан.
    const houses = await request.get('/api/v1/houses', { headers });
    expect(houses.status()).toBe(200);

    const list = (await houses.json()) as { data: { id: string; name: string }[] };
    const target = list.data.find((item) => item.name === house.name);
    expect(target).toBeDefined();

    // Свободные места видно: ради этого бот и заводится.
    const beds = await request.get(`/api/v1/houses/${target?.id ?? ''}/beds`, { headers });
    expect(beds.status()).toBe(200);

    const occupancy = (await beds.json()) as { data: { occupied: boolean }[] };
    expect(Array.isArray(occupancy.data)).toBe(true);

    // Финансы закрыты: скоупа на счета у токена нет.
    const invoices = await request.get('/api/v1/invoices', { headers });
    expect(invoices.status()).toBe(403);

    const error = (await invoices.json()) as { error: { code: string } };
    expect(error.error.code).toBe('forbidden');
  });

  test('отозванный токен перестаёт пускать сразу', async ({ page, request }) => {
    await signInAs(page, E2E_ACCOUNTS.superadmin, E2E_PASSWORD);
    await page.goto('/settings/api-tokens');

    const name = unique('Бот на отзыв');
    await page.getByTestId('token-name').fill(name);
    await page.getByTestId('scope-houses:read').check();
    await page.getByTestId('token-issue').click();

    const value = await page.getByTestId('token-value').innerText();
    const headers = { authorization: `Bearer ${value}` };

    expect((await request.get('/api/v1/houses', { headers })).status()).toBe(200);

    await page.reload();
    const row = page.getByTestId('tokens-list').locator('li').filter({ hasText: name });
    await row.getByRole('button', { name: 'Отозвать' }).click();

    await expect(page.getByTestId('tokens-list')).not.toContainText(name);
    expect((await request.get('/api/v1/houses', { headers })).status()).toBe(401);
  });

  test('система поднята: сеть, дома и учётные записи на месте', async ({ page }) => {
    /*
     * Приёмка развёртывания: прогон начинается с чистого применения миграций
     * и сида в `global-setup`, и если бы схема отстала, приложение сказало бы
     * об этом на первом же экране вместо половины работающих запросов.
     */
    await signInAs(page, E2E_ACCOUNTS.superadmin, E2E_PASSWORD);

    await page.goto('/settings/houses');
    await expect(page.locator('main')).toContainText('Дом 1');
    await expect(page.locator('main')).toContainText('Дом 11');

    /*
     * Список пользователей проверять по первой странице бессмысленно:
     * он пагинируется и показывает новых сверху (инцидент I3), а прогон
     * заводит их десятками. Права суперадмина видны по разделу, который
     * открыт только ему.
     */
    await page.goto('/settings/api-tokens');
    await expect(page.locator('main')).toContainText('Токены API');
  });
});
