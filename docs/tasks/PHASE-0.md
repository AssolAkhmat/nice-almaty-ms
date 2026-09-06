# Фаза 0. Каркас — чек-лист задач

Источник: `docs/07-ROADMAP.md`, раздел «Фаза 0».
Правило: один таск = один коммит = зелёный `pnpm verify`.

## Критерии приёмки фазы (из роадмапа)

- [ ] `docker compose up` поднимает пустое приложение
- [ ] Переключается тема (светлая / тёмная / системная)
- [ ] Переключается язык (ru / kk / en)
- [ ] `pnpm verify` зелёный
- [ ] `GET /api/health` отвечает (БД и хранилище)
- [ ] `next build` проходит с `DEPLOY_TARGET=vercel`
- [ ] `docs/DEPLOY-VERCEL.md` существует и пригоден для превью-деплоя владельцем

## Зафиксированный стек (проверены peer-зависимости 2026-09-06)

| Пакет | Версия | Почему так |
|---|---|---|
| node | 24.14.0 | установлен локально; требование vitest 5 — `^22.12 \|\| ^24 \|\| >=26` |
| pnpm | 12.3.4 | `corepack enable` падает с EPERM, поставлен через `npm i -g pnpm@12`; в `package.json` — поле `packageManager` |
| next | 16.3.4 | App Router, Turbopack |
| react / react-dom | 19.2.8 | peer next 16 |
| typescript | 6.0.3 | **не 7.0.2**: `typescript-eslint` вызывает `getTypeChecker()` классического API, которого нет в `tsgo`. Несовместимость API, не отставание версий |
| tailwindcss | 4.3.3 | CSS-first, `@theme` |
| drizzle-orm / drizzle-kit | 0.45.2 / 0.31.10 | |
| postgres (postgres-js) | 3.4.9 | драйвер по `01-ARCHITECTURE` |
| next-intl | 4.14.2 | peer next `^16` |
| zod | 4.5.4 | |
| vitest | 5.0.0 | |
| @playwright/test | 1.63.0 | |
| eslint | 10.10.0 | peer `eslint-config-next` — `>=9` |
| typescript-eslint | 8.69.0 | |
| prettier / eslint-config-prettier | 3.9.6 / 10.1.8 | |
| @radix-ui/react-* | 1.x | headless-примитивы |
| lucide-react | 1.41.0 | иконки, толщина 1.5 |
| pino | 10.3.1 | логгер |
| node-cron | 4.6.0 | раннер `worker` (в фазе 0 — пустой скелет) |

---

## Таски

### T0.1 — Инициализация репозитория и тулинга
- [x] `package.json`: `"packageManager": "pnpm@12.3.4"` зафиксирован явно (corepack не заработал — иначе CI и локальная машина разъедутся)
- [x] Скрипты `typecheck/lint/format/test/verify`; `dev/build/start` добавляются в T0.3 вместе с Next
- [x] `vitest.config.ts` с `--passWithNoTests` (флаг снимается в T0.2, когда появятся реальные тесты)
- [x] `docs/08-DECISIONS.md`: все десять решений фазы записаны **этим** коммитом
- [x] `tsconfig.json` — `strict: true`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, алиас `@/*`
- [x] ESLint flat config: `eslint-config-next` + `typescript-eslint` + `eslint-config-prettier`
- [x] Правило ESLint: запрет `new Date()` вне `src/lib/time.ts` (`no-restricted-syntax`)
- [x] Правило ESLint: запрет импорта `@/db`, `@/app`, `@/adapters` из `src/domain/**`
- [x] `.prettierrc`, `.editorconfig`, `.gitignore`, `.npmrc`
- [x] `pnpm verify` = `typecheck && lint && format:check && test`
- Коммит: `chore(setup): тулинг, tsconfig, eslint, prettier`

