import { expect, test, type Page } from '@playwright/test';

import { E2E_ACCOUNTS, E2E_PASSWORD } from './global-setup';
import { login } from './support/login';
import {
  createResident,
  fillProfile,
  RESIDENT_PASSWORD,
  signInAs,
  unique,
} from './support/onboarding';

/**
 * Приёмка фазы 12 — дополнительные поля профиля.
 *
 * Суперадмин объявляет поле, оно появляется в профиле жильца и в палитре
 * шаблона договора, заполняется, а после архивации остаётся читаемым.
 *
 * Обязательность здесь не проверяется намеренно: объявление живёт в сети,
 * одно на всех, и обязательное поле не дало бы заполнить профиль жильцам
 * всех остальных приёмок, идущих рядом. Что обязательность проверяется
 * на сервере, а не только в браузере, держат интеграционные фикстуры
 * `src/services/profile-fields.db-test.ts`; что она закрывает шаг мастера
 * заселения — `src/services/onboarding.db-test.ts`. Что значение попадает
 * в собранный договор — `src/services/contracts.db-test.ts`: PDF в приёмке
 * не прочитать.
 *
 * Код поля у каждой ширины свой: объявление живёт в сети, одно на всех,
 * и три копии приёмки мешали бы друг другу — как дом в фазе 3.
 */
const CODE_BY_PROJECT: Readonly<Record<string, string>> = {
  'mobile-375': 'priemka_mobile',
  'tablet-768': 'priemka_tablet',
  'desktop-1440': 'priemka_desktop',
};

function codeFor(projectName: string): string {
  const code = CODE_BY_PROJECT[projectName];

  if (code === undefined) {
    throw new Error(`Код поля приёмки не задан для ширины ${projectName}`);
  }

  return code;
}

/** Объявить поле; если оно осталось с прошлого прогона — вернуть из архива. */
async function declareField(page: Page, code: string): Promise<void> {
  await page.goto('/settings/profile-fields');

  const restore = page.getByTestId(`restore-${code}`);

  if ((await restore.count()) > 0) {
    await restore.click();
    await page.goto('/settings/profile-fields');
  }

  const edit = page.getByTestId(`edit-${code}`);

  if ((await edit.count()) > 0) {
    return;
  }

  await page.getByTestId('new-field-code').fill(code);
  await page.getByTestId('new-field-name-ru').fill('Кафедра приёмки');
  await page.locator('input[name="nameKk"]').fill('Кафедра');
  await page.locator('input[name="nameEn"]').fill('Department');

  await page.getByTestId('create-field-submit').click();

  await expect(page.getByTestId(`edit-${code}`)).toBeVisible();
}

test.describe('приёмка фазы 12', () => {
  /*
   * Сценарий длинный: объявление поля, заведение жильца со сменой пароля,
   * заполнение профиля, архивация и возврат. Девяноста секунд не хватало —
   * как и приёмкам фаз 3 и 4, идущим тем же путём.
   */
  test.setTimeout(240_000);

  test('объявленное поле заполняется в профиле, а после архивации остаётся читаемым', async ({
    page,
  }, testInfo) => {
    const code = codeFor(testInfo.project.name);

    await login(page, E2E_ACCOUNTS.superadmin);
    await declareField(page, code);

    /* Токен поля виден на экране шаблона: его и вставляют в договор. */
    await page.goto('/settings/contract-template');
    await expect(page.locator('main')).toContainText(`profile.${code}`);

    const phone = await createResident(page, 'Дом 1');
    const lastName = unique('Полев');

    await signInAs(page, phone, RESIDENT_PASSWORD);
    await fillProfile(page, lastName);

    await page.getByTestId(`declared-${code}`).fill('Механика');
    await page.getByTestId('profile-submit').click();
    await expect(page.getByTestId('profile-saved')).toBeVisible();

    /* Архивация: поле исчезает из формы, а значение остаётся на экране. */
    await signInAs(page, E2E_ACCOUNTS.superadmin, E2E_PASSWORD);
    await page.goto('/settings/profile-fields');
    await page.getByTestId(`archive-${code}`).click();
    await page.getByTestId('archive-field-submit').click();
    await expect(page.getByTestId(`restore-${code}`)).toBeVisible();

    await signInAs(page, phone, RESIDENT_PASSWORD);
    await page.goto('/profile');

    const archived = page.getByTestId(`declared-${code}`);
    await expect(archived).toContainText('Механика');
    /* Архивированное поле показано текстом, а не полем ввода. */
    expect(await archived.evaluate((node) => node.tagName)).toBe('SPAN');

    /*
     * Поле остаётся в архиве: код занят навсегда, и следующий прогон вернёт
     * его из архива тем же кодом — ровно так, как это делает человек.
     */
  });
});
