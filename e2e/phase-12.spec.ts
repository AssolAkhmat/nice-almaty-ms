import { expect, test, type Page } from '@playwright/test';

import { E2E_ACCOUNTS } from './global-setup';
import { login } from './support/login';

/**
 * Приёмка фазы 12 — дополнительные поля профиля.
 *
 * Суперадмин объявляет поле, оно появляется в его собственном профиле и в
 * палитре шаблона договора, заполняется, а после архивации остаётся читаемым.
 *
 * Профиль берётся свой, а не нового жильца: форма профиля одна на всех,
 * а заведение жильца со сменой пароля — четыре минуты чужой работы, из-за
 * которых сценарий не укладывался в бюджет и падал по таймауту, ничего
 * не проверив. Путь жильца через ту же форму держат приёмки фаз 2 и 3.
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

  /*
   * Таблица рисует строку дважды: карточками для телефона и таблицей для
   * широкого экрана. Видимая на этой ширине одна, поэтому берётся первая
   * из найденных — иначе строгий режим отказывает на двух совпадениях.
   */
  const restore = page.getByTestId(`restore-${code}`).first();

  if ((await restore.count()) > 0) {
    await restore.click();
    await page.goto('/settings/profile-fields');
  }

  const edit = page.getByTestId(`edit-${code}`).first();

  if ((await edit.count()) > 0) {
    return;
  }

  await page.getByTestId('new-field-code').fill(code);
  await page.getByTestId('new-field-name-ru').fill('Кафедра приёмки');
  await page.locator('input[name="nameKk"]').fill('Кафедра');
  await page.locator('input[name="nameEn"]').fill('Department');

  await page.getByTestId('create-field-submit').click();

  await expect(page.getByTestId(`edit-${code}`).first()).toBeVisible();
}

test.describe('приёмка фазы 12', () => {
  test.slow();

  test('объявленное поле заполняется в профиле, а после архивации остаётся читаемым', async ({
    page,
  }, testInfo) => {
    const code = codeFor(testInfo.project.name);

    await login(page, E2E_ACCOUNTS.superadmin);
    await declareField(page, code);

    /* Токен поля виден на экране шаблона: его и вставляют в договор. */
    await page.goto('/settings/contract-template');
    await expect(page.locator('main')).toContainText(`profile.${code}`);

    /* Поле появилось в форме профиля и заполняется ею же. */
    await page.goto('/profile');
    await page.getByTestId(`declared-${code}`).fill('Механика');
    await page.getByTestId('profile-submit').click();
    await expect(page.getByTestId('profile-saved')).toBeVisible();

    /* Архивация: поле уходит из формы, а значение остаётся на экране. */
    await page.goto('/settings/profile-fields');
    await page.getByTestId(`archive-${code}`).first().click();
    await page.getByTestId('archive-field-submit').click();
    await expect(page.getByTestId(`restore-${code}`).first()).toBeVisible();

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
