/*
 * Счёт на ноль тенге не бывает открытым (находка боевой эксплуатации P1-3,
 * 27 сентября 2026). Сначала закрываются те, что уже есть: платить по ним
 * нечего, а из долга они не уходили. Это не потеря данных — счёт остаётся
 * со своими строками и суммой, меняется только статус, и меняется он
 * на тот, который по правилу `invoiceStatus` должен был стоять с самого
 * начала.
 */
UPDATE "invoices" SET "status" = 'paid', "updated_at" = now()
WHERE "total" = 0 AND "status" IN ('issued', 'partially_paid');--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_zero_total_closed" CHECK ("invoices"."total" > 0 or "invoices"."status" in ('paid', 'cancelled'));