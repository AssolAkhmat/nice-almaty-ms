# 06. API

REST под `/api/v1`. Спецификация **OpenAPI 3.1** генерируется из zod-схем
(`zod-to-openapi`) и отдаётся:
- `GET /api/v1/openapi.json`
- `GET /api/docs` — Swagger UI (доступ: суперадмин или локальная разработка).

Тот же сервисный слой, что и у server actions. Логика не дублируется.

## Аутентификация

Два способа:
1. **Сессионная cookie** — для веб-интерфейса.
2. **Bearer-токен** — для ботов: `Authorization: Bearer <token>`.
   Токены создаёт суперадмин, у токена есть скоупы и срок.

Скоупы: `residents:read`, `residents:write`, `rotations:read`, `rotations:write`,
`invoices:read`, `invoices:write`, `absences:read`, `absences:write`,
`houses:read`, `beds:read`, `notifications:write`, `reports:read`.

Токен всегда принадлежит организации; для ограничения домом — параметр токена `house_id`.

## Соглашения

- JSON, `snake_case` в теле, UTF-8.
- Пагинация: `?limit=50&cursor=...`, ответ `{ data: [...], next_cursor }`.
- Ошибки: `{ error: { code, message, details? }, request_id }`.
  Коды: `unauthorized`, `forbidden`, `not_found`, `validation_error`, `conflict`,
  `rate_limited`, `internal`.
- Идемпотентность для POST, создающих деньги: заголовок `Idempotency-Key`.
- Все суммы — целые тенге. Все даты — `YYYY-MM-DD`. Все моменты — ISO 8601 с зоной.
- Rate limit: 120 запросов/мин на токен.

## Основные эндпоинты

```
POST   /auth/login                       телефон + пароль
POST   /auth/change-password
POST   /auth/logout

GET    /houses
GET    /houses/{id}/areas
GET    /houses/{id}/beds                 занятость мест (нужно боту: свободные места)

GET    /residents                        ?house_id&status&q
POST   /residents                        создание аккаунта (superadmin)
GET    /residents/{id}
PATCH  /residents/{id}
POST   /residents/{id}/assign-bed
POST   /residents/{id}/terminate

GET    /documents?resident_id
POST   /documents                        после загрузки файла
POST   /documents/{id}/review            approve | reject

POST   /files/upload-session
POST   /files/{id}/complete
GET    /files/{id}/content

GET    /invoices                         ?house_id&month&status&user_id
POST   /invoices
POST   /invoices/{id}/recalculate
POST   /invoices/{id}/payments
GET    /invoices/remote-tasks            список «удалёнки»
POST   /invoices/{id}/mark-remote-sent

GET    /deposits/{residency_id}
POST   /deposits/{residency_id}/refund

GET    /utilities?house_id&month
POST   /utilities/{period_id}/lines
POST   /utilities/{period_id}/close

GET    /damages?house_id
POST   /damages
POST   /damages/{id}/reverse

GET    /rotations?house_id&from&to       календарь
POST   /rotations/generate               материализация расписания
POST   /rotations/{id}/move
POST   /rotations/{id}/cancel
POST   /rotations/{id}/assign
POST   /rotations/assignments/{id}/confirm
POST   /rotations/assignments/{id}/score
GET    /rotations/template?house_id&date текст для группы

GET    /absences?house_id&status
POST   /absences
POST   /absences/{id}/review

GET    /rating/{user_id}
POST   /rating/events
GET    /rating/rules
PUT    /rating/rules
POST   /fines/{id}/cancel
POST   /discounts/{id}/approve

GET    /accounts
POST   /ledger/entries
GET    /ledger/entries
GET    /reports/turnover?from&to
GET    /reports/deposit-reconciliation
GET    /reports/taxes?from&to

GET    /inventory?house_id
POST   /inventory
POST   /inventory/{id}/movements
POST   /inventory/audits

GET    /notifications
POST   /notifications/{id}/read
POST   /push/subscribe

GET    /audit?entity_type&entity_id&from&to
POST   /cron/{job}                       только с заголовком x-cron-secret
```

## Задел под WhatsApp-бота

Бот (отдельное приложение) в будущем получает токен со скоупами
`houses:read`, `beds:read`, `residents:read`, `absences:write`, `rotations:read`.
Типовые сценарии, которые API уже покрывает: свободные места в доме,
статус жильца по номеру телефона, подача уведомления об отсутствии,
ближайшая ротация жильца. Исходящий канал — адаптер `whatsapp` в `notification_outbox`,
по умолчанию `skipped`.

## Экспорт

`GET /reports/{name}?format=csv|xlsx` — счета, платежи, коммуналка, рейтинг,
ротации, инвентарь, аудит. XLSX генерируется на сервере (`exceljs`),
CSV — потоково, UTF-8 с BOM (чтобы Excel не ломал кириллицу).
