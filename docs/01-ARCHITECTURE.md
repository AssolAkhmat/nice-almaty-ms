# 01. Архитектура

## Слои

```
src/
  app/              Next.js App Router: страницы, layout, server actions
    (auth)/         вход, смена пароля
    (app)/          защищённая зона: dashboard, модули
    api/v1/         REST для ботов и интеграций
    api/v1/cron/    задания планировщика (защищены CRON_SECRET)
  components/       UI: ui/ (примитивы), forms/, tables/, calendar/
  services/         прикладные сценарии: оркестрация, транзакции, аудит, уведомления
  domain/           ЧИСТЫЕ расчётные ядра, без БД и без времени
    utilities.ts    распределение коммуналки
    deposit.ts      депозит, полные месяцы, сгорание
    rating.ts       дельты, пороги, штрафы, скидки
    rotations.ts    генерация сетки ротаций
    invoices.ts     сборка счёта
    money.ts        округление, деление с остатком
  db/
    schema/         Drizzle-схема
    repositories/   доступ к данным, единственное место с SQL
    migrations/     drizzle-kit
  adapters/
    storage/        gdrive.ts | local.ts | supabase.ts
    auth/           local.ts (сейчас) | supabase.ts (задел)
    pdf/            chromium.ts
    notify/         inapp.ts | webpush.ts | whatsapp.stub.ts
  lib/              authz, time, i18n, zod-схемы, logger, env
  workers/          node-cron раннер для Docker-режима
```

Правило: `app/` не ходит в `db/` напрямую — только через `services/`.
`domain/` не импортирует ничего из `db/`, `app/`, `adapters/`.

## Два окружения

Переключение только через переменные окружения. Один и тот же код.

| Возможность | Docker/VPS | Vercel/Supabase |
|---|---|---|
| БД | `postgres:16` в compose | Supabase, строка подключения **через pooler** (порт 6543, `?pgbouncer=true`) |
| Драйвер | `postgres-js` | `postgres-js` в transaction-pooling режиме, `prepare: false` |
| Cron | сервис `worker`, node-cron дергает `/api/v1/cron/*` | `vercel.json` → `crons` |
| Файлы | `STORAGE_DRIVER=gdrive` или `local` | `STORAGE_DRIVER=gdrive` или `supabase` |
| Сессии | БД | БД |

`DEPLOY_TARGET=docker|vercel` — единственное место, где код знает о разнице
(выбор драйвера пула соединений и способа загрузки файлов).

### Ограничение Vercel, которое обязано быть учтено сразу

Тело запроса к serverless-функции ограничено ~4.5 МБ, а фото с телефона бывают крупнее.
Поэтому загрузка файлов **всегда** двухшаговая, в обоих окружениях:

1. Клиент → `POST /api/v1/files/upload-session` (тип документа, mime, размер).
   Сервер проверяет права, создаёт запись `files` со статусом `pending`
   и возвращает URL для прямой загрузки.
2. Клиент загружает байты **напрямую** в хранилище по этому URL
   (Google Drive resumable upload session / presigned PUT).
3. Клиент → `POST /api/v1/files/{id}/complete`. Сервер проверяет размер и mime,
   переводит файл в `ready`.

Файлы всегда приватны. Отдача только через `GET /api/v1/files/{id}/content`,
который проверяет права и стримит содержимое. Публичные ссылки Drive не выдаются никогда.

## Google Drive: как именно

Важное ограничение (проверено, уверенность высокая): у **сервисного аккаунта** Google
нет собственной квоты хранилища. Загрузка от его имени в папку личного диска падает
с `storageQuotaExceeded`, если нет Shared Drive (Workspace).

Поэтому основной драйвер — **OAuth 2.0 от имени владельца диска**:

- одноразовая авторизация Google-аккаунта владельца (scope `drive.file`),
  полученный `refresh_token` кладётся в `GDRIVE_REFRESH_TOKEN`;
