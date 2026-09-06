# 02. Модель данных

PostgreSQL 16. Все таблицы: `id uuid pk default gen_random_uuid()`, `created_at`, `updated_at timestamptz`.
Все прикладные таблицы содержат `org_id uuid not null` — фильтруется в репозиториях всегда.
Деньги — `bigint` (целые тенге). Бизнес-даты — `date`. Моменты времени — `timestamptz` (UTC).

## Организация и дома

**organizations** — `name`, `slug`. Одна строка в сиде, UI создания скрыт.

**houses** — `org_id`, `name`, `slug`, `address`, `curfew_time time default '23:00'`,
`default_deposit bigint default 45000`, `settings jsonb`, `archived_at`.

**areas** — `house_id`, `type enum(living, common)`, `name`, `sort_order`, `archived_at`.

**beds** — `house_id`, `area_id` (только `living`), `label`, `tier enum(upper, lower)`,
`number int`, `default_price bigint`, `archived_at`.
Уникальность `(area_id, number, tier)`.

## Пользователи

**users** — `org_id`, `phone` (уникальный, `+7XXXXXXXXXX`), `password_hash`,
`role enum(superadmin, admin, resident)`, `house_id` (обязателен для `admin`, иначе null),
`must_change_password bool`, `password_reset_allowed_until timestamptz`,
`locale enum(ru, kk, en) default ru`, `theme enum(light, dark, system) default system`,
`status enum(active, archived)`, `last_login_at`.

Колонка `theme` добавлена в фазе 1: личные настройки в `04-MODULES/11-users-settings.md`
называют тему наравне с языком, но в модели данных её не было. Выбор оформления обязан
переживать смену устройства, иначе настройка бессмысленна.

**sessions** — `user_id`, `token_hash`, `expires_at`, `ip`, `user_agent`, `revoked_at`.

**resident_profiles** — `user_id pk`, `last_name`, `first_name`, `middle_name`,
`sex enum(male, female)`, `birth_date`, `phone`, `id_doc_number_enc bytea`, `id_doc_last4`,
`iin_enc bytea`, `iin_last4`, `university`, `course int`, `major`,
`emergency_name`, `emergency_phone`, `emergency_relation`,
`preferred_payment enum(kaspi, cash)`, `photo_file_id`,
`no_epilepsy bool`, `no_asthma bool`, `health_declared_at`.

## Проживание

**residencies** — `user_id`, `house_id`, `org_id`,
`status enum(created, profile_pending, docs_pending, deposit_pending, active, terminating, archived)`,
`contract_start date`, `contract_end date`, `move_in_date date` (= дата оплаты депозита),
`termination_requested_at`, `move_out_date date`, `deposit_due_date date`,
`deposit_amount bigint`, `keys_issued bool`, `keys_issued_at`,
`contract_signed_at`, `contract_file_id`, `signature_file_id`.

**bed_assignments** — `residency_id`, `bed_id`, `price bigint`, `period daterange`,
`created_by`.
Ограничение: `EXCLUDE USING gist (bed_id WITH =, period WITH &&)` (требуется `btree_gist`)
— одно место не может быть занято двумя проживаниями одновременно.

**document_types** — `org_id`, `code`, `name_i18n jsonb`, `validity_months int null`
(null = бессрочно), `requires_issue_date bool`, `is_required bool`, `sort_order`, `archived_at`.
Сид: `photo_3x4` (бессрочно), `dispensary` (12 мес от загрузки),
`fluorography` (12 мес от даты снимка).

**documents** — `user_id`, `residency_id`, `document_type_id`, `file_id`,
`issue_date date null`, `valid_from date`, `valid_until date null`,
`status enum(uploaded, approved, rejected)`, `reject_reason`, `reviewed_by`, `reviewed_at`.

**contract_templates** — `org_id`, `name`, `version int`, `body_html`,
`tokens jsonb` (список доступных подстановок), `is_active bool`.

## Деньги

**accounts** — `org_id`, `house_id null`, `code`, `name`,
`type enum(deposit_fund, house_fund, utility_fund, common_fund, cash, kaspi, external)`,
`is_system bool`, `archived_at`.

**ledger_entries** — `org_id`, `entry_date date`, `description`,
`source_type`, `source_id`, `created_by`, `reversed_by_entry_id null`.

