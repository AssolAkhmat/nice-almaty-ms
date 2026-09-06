# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
RUN apk add --no-cache libc6-compat && npm install -g pnpm@12.3.4
WORKDIR /app

# Зависимости ставятся отдельным слоем: меняются реже исходников.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# Полное дерево с исходниками: из него работают миграции и воркер.
FROM deps AS tooling
COPY . .

FROM tooling AS build
ENV NEXT_TELEMETRY_DISABLED=1
ENV DEPLOY_TARGET=docker
RUN pnpm build

# Рантайм приложения: только standalone-вывод, без исходников и devDependencies.
FROM base AS runner
# Печать договора идёт системным chromium: puppeteer-core своего браузера
# не приносит (docs/01-ARCHITECTURE.md). Шрифты нужны отдельно, иначе
# кириллица в PDF превращается в квадраты.
RUN apk add --no-cache chromium font-noto font-noto-extra
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV DEPLOY_TARGET=docker
ENV CHROMIUM_PATH=/usr/bin/chromium-browser
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

# Каталог для тома создаётся заранее и с нужным владельцем: свежий именованный
# том наследует права из образа, иначе процесс под nextjs не сможет в него писать.
RUN mkdir -p /app/storage && chown nextjs:nodejs /app/storage

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