### T0.2 — Vitest и первые расчётные ядра (TDD)
- [x] `vitest.config.ts` (окружение `node`, алиасы, покрытие)
- [x] **Тесты вперёд**: `src/domain/money.test.ts` — пример §0.1 (`splitCeil(1800, 17×[1])` → 106 каждому, сумма 1802, `surplus = 2`), плюс граничные случаи из §0
- [x] `src/domain/money.ts` — `splitCeil(total, weights)`
- [x] **Тесты вперёд**: `src/lib/time.test.ts` — `Asia/Almaty`: границы суток, первый/последний день месяца, «сегодня», разбор и формат `date`
- [x] `src/lib/time.ts` — единственная точка входа во время (`now()`, `todayInAlmaty()`, `startOfMonth`, `endOfMonth`, `toAlmaty`, `parseBusinessDate`)
- Коммит: `feat(domain): splitCeil и утилиты времени Asia/Almaty`

### T0.3 — Каркас Next.js 16 и токены дизайн-системы
- [ ] `next.config.ts` (`output: 'standalone'` только при `DEPLOY_TARGET=docker`)
- [ ] `src/app/layout.tsx`, `src/app/page.tsx`
- [ ] Montserrat через `next/font/google`, веса 400/500/600/700, `subsets: ['latin','cyrillic']`, `display: swap`
- [ ] `src/app/globals.css`: `@import "tailwindcss"`, блок `@theme` и переменные `:root` / `.dark` — **дословно** из `05-DESIGN-SYSTEM.md`
- [ ] `@custom-variant dark` через класс `.dark` (Tailwind v4 по умолчанию смотрит на `prefers-color-scheme`)
- [ ] Типографическая шкала (H1 28/600 … метка таблицы 12/600 uppercase), `tabular-nums` для чисел
- Коммит: `feat(ui): каркас приложения и токены дизайн-системы`
- DoD: проверка на 375 / 768 / 1440, обе темы

### T0.4 — Тема: светлая / тёмная / системная
- [ ] Inline-скрипт в `<head>` против мигания (читает localStorage, ставит класс `.dark`)
- [ ] `ThemeProvider` + хук, три режима, запись в `localStorage`
- [ ] Компонент переключателя темы в шапке
- [ ] Задел: синхронизация с профилем пользователя появится в фазе 1 (в БД ещё нет `users`)
- Коммит: `feat(ui): три режима темы без мигания`

### T0.5 — i18n: ru / kk / en
- [ ] `next-intl` **без локали в URL** (локаль из cookie `NEXT_LOCALE`, далее — из профиля)
- [ ] `src/lib/i18n/` — конфиг, `getLocale`, `setLocale` (server action)
- [ ] `messages/ru.json`, `messages/kk.json`, `messages/en.json` — все три заполнены сразу
- [ ] Форматирование дат и денег через `next-intl` + `src/lib/time.ts`, зона `Asia/Almaty`
- [ ] Переключатель языка в шапке
- [ ] Тест: во всех трёх файлах локалей одинаковый набор ключей
- Коммит: `feat(i18n): три локали и переключатель языка`

### T0.6 — Окружение: `src/env.ts` и логгер
- [ ] `src/env.ts` — zod-схема всех переменных из `01-ARCHITECTURE.md`, `import 'server-only'`, без значений по умолчанию для секретов
- [ ] Условная валидация: `GDRIVE_*` обязательны только при `STORAGE_DRIVER=gdrive`, `SUPABASE_*` — при `supabase`
- [ ] Проверка `FIELD_ENCRYPTION_KEY` — ровно 32 байта base64
- [ ] `.env.example` со всеми ключами и пустыми значениями секретов
- [ ] `src/lib/logger.ts` — pino, JSON, поле `request_id`
- [ ] Тесты схемы env (валидный набор, отсутствующий секрет, короткий ключ шифрования)
- Коммит: `feat(env): типизированные переменные окружения и логгер`

### T0.7 — Drizzle и первая миграция
- [ ] `drizzle.config.ts` (`DIRECT_DATABASE_URL` для миграций, иначе `DATABASE_URL`)
- [ ] `src/db/client.ts` — postgres-js; при `DEPLOY_TARGET=vercel` — `prepare: false`, пул под pooler
- [ ] `src/db/schema/index.ts`, первая таблица `job_runs` (`job`, `period_key`, уникальность `(job, period_key)`) — чистая инфраструктура идемпотентности cron
- [ ] Миграция 0000: `job_runs` + `btree_gist` в `DO`-блоке — идемпотентно и без падения при отсутствии прав
      суперпользователя (`insufficient_privilege` → `RAISE WARNING`, а не ошибка)
