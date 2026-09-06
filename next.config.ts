import type { NextConfig } from 'next';

/**
 * DEPLOY_TARGET — единственное место, где код знает о разнице окружений
 * (docs/01-ARCHITECTURE.md). Для Docker нужна standalone-сборка,
 * для Vercel — обычная, её собирает платформа.
 */
const isDockerTarget = process.env.DEPLOY_TARGET === 'docker';

const nextConfig: NextConfig = {
  output: isDockerTarget ? 'standalone' : undefined,
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
};

export default nextConfig;
