# Nice Almaty — система администрирования студенческими домами

Мультитенантная (по домам) веб-система: заселение/выселение, места и оплата,
ротации (дежурства) и их оценка, присутствие, коммунальные услуги, ущерб,
рейтинг жильцов, бухгалтерия двойной записи, инвентарь, уведомления.

## Стек

| Слой | Решение |
|---|---|
| Framework | Next.js 16 (App Router, TypeScript strict, Turbopack) |
| UI | Tailwind CSS v4 (CSS-first `@theme`), Montserrat |
| БД | PostgreSQL 16 |
| ORM | Drizzle ORM + drizzle-kit (SQL-миграции) |
| Валидация | Zod (единые схемы для форм, server actions и REST) |
| Тесты | Vitest (unit), Playwright (e2e) |
| i18n | next-intl, локали `ru` (default), `kk`, `en` |
| Хранилище файлов | Google Drive (OAuth), локальный диск (dev), Supabase Storage (задел) |

## Два целевых окружения

Код обязан работать в обоих без изменений, переключение — через `.env`:

1. **VPS + Docker Compose** (основное для разработки и первичного прода):
   `app` + `postgres:16` + `worker` (cron) + `minio`/локальный диск.
2. **Vercel + Supabase** (задел): serverless-функции, Supabase Postgres через
   pooler, Vercel Cron, Supabase Storage.

Всё, что различается между окружениями, спрятано за адаптерами:
`DatabaseClient`, `StorageProvider`, `AuthProvider`, `Scheduler`, `PdfRenderer`.
См. `docs/01-ARCHITECTURE.md`.

## Документация

| Файл | Содержание |
|---|---|
| `CLAUDE.md` | Правила работы агента. Читать первым. |
| `docs/00-PRD.md` | Цели, роли, глоссарий |
| `docs/01-ARCHITECTURE.md` | Слои, адаптеры, окружения, cron, безопасность |
| `docs/02-DATA-MODEL.md` | Все таблицы, поля, инварианты |
| `docs/03-BUSINESS-RULES.md` | **Все формулы и числовые примеры. Источник тест-кейсов.** |
| `docs/04-MODULES/*.md` | ТЗ по каждому из 11 модулей |
| `docs/05-DESIGN-SYSTEM.md` | Токены, темы, компоненты, правила контраста |
| `docs/06-API.md` | Контракт REST `/api/v1`, OpenAPI, токены ботов |
| `docs/07-ROADMAP.md` | Фазы и критерии приёмки |
| `docs/08-DECISIONS.md` | Принятые решения, допущения, открытые вопросы |

## Быстрый старт

Нужны Node 24, pnpm 12 и Docker.

```bash
cp .env.example .env
# заполните SESSION_SECRET, FIELD_ENCRYPTION_KEY и CRON_SECRET
# ключ шифрования: openssl rand -base64 32

docker compose up -d          # postgres + миграции + приложение + worker
curl http://localhost:3000/api/health
```

Приложение поднимается на `http://localhost:3000`, порт меняется переменной `APP_PORT`.
Сервис `migrate` отрабатывает один раз и завершается — приложение стартует только после него.

### Разработка без Docker

```bash
pnpm install
docker compose up -d postgres
pnpm db:migrate
pnpm dev
```

## Команды

| Команда | Что делает |
|---|---|
| `pnpm dev` | режим разработки (Turbopack) |
| `pnpm build` | production-сборка; при `DEPLOY_TARGET=docker` — standalone |
| `pnpm verify` | `typecheck` + `lint` + `format:check` + `test` |
| `pnpm test` | юнит-тесты (Vitest) |
| `pnpm test:e2e` | e2e (Playwright) на ширинах 375 / 768 / 1440 |
| `pnpm db:generate` | сгенерировать миграцию из схемы Drizzle |
| `pnpm db:migrate` | применить миграции |
| `pnpm db:studio` | Drizzle Studio |
| `pnpm db:seed` | сеть, дома и учётные записи; временные пароли печатаются один раз |
| `pnpm test:db` | интеграционные тесты на живом PostgreSQL |
| `pnpm worker` | планировщик (в фазе 0 заданий нет) |

Каждая команда `db:*` сначала печатает, к какой базе подключается и откуда взята
строка подключения: окружение оболочки перекрывает `.env`, и это уже приводило
к миграции в прод. Нелокальный хост останавливает команду, продолжить можно только
явным `--allow-remote=<хост>` в самой команде.

## Развёртывание

- **Docker/VPS** — `docker compose up -d`. Это основная цель разработки и первичного прода.
- **Vercel + Supabase** — по инструкции `docs/DEPLOY-VERCEL.md`.
  Локальная сборка с `DEPLOY_TARGET=vercel` подтверждает только сборку бандла;
  пулер соединений, лимит тела запроса и serverless-рантайм проверяются
  лишь настоящим превью-деплоем.

## Состояние

Текущая фаза и что уже сделано — в `PROGRESS.md`,
пофазный чек-лист — в `docs/tasks/PHASE-N.md`.