- [ ] При первом переключении на Supabase фактически проверить, что `btree_gist` ставится,
      и записать результат в `docs/08-DECISIONS.md`
- [ ] Скрипты `db:generate`, `db:migrate`, `db:studio`
- [ ] Проверка: миграция применяется на чистой БД в docker
- Коммит: `feat(db): drizzle, клиент под оба окружения, первая миграция`

### T0.8 — Базовые компоненты `src/components/ui/*`
- [ ] `Button` (primary / secondary / ghost / danger, sm / md), фокус-кольцо 2px
- [ ] `Input`, `Textarea`, `Select`, `Checkbox`, `Switch` (Radix)
- [ ] `Badge` (neutral / info / success / warning / danger / accent), `StatusPill`
- [ ] `Card`, `Skeleton`, `EmptyState`, `Pagination`, `Avatar`, `Money` (tabular-nums, вправо)
- [ ] `Modal` (Radix Dialog), `Tabs` (Radix), `Toast` (Radix)
- [ ] `Table`: липкая шапка, сортировка, карточная раскладка < 768px
- [ ] Тесты контраста токенов: `#FEE274` не используется как текст на светлом и как заливка кнопки
- [ ] Отложено до своих фаз: `Combobox`, `DatePicker`, `Drawer`, `Calendar`, `SignaturePad`, `FileUpload`, `ChecklistEditor`
- Коммит: `feat(ui): базовые компоненты дизайн-системы`
- DoD: 375 / 768 / 1440, обе темы, цели нажатия ≥ 44×44 на мобильном

### T0.9 — Каркас layout и адаптивная навигация
- [ ] Десктоп (≥1024): постоянное боковое меню 240px
- [ ] Планшет (768–1023): меню сворачивается в иконки
- [ ] Мобильный (<768): нижняя навигация 4 пункта + «Ещё» (Sheet/бургер)
- [ ] Шапка: переключатель темы, переключатель языка
- [ ] Пункты меню — из типизированного конфига по 11 модулям; страницы-заглушки на `EmptyState`
- [ ] Все подписи — ключи i18n в трёх локалях
- Коммит: `feat(ui): каркас layout и адаптивная навигация`

### T0.10 — Playwright и e2e приёмки фазы
- [ ] `playwright.config.ts` (проекты: desktop 1440, tablet 768, mobile 375)
- [ ] e2e: переключение темы сохраняется после перезагрузки
- [ ] e2e: переключение языка меняет подписи интерфейса
- [ ] e2e: навигация присутствует в трёх ширинах
- [ ] Скрипт `test:e2e`
- Коммит: `test(e2e): проверки темы, языка и адаптивности`

### T0.11 — Docker
- [ ] `Dockerfile` (multi-stage, `next build` со `standalone`, non-root)
- [ ] `docker-compose.yml`: `app`, `postgres:16` (healthcheck, volume), `worker`
- [ ] `src/workers/index.ts` — раннер node-cron; в фазе 0 заданий нет, только старт и лог
- [ ] `GET /api/health` — проверка БД и `StorageProvider`, ответ `{ status, checks, request_id }`
- [ ] `healthcheck` сервиса `app` в compose бьёт в `/api/health`
- [ ] `.dockerignore`
- [ ] Проверка: `docker compose up` → `/api/health` отвечает `ok`, миграции применены
- Коммит: `chore(docker): compose с app, postgres и worker`

### T0.12 — GitHub Actions
- [ ] Workflow: `pnpm install --frozen-lockfile` → `verify` → `build`
- [ ] Сервис `postgres:16` в job, прогон `db:migrate` на чистой БД
- [ ] Job e2e с Playwright
- [ ] Тестовые (не секретные) значения переменных окружения задаются в workflow — escape-hatch вида `SKIP_ENV_VALIDATION` не вводим
- Коммит: `ci: сборка, проверки и e2e в GitHub Actions`