**ledger_lines** — `entry_id`, `account_id`, `direction enum(debit, credit)`, `amount bigint`.
Инвариант: сумма debit = сумма credit внутри проводки (проверяется в сервисе и тестом).

**invoices** — `org_id`, `house_id`, `user_id`, `residency_id`,
`type enum(deposit, monthly, extra, deposit_refund)`, `period_month date null` (первое число),
`status enum(pending, issued, partially_paid, paid, cancelled, returned, burned)`,
`total bigint`, `issued_at`, `due_date date`, `remote_sent_at null`, `note`, `created_by`.

**invoice_lines** — `invoice_id`,
`kind enum(rent, utilities, fine, damage_carryover, extra, deposit, discount, proration)`,
`title`, `amount bigint` (скидка — отрицательная), `meta jsonb`.

**payments** — `invoice_id`, `amount bigint`, `method enum(kaspi, cash)`,
`paid_at`, `recorded_by`, `note`.

**deposit_transactions** — `residency_id`,
`type enum(charge, damage_share, damage_reversal, refund, burn, adjustment)`,
`amount bigint` (со знаком), `ref_type`, `ref_id`, `note`, `created_by`.
Остаток депозита = сумма `amount`.

## Коммуналка

**utility_periods** — `house_id`, `month date`, `status enum(draft, closed)`, `closed_at`, `closed_by`.
Уникальность `(house_id, month)`.

**utility_lines** — `period_id`, `title`, `amount bigint`, `receipt_file_id null`.

**utility_allocations** — `period_id`, `user_id`, `days int`, `amount bigint`, `invoice_line_id null`.
Снимок расчёта, чтобы история не менялась задним числом.

## Ущерб

**damages** — `house_id`, `title`, `description`, `amount bigint`, `receipt_file_id null`,
`split_mode enum(single, room, all, all_except, custom)`, `split_config jsonb`,
`created_by`, `reversed_at`, `reversed_by`.

**damage_shares** — `damage_id`, `user_id`, `residency_id`, `amount bigint`.

## Ротации

**area_checklists** — `area_id`, `type enum(regular, general)`, `title`,
`items jsonb` (массив пунктов), `people_needed int default 1`.

**eligibility_groups** — `house_id`, `name`,
`rule jsonb` — `{ base: 'all'|'male'|'female'|'room', area_id?, include_user_ids[], exclude_user_ids[] }`.

**area_eligibility** — `area_id`, `checklist_type`, `group_id`.

**rotation_rows** — `house_id`, `name`, `type enum(common, room)`, `weekday int (0-6)`,
`start_date date`, `is_active bool`, `sort_order`.

**rotation_row_slots** — `row_id`, `position int`, `bed_id`. Уникальность `(row_id, position)`.

**rotation_row_zones** — `row_id`, `position int`, `area_id`, `checklist_id`, `people_needed int`.

**rotation_occurrences** — `house_id`, `row_id null`, `area_id`, `checklist_id`,
`date date`, `type enum(regular, room, general, extra)`,
`status enum(scheduled, done, missed, cancelled)`,
`moved_from_date null`, `cycle_index int null`, `created_by null` (не null для `extra`).

**rotation_assignments** — `occurrence_id`, `user_id null`, `slot_position null`,
`source enum(auto, manual, debt)`,
`state enum(assigned, needs_reassignment, confirmed, missed, cancelled)`,
`confirmed_at`, `done_at`, `confirmed_by`, `score int null (1..10)`, `scored_by`, `scored_at`,
`photo_file_ids uuid[]`, `note`.

**rotation_debts** — `user_id`, `reason`, `source_assignment_id null`,
`resolved_by_assignment_id null`, `expires_at date` (1 июля), `created_at`.

**rotation_templates_settings** — `house_id`, `type enum(regular, general)`,
`header_i18n jsonb`, `footer_i18n jsonb`.

## Присутствие

**absences** — `user_id`, `house_id`, `type enum(short, long, sick)`,
`start_date date`, `end_date date null`, `start_at timestamptz null` (для `short`),
`reason text not null`, `status enum(pending, approved, rejected)`,
`reviewed_by`, `reviewed_at`, `doc_file_id null`.
Для `long`: `start_date >= сегодня + 1 день` (проверка в сервисе).

## Рейтинг

