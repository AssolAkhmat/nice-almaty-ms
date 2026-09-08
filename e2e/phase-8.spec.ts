import { expect, test } from '@playwright/test';

import { E2E_ACCOUNTS, E2E_PASSWORD } from './global-setup';
import { login } from './support/login';
import { createResident, RESIDENT_PASSWORD, signInAs, unique } from './support/onboarding';

/**
 * Приёмка фазы 8 (docs/tasks/PHASE-8.md).
 *
 * Экраны, которых не было: типы документов, план счетов и шаблон договора.
 * До фазы 8 эти сущности заводил только сид, и очистка боевой базы оставила
 * сеть без них — восстановить их через интерфейс было нечем.
 *
 * Код типа у каждой ширины свой: экран общий на всю сеть, и три копии приёмки
 * с одним кодом мешали бы друг другу — как дома в приёмках прошлых фаз.
 *
 * Проверки идут по кнопкам строки, а не по разметке таблицы: на узкой ширине
 * список рисуется карточками, и `<table>` там нет вовсе.
 */
test.describe('типы документов', () => {
  test('суперадмин заводит тип, правит срок и убирает в архив', async ({ page }, testInfo) => {
    // Код: латиница нижнего регистра и подчёркивание — он уходит в путь хранения файла.
    const code = `probe_${unique(testInfo.project.name.replace(/[^a-z0-9]/gi, '').toLowerCase()).replace(/-/g, '_')}`;

    await login(page);
    await page.goto('/settings/document-types');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    await page.getByTestId('new-type-code').fill(code);
    await page.getByTestId('new-type-name-ru').fill('Проверочный тип');
    await page.locator('#new-name-kk').fill('Тексеру түрі');
    await page.locator('#new-name-en').fill('Probe type');
    await page.locator('#new-validity').fill('6');
    await page.getByTestId('create-type-submit').click();

    await expect(page.getByText(code).filter({ visible: true }).first()).toBeVisible();

    // Правка: срок меняется, код остаётся прежним.
    await page.getByTestId(`edit-${code}`).filter({ visible: true }).first().click();
    await expect(page.locator('#edit-validity')).toHaveValue('6');
    await page.locator('#edit-validity').fill('24');
    await page.getByTestId('edit-type-submit').click();

    await page.getByTestId(`edit-${code}`).filter({ visible: true }).first().click();
    await expect(page.locator('#edit-validity')).toHaveValue('24');
    await page.keyboard.press('Escape');

    // Архив: тип остаётся в списке помеченным, а не исчезает бесследно.
    await page.getByTestId(`archive-${code}`).filter({ visible: true }).first().click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Архив|Мұрағат|Archive/i })
      .click();

    await expect(page.getByTestId(`edit-${code}`)).toHaveCount(0);
    await expect(page.getByText(code).filter({ visible: true }).first()).toBeVisible();
  });

  test('админ дома в типы документов не попадает', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/settings/document-types');

    await expect(page).toHaveURL(/\/settings$/);
  });
});

test.describe('план счетов', () => {
  test('суперадмин заводит счёт, переименовывает и убирает в архив', async ({ page }, testInfo) => {
    const code = `probe_${unique(testInfo.project.name.replace(/[^a-z0-9]/gi, '').toLowerCase()).replace(/-/g, '_')}`;

    await login(page);
    await page.goto('/settings/accounts');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    await page.getByTestId('new-account-code').fill(code);
    await page.getByTestId('new-account-name').fill('Касса проверки');
    await page.getByTestId('new-account-type').selectOption('cash');
    await page.getByTestId('create-account-submit').click();

    await expect(page.getByText(code).filter({ visible: true }).first()).toBeVisible();

    await page.getByTestId(`rename-${code}`).filter({ visible: true }).first().click();
    await page.locator('#rename-account-name').fill('Касса охраны');
    await page.getByTestId('rename-account-submit').click();

    await expect(page.getByText('Касса охраны').filter({ visible: true }).first()).toBeVisible();

    await page.getByTestId(`archive-account-${code}`).filter({ visible: true }).first().click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Архив|Мұрағат|Archive/i })
      .click();

    await expect(page.getByTestId(`rename-${code}`)).toHaveCount(0);
  });

  test('системный счёт сети в архив не убирается', async ({ page }) => {
    await login(page);
    await page.goto('/settings/accounts');

    // Депозитный фонд заведён сидом как системный: кнопки архивации у него нет.
    await expect(page.getByTestId('rename-deposit_fund').first()).toBeAttached();
    await expect(page.getByTestId('archive-account-deposit_fund')).toHaveCount(0);
  });

  test('админ дома в план счетов не попадает', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/settings/accounts');

    await expect(page).toHaveURL(/\/settings$/);
  });
});

/**
 * Шаблон договора один на всю сеть, и три ширины, правящие его одновременно,
 * мешали бы друг другу — как задание рассылки в приёмке фазы 6 (P6-42).
 * Экран, палитру и предпросмотр смотрят все три ширины: они ничего не меняют.
 * Сохранение идёт на одной.
 */
const TEMPLATE_PROJECT = 'mobile-375';

