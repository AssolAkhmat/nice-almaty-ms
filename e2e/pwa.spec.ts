import { expect, test } from '@playwright/test';

import { login } from './support/login';

/**
 * Установка на телефон (T6.6, приёмка фазы 6).
 *
 * Проверяется то, без чего браузер не предложит установку: манифест
 * с иконками и standalone-режимом, живой service worker и страница
 * на случай обрыва связи.
 */
interface ManifestIcon {
  src: string;
  sizes: string;
  purpose?: string;
}

test.describe('установка на телефон', () => {
  test('манифест отдаётся и описывает установимое приложение', async ({ request }) => {
    const response = await request.get('/manifest.webmanifest');

    expect(response.status()).toBe(200);

    const manifest = (await response.json()) as {
      name: string;
      start_url: string;
      display: string;
      icons: ManifestIcon[];
    };

    expect(manifest.name).not.toBe('');
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');

    const sizes = manifest.icons.map((icon) => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');

    // Без maskable-иконки Android рисует значок в белом кружке.
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
  });

  test('иконки существуют и отдаются картинками', async ({ request }) => {
    for (const size of [192, 512]) {
      const response = await request.get(`/icons/icon-${size}.png`);

      expect(response.status(), `icon-${size}`).toBe(200);
      expect(response.headers()['content-type'], `icon-${size}`).toContain('image/png');
    }
  });

  test('страница на случай обрыва связи говорит на трёх языках', async ({ page }) => {
    await page.goto('/offline.html');

    await expect(page.locator('body')).toContainText('Нет соединения');
    await expect(page.locator('body')).toContainText('Байланыс жоқ');
    await expect(page.locator('body')).toContainText('No connection');
  });

  test('service worker регистрируется и умеет принимать push', async ({ page, request }) => {
    const script = await request.get('/sw.js');

    expect(script.status()).toBe(200);

    const source = await script.text();
    expect(source).toContain("addEventListener('push'");
    expect(source).toContain("addEventListener('notificationclick'");

    await login(page);

    const registered = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();

      return registration !== undefined;
    });

    expect(registered).toBe(true);
  });
});
