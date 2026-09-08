import createNextIntlPlugin from 'next-intl/plugin';

import type { NextConfig } from 'next';

/**
 * DEPLOY_TARGET — единственное место, где код знает о разнице окружений
 * (docs/01-ARCHITECTURE.md). Для Docker нужна standalone-сборка,
 * для Vercel — обычная, её собирает платформа.
 */
const isDockerTarget = process.env.DEPLOY_TARGET === 'docker';

/**
 * Печать договора на Vercel идёт сборкой `@sparticuz/chromium` (P9-2).
 * Пакет объявлен внешним: он читает свой архив с диска относительно
 * собственного файла, и в бандле ему делать нечего.
 *
 * Архивы браузера в `bin/` трассировка не видит — пакет открывает их
 * по пути, собранному в рантайме, — поэтому для Vercel они включаются
 * в функцию явно: без них `executablePath()` падает на первом же договоре.
 * В standalone-вывод для Docker пакет не трассируется вовсе: там печатает
 * системный chromium, а шестьдесят мегабайт архива в образе были бы мёртвым грузом.
 */
const SERVERLESS_CHROMIUM = '@sparticuz/chromium';

const nextConfig: NextConfig = {
  output: isDockerTarget ? 'standalone' : undefined,
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  serverExternalPackages: [SERVERLESS_CHROMIUM, 'puppeteer-core'],
  ...(isDockerTarget
    ? { outputFileTracingExcludes: { '*': [`./node_modules/${SERVERLESS_CHROMIUM}/**`] } }
    : { outputFileTracingIncludes: { '*': [`./node_modules/${SERVERLESS_CHROMIUM}/bin/**`] } }),
};

const withNextIntl = createNextIntlPlugin('./src/lib/i18n/request.ts');

export default withNextIntl(nextConfig);