test.describe('шаблон договора', () => {
  test('суперадмин вставляет токен и смотрит предпросмотр', async ({ page }) => {
    await login(page);
    await page.goto('/settings/contract-template');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const body = page.getByTestId('template-body');

    // Токен встаёт туда, где курсор: приёмка ставит его в конец текста.
    await body.click();
    await page.keyboard.press('Control+End');
    await page.getByTestId('token-house.address').click();
    await expect(body).toHaveValue(/house[.]address/);

    await page.getByTestId('template-preview').click();
    const preview = page.getByTestId('template-preview-result');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('Алматы, ул. Абая, 1');
    await expect(preview).not.toContainText('{{');
  });

  test('неизвестный токен не сохраняется и назван по имени', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== TEMPLATE_PROJECT, 'шаблон в сети один');

    await login(page);
    await page.goto('/settings/contract-template');

    const body = page.getByTestId('template-body');
    const before = await body.inputValue();

    await body.fill(`${before}<p>{{resident.middle_name}}</p>`);
    await page.getByTestId('template-save').click();

    const error = page.getByTestId('template-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('resident.middle_name');

    // В базе шаблон остался прежним: перезагрузка возвращает старый текст.
    await page.reload();
    await expect(page.getByTestId('template-body')).toHaveValue(before);
  });

  test('админ дома к шаблону договора не подходит', async ({ page }) => {
    await login(page, E2E_ACCOUNTS.adminHouse1);
    await page.goto('/settings/contract-template');

    await expect(page).toHaveURL(/\/settings$/);
  });
});

test.describe('версии шаблона договора', () => {
  test('правка заводит следующую версию', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== TEMPLATE_PROJECT, 'шаблон в сети один');

    await login(page);
    await page.goto('/settings/contract-template');

    const version = page.getByTestId('template-version');
    const before = Number(/(\d+)/.exec((await version.innerText()).trim())?.[1] ?? '0');
    expect(before).toBeGreaterThan(0);

    const body = page.getByTestId('template-body');
    const text = await body.inputValue();

    await body.fill(`${text}<p>{{today}}</p>`);
    await page.getByTestId('template-save').click();
    await expect(page.getByRole('status')).toBeVisible();

    await page.reload();
    const after = Number(/(\d+)/.exec((await version.innerText()).trim())?.[1] ?? '0');
    expect(after).toBe(before + 1);

    // Приёмка возвращает прежний текст — но уже следующей версией: прежние остаются в истории.
    await page.getByTestId('template-body').fill(text);
    await page.getByTestId('template-save').click();
    await expect(page.getByRole('status')).toBeVisible();
  });
});

/**
 * Сквозная проверка фазы: тип, заведённый суперадмином, доходит до жильца.
 *
 * Дом у каждой ширины свой — жилец заводится в нём, как в приёмках прошлых фаз;
 * сам тип документа общий на сеть, поэтому код у каждой ширины свой.
 */
const HOUSES: Readonly<Record<string, string>> = {
  'mobile-375': 'Дом 9',
  'tablet-768': 'Дом 10',
  'desktop-1440': 'Дом 11',
};

test.describe('приёмка фазы 8', () => {
  test('заведённый тип документа виден жильцу, а счёт — с нулевым остатком', async ({
    page,
  }, testInfo) => {
    const suffix = unique(testInfo.project.name.replace(/[^a-z0-9]/gi, '').toLowerCase()).replace(
      /-/g,
      '_',
    );
    const typeCode = `probe_doc_${suffix}`;
    const accountCode = `probe_acc_${suffix}`;
    const typeName = `Справка приёмки ${suffix}`;

    await login(page);

    // 1. Тип документа: заводится в настройках сети.
    await page.goto('/settings/document-types');
    await page.getByTestId('new-type-code').fill(typeCode);
    await page.getByTestId('new-type-name-ru').fill(typeName);
    await page.locator('#new-name-kk').fill(typeName);
    await page.locator('#new-name-en').fill(typeName);
    await page.getByTestId('create-type-submit').click();
    await expect(page.getByText(typeCode).filter({ visible: true }).first()).toBeVisible();

    // 2. Счёт: заводится там же и сразу показывает нулевой остаток.
    await page.goto('/settings/accounts');
    await page.getByTestId('new-account-code').fill(accountCode);
    await page.getByTestId('new-account-name').fill(`Касса приёмки ${suffix}`);
    await page.getByTestId('new-account-type').selectOption('cash');
    await page.getByTestId('create-account-submit').click();

    const accountRow = page
      .getByRole('row', { name: new RegExp(accountCode) })
      .filter({ visible: true })
      .first();
    const accountCard = page.getByText(accountCode).filter({ visible: true }).first();
    await expect(accountCard).toBeVisible();
    if ((await accountRow.count()) > 0) {
      await expect(accountRow).toContainText('0');
    }

    // 3. Жилец видит новый тип среди своих документов.
    // Помощник сам входит суперадмином, а /login при живой сессии уводит на дэшборд:
    // перед ним сессию надо закрыть.
    await page.context().clearCookies();
    const resident = await createResident(page, HOUSES[testInfo.project.name] ?? 'Дом 1');
    await signInAs(page, resident, RESIDENT_PASSWORD);
    await page.goto('/documents');

    await expect(page.locator('main')).toContainText(typeName);

    // 4. Уборка: тип уходит в архив, чтобы не копиться на экране заселения.
    // Вход через signInAs: у жильца открыта своя сессия, и /login просто увёл бы на дэшборд.
    await signInAs(page, E2E_ACCOUNTS.superadmin, E2E_PASSWORD);
    await page.goto('/settings/document-types');
    await page.getByTestId(`archive-${typeCode}`).filter({ visible: true }).first().click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Архив|Мұрағат|Archive/i })
      .click();
    await expect(page.getByTestId(`archive-${typeCode}`)).toHaveCount(0);
  });
});
