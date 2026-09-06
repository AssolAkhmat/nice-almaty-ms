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

```bash
cp .env.example .env
docker compose up -d postgres
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Демо-учётки после сида — в выводе `pnpm db:seed`.