- файлы создаются от имени этого аккаунта, лежат в его квоте, видны ему в «Мой диск»;
- корневая папка `GDRIVE_ROOT_FOLDER_ID`, внутри автоматически
  `/{house_slug}/{residency_id}/{document_type}/`;
- если однажды появится Workspace — включается ветка service account + Shared Drive
  без изменения интерфейса `StorageProvider`.

Драйвер `local` (папка `./storage`) обязателен: на нём гоняются тесты и работает dev
без доступа к Google.

## Планировщик

Все задания — обычные HTTP-эндпоинты `POST /api/v1/cron/{job}` с заголовком
`x-cron-secret`. Идемпотентны: повторный вызов за тот же период ничего не дублирует
(таблица `job_runs` с уникальным ключом `job + period_key`).

Расписание задаётся дважды, потому что цели две. В Docker его держит
`src/workers/index.ts`: `node-cron` понимает зону, и время в таблице ниже
записывается как есть. На Vercel расписание живёт в `vercel.json` и идёт
**в UTC без указания зоны**, поэтому месячное задание там выражено ежедневным
запуском в 19:05 UTC — это 00:05 по Алматы. Лишние запуски безвредны:
за уже отработанный период задание ничего не делает.

| Job | Время (Asia/Almaty) | Что делает |
|---|---|---|
| `rotations-close-day` | 23:55 ежедневно | вчерашние неподтверждённые ротации → `missed`, оценка 1, +1 к долгу доп. ротаций, событие рейтинга |
| `rotations-remind` | 09:00, 19:00 | напоминания жильцам о ротации сегодня/завтра и о неподтверждённой вчерашней |
| `curfew-check` | 23:05 | список жильцов без уведомления о кратковременном отсутствии → уведомление админу (без автосанкций) |
| `invoices-monthly` | 1 числа 00:05 | генерация месячных счетов (см. `03-BUSINESS-RULES` §3) |
| `utilities-remind` | 25 числа 10:00 | напоминание админу заполнить коммуналку до конца месяца |
| `schedule-remind` | 25 числа 10:00 | напоминание составить расписание ротаций на следующий месяц |
| `documents-expiry` | 09:00 ежедневно | справки, истекающие через 30 и 7 дней, и просроченные |
| `deposit-refund-watch` | 09:00 ежедневно | обратный отсчёт 30 дней по расторгнутым договорам |
| `rating-year-reset` | 1 июля 00:10 | рейтинг всем → 50, обнуление долгов по доп. ротациям, снятие взведённых порогов |
| `notifications-dispatch` | каждые 5 минут | разбор `notification_outbox` |

## PWA

Приложение устанавливается на телефон: манифест отдаёт `src/app/manifest.ts`,
иконки лежат в `public/icons` и рисуются `scripts/make-icons.mjs`, service
worker — `public/sw.js`, регистрируется из корневой раскладки.

Service worker кеширует только оболочку: страницу обрыва связи и иконки.
Страницы приложения не кешируются намеренно — данные меняются каждый день,
и вчерашний список хуже честного «нет сети». Он же принимает push и по
нажатию открывает центр уведомлений.

## Аутентификация

- Логин: телефон (нормализация в `+7XXXXXXXXXX`) + пароль. Пароль — argon2id.
- Аккаунт создаёт суперадмин, выдаёт временный пароль, `must_change_password = true`.
  До смены пароля доступен только экран смены пароля.
- Сброс: админ/суперадмин нажимает «разрешить сброс» → `password_reset_allowed = true`.
  После этого жилец входит с **любым** паролем и обязан немедленно задать новый.
  Разрешение действует 24 часа и одноразовое. Каждое использование — в `audit_log`.
  (Это осознанно слабая схема, выбранная владельцем; помечена в `docs/08-DECISIONS.md`.)
- Сессия: httpOnly + Secure + SameSite=Lax cookie, внутри непрозрачный токен,
  сама сессия — строка в БД (`sessions`), можно отозвать. TTL 30 дней, скользящее продление.
- Без 2FA. Rate limit на вход: 10 попыток / 15 минут на телефон и на IP.

