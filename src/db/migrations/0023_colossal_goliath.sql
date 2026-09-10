/*
 * Дописано руками: сид до 10 сентября 2026 писал в weekday число 7 —
 * воскресенье по календарю ISO, которого нет в нумерации приложения
 * (0 — воскресенье). Дата первой ротации у таких рядов верная,
 * поэтому чинится только сам номер дня.
 */
UPDATE "rotation_rows" SET "weekday" = 0 WHERE "weekday" = 7;--> statement-breakpoint
ALTER TABLE "rotation_rows" ADD CONSTRAINT "rotation_rows_weekday_range" CHECK ("rotation_rows"."weekday" between 0 and 6);