### T0.13 — Сборка под цель Vercel
- [ ] `next build` с `DEPLOY_TARGET=vercel` (без `standalone`, драйвер в режиме pooler)
- [ ] Это проверяет **только** сборку бандла: ни пулер соединений, ни лимит тела запроса,
      ни serverless-рантайм локально не проверяются
- [ ] `README.md`: быстрый старт, обе цели развёртывания
- Коммит: `chore(build): сборка под цель vercel`

### T0.14 — Инструкция по превью-деплою на Vercel
- [ ] `docs/DEPLOY-VERCEL.md`: создание проекта, привязка репозитория, build-команда
- [ ] Полный список переменных окружения с пометкой обязательности на этапе фазы 0
- [ ] Supabase: строка подключения через pooler (порт 6543, `?pgbouncer=true`) и
      `DIRECT_DATABASE_URL` (порт 5432) для миграций
- [ ] `vercel.json`: заготовка секции `crons` с перечнем заданий из `01-ARCHITECTURE.md`
      (сами обработчики — фаза 6)
- [ ] Порядок проверки после деплоя: `/api/health` → переключение темы → переключение языка
- [ ] **Фаза не закрыта, пока этого файла нет**
- Коммит: `docs: инструкция по превью-деплою на vercel`

### T0.15 — Закрытие фазы
- [ ] `docs/08-DECISIONS.md` дополнен решениями, принятыми по ходу фазы
- [ ] `PROGRESS.md`: что сделано, что осталось, на чём споткнулся
- [ ] `PROGRESS.md`: пометка, что kk-локаль нуждается в вычитке человеком до показа жильцам
- [ ] Все чекбоксы выше закрыты
- Коммит: `docs: закрытие фазы 0`

---

## Решения, которые уйдут в `docs/08-DECISIONS.md`

Документация не даёт ответа — принят консервативный вариант:

1. **TypeScript 6.0.3, а не 7.0.2.** Это несовместимость API, а не отставание версий:
   `typescript-eslint` работает через классический API TypeScript и вызывает `getTypeChecker()`,
   которого нет в поверхности `tsgo`. Форки-мосты не подключаем.
   Пересмотреть, когда `typescript-eslint` официально закроет поддержку TS 7.
2. **i18n без префикса локали в URL.** Локаль — атрибут пользователя (`users.locale`),
   в `06-API.md` пути без локали. Источник: cookie `NEXT_LOCALE`, с фазы 1 — профиль.
3. **Содержимое первой миграции:** расширение `btree_gist` (нужно для `EXCLUDE` в фазе 2)
   и таблица `job_runs`. Прикладные таблицы создаются в своих фазах.
4. **Набор компонентов `ui/` в фазе 0** — только простые примитивы;
   сложные (`Calendar`, `SignaturePad`, `FileUpload`, `ChecklistEditor`, `DatePicker`,
   `Combobox`, `Drawer`) делаются в фазах, где впервые нужны.
5. **`pnpm verify` = `typecheck + lint + format:check + test`.** `build` и e2e — в CI отдельными шагами.
6. **Без `SKIP_ENV_VALIDATION`.** В CI задаются тестовые значения переменных.
7. **Тема в фазе 0 хранится только в `localStorage`** — таблицы `users` ещё нет.
8. **`worker` в фазе 0 — пустой скелет.** Задания cron появляются в фазе 6.
9. **`src/domain/money.ts` и `src/lib/time.ts` делаются уже в фазе 0**, хотя роадмап
   относит примеры §0.1 к фазе 3: инвариант «никакого `new Date()` в бизнес-логике»
   должен действовать с первого дня, а Vitest нужно проверять реальными тестами.
10. **Локальная сборка с `DEPLOY_TARGET=vercel` не является проверкой развёртывания.**
    Она подтверждает только сборку бандла. Реальный превью-деплой делает владелец
    по `docs/DEPLOY-VERCEL.md` (T0.14); без этого файла фаза не закрывается.

**Порядок записи решений:** все десять пишутся в `docs/08-DECISIONS.md` в коммите T0.1.
Каждое последующее решение фазы добавляется в тот же коммит, в котором оно принято,
а не откладывается до закрытия фазы.