`AuthProvider` — интерфейс (`signIn`, `getSession`, `revoke`, `setPassword`),
реализация `local`, задел `supabase`.

## Безопасность данных

- ИИН и номер УДЛ хранятся зашифрованными (AES-256-GCM, ключ `FIELD_ENCRYPTION_KEY`),
  в БД — `bytea` + отдельная колонка `*_last4` для поиска и отображения.
  В UI по умолчанию замаскированы, раскрываются кнопкой «глаз»;
  **каждое раскрытие пишется в `audit_log`**.
- Все запросы фильтруются по `org_id`; для роли `admin` дополнительно по `house_id`.
  Фильтр применяется в репозиториях, а не в UI.
- `audit_log` пишет: кто, что, когда, значения до и после, IP. Читает только суперадмин.

## Переменные окружения

```
DEPLOY_TARGET=docker|vercel
DATABASE_URL=
DIRECT_DATABASE_URL=          # для миграций на Supabase (порт 5432)
POSTGRES_PORT=5432            # порт публикации postgres из compose наружу
TEST_DATABASE_URL=            # только для pnpm test:db, приложение не читает
APP_URL=
SESSION_SECRET=
FIELD_ENCRYPTION_KEY=         # 32 байта base64
CRON_SECRET=
DEFAULT_LOCALE=ru
TZ=Asia/Almaty

CHROMIUM_PATH=               # путь к chromium для печати договора, пусто — искать самому

STORAGE_DRIVER=gdrive|local|supabase
GDRIVE_CLIENT_ID=
GDRIVE_CLIENT_SECRET=
GDRIVE_REFRESH_TOKEN=
GDRIVE_ROOT_FOLDER_ID=
LOCAL_STORAGE_PATH=./storage

SUPABASE_URL=                 # задел
SUPABASE_SERVICE_ROLE_KEY=    # задел
SUPABASE_STORAGE_BUCKET=      # задел

WEBPUSH_PUBLIC_KEY=           # ключи VAPID: задаются целиком или не задаются вовсе
WEBPUSH_PRIVATE_KEY=
WEBPUSH_SUBJECT=              # контакт владельца: mailto: или https:

WHATSAPP_WEBHOOK_URL=         # заглушка, канал отключён по умолчанию
```

## Уведомления

Уведомление — факт «человеку сообщили»: строка `notifications` с текстами
во всех трёх локалях. Доставка идёт отдельно, по строке `notification_outbox`
на канал, и разбирается заданием `notifications-dispatch` каждые пять минут.
Каналы подключаются реестром в `src/adapters/notify/index.ts`; канал без
ключей не подключается, и его строки честно помечаются `skipped`.

Web Push реализован своей парой функций на WebCrypto (`src/lib/crypto/webpush.ts`):
конверт `aes128gcm` по RFC 8291 и подпись VAPID по RFC 8292. Библиотеки для
этого нет намеренно — нужны ровно две операции, и обе укладываются в WebCrypto,
который работает и в edge-рантайме.

Публичный ключ VAPID нужен браузеру, но `NEXT_PUBLIC_*` для него не заводится:
такая переменная впекается в бандл, и смена ключа потребовала бы пересборки.
Ключ отдаёт сервер в момент оформления подписки (P6-11).

WhatsApp остаётся заглушкой: отправка требует договора с провайдером
Business API — это обязательство владельца, а не разработки.

## Генерация PDF договора

Адаптер `PdfRenderer`, драйвер `chromium`:
- Docker: системный `chromium` + `puppeteer-core`;
- Vercel: `@sparticuz/chromium` + `puppeteer-core`.

Вход: HTML-шаблон договора из БД (`contract_templates.body_html`) с токенами вида
`{{resident.full_name}}`, подставленные значения, PNG подписи (data URL).
Выход: PDF → `StorageProvider` → `files` → ссылка в `residencies.contract_file_id`.

## Наблюдаемость

`pino` в JSON, `request_id` в каждой записи. Ошибки серверных экшенов не показывают
пользователю стек — только код ошибки и `request_id`. `/api/health` проверяет БД и хранилище.