**rating_rules** — `org_id`, `house_id null` (переопределение),
`kind enum(score_delta, admin_action, threshold_down, threshold_up)`,
`code`, `config jsonb` (`{score:10, delta:3}`, `{threshold:40, actions:['extra_rotation']}`,
`{threshold:30, actions:['extra_rotation','fine'], fine_amount:2500}`), `is_active bool`.

**rating_events** — `user_id`, `type`, `delta int`, `ref_type`, `ref_id`,
`note`, `created_by`, `effective_at`, `period_start date` (год рейтинга, с 1 июля).

**rating_threshold_states** — `user_id`, `rule_id`, `armed bool`, `last_triggered_at`.

**fines** — `user_id`, `house_id`, `amount bigint`, `rule_id null`, `reason`,
`status enum(pending, applied, cancelled)`, `invoice_id null`, `cancelled_by`, `cancelled_reason`.

**discounts** — `user_id`, `amount bigint`, `rule_id`, `status enum(proposed, approved, revoked)`,
`approved_by`, `approved_at`.

## Инвентарь

**inventory_items** — `house_id`, `name`, `qty numeric(12,2)`, `unit`, `unit_cost bigint`,
`responsible_user_id null`, `status enum(in_use, written_off)`, `acquired_at date`, `note`.

**inventory_movements** — `item_id`, `type enum(in, out, write_off, transfer, audit_adjust)`,
`qty numeric(12,2)`, `date date`, `from_house_id null`, `to_house_id null`, `doc_ref`, `created_by`.

**inventory_audits** — `house_id`, `date`, `status enum(draft, closed)`, `created_by`.

**inventory_audit_lines** — `audit_id`, `item_id`, `expected_qty`, `actual_qty`, `comment`.

## Файлы, уведомления, система

**files** — `org_id`, `provider enum(gdrive, local, supabase)`, `external_id`, `path`,
`mime`, `size_bytes bigint`, `original_name`, `checksum`,
`status enum(pending, ready, failed)`, `uploaded_by`, `scope jsonb`.

**notifications** — `user_id`, `type`, `title_i18n jsonb`, `body_i18n jsonb`,
`payload jsonb`, `read_at`, `created_at`.

**notification_outbox** — `notification_id`, `channel enum(inapp, webpush, whatsapp)`,
`status enum(queued, sent, failed, skipped)`, `attempts int`, `sent_at`, `error`.

**push_subscriptions** — `user_id`, `endpoint`, `p256dh`, `auth`, `user_agent`, `revoked_at`.

**settings** — `scope enum(org, house)`, `scope_id`, `key`, `value jsonb`. Уникальность `(scope, scope_id, key)`.

**audit_log** — `org_id`, `actor_user_id`, `action`, `entity_type`, `entity_id`,
`before jsonb`, `after jsonb`, `ip`, `request_id`, `created_at`. Индекс по `(entity_type, entity_id)` и `created_at`.

**api_tokens** — `org_id`, `name`, `token_hash`, `scopes text[]`, `expires_at`, `last_used_at`, `revoked_at`.

**job_runs** — `job`, `period_key`, `started_at`, `finished_at`, `status`, `result jsonb`.
Уникальность `(job, period_key)` — идемпотентность cron.

**rate_limits** — `key text primary key`, `window_start timestamptz`, `count int`.
Счётчик попыток входа. Ключи `login:phone:+7XXXXXXXXXX` и `login:ip:X.X.X.X`,
окно 15 минут, порог 10 попыток. Хранится в базе, а не в памяти: на serverless
процессы не разделяют состояние. Просроченные строки удаляются лениво при записи,
отдельное задание на очистку — фаза 6. Общих колонок `id`/`created_at`/`updated_at`
у таблицы нет: ключ и есть первичный ключ. Решение P1-5 в `docs/08-DECISIONS.md`.

## Ключевые инварианты (обязательные тесты)

1. Одно место не занято двумя проживаниями в пересекающиеся периоды.
2. У активного проживания ровно одно действующее `bed_assignment`.
3. Сумма дебетов = сумме кредитов в каждой проводке.
4. Баланс счёта «Депозитный фонд» = сумме остатков депозитов активных проживаний.
5. Сумма `invoice_lines.amount` = `invoices.total`.
6. Сумма платежей по счёту не превышает `total` (иначе — явная переплата, запрещена без флага).
7. Рейтинг всегда в [0, 100].
8. Для любой `rotation_occurrence` число назначений = `people_needed` чек-листа.
9. `D <= S` в каждом активном ряду ротаций.
