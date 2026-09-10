/*
 * Перевод рядов на модель фазы 10: у каждого ряда появляется первая версия
 * состава и первая версия нормы, повторяющие его слоты и зоны. Дата вступления —
 * дата первой ротации ряда: до неё сетки нет, и раньше версия не нужна.
 *
 * Генерация с этой миграции читает только версии; ряд без них остался бы
 * без расписания. Ряды, у которых версия уже есть, не трогаются: миграция
 * повторяется без вреда.
 */
INSERT INTO "rotation_row_rosters" ("row_id", "effective_from")
SELECT "r"."id", "r"."start_date"
  FROM "rotation_rows" AS "r"
 WHERE EXISTS (SELECT 1 FROM "rotation_row_slots" AS "s" WHERE "s"."row_id" = "r"."id")
   AND NOT EXISTS (
        SELECT 1 FROM "rotation_row_rosters" AS "v" WHERE "v"."row_id" = "r"."id"
       );
--> statement-breakpoint
INSERT INTO "rotation_row_roster_slots" ("roster_id", "position", "bed_id")
SELECT "v"."id", "s"."position", "s"."bed_id"
  FROM "rotation_row_rosters" AS "v"
  JOIN "rotation_rows" AS "r" ON "r"."id" = "v"."row_id" AND "r"."start_date" = "v"."effective_from"
  JOIN "rotation_row_slots" AS "s" ON "s"."row_id" = "r"."id"
 WHERE NOT EXISTS (
        SELECT 1 FROM "rotation_row_roster_slots" AS "x" WHERE "x"."roster_id" = "v"."id"
       );
--> statement-breakpoint
INSERT INTO "rotation_day_norms" ("row_id", "effective_from")
SELECT "r"."id", "r"."start_date"
  FROM "rotation_rows" AS "r"
 WHERE EXISTS (SELECT 1 FROM "rotation_row_zones" AS "z" WHERE "z"."row_id" = "r"."id")
   AND NOT EXISTS (
        SELECT 1 FROM "rotation_day_norms" AS "n" WHERE "n"."row_id" = "r"."id"
       );
--> statement-breakpoint
INSERT INTO "rotation_day_norm_zones" ("norm_id", "position", "area_id", "checklist_id", "people")
SELECT "n"."id", "z"."position", "z"."area_id", "z"."checklist_id", greatest("z"."people_needed", 1)
  FROM "rotation_day_norms" AS "n"
  JOIN "rotation_rows" AS "r" ON "r"."id" = "n"."row_id" AND "r"."start_date" = "n"."effective_from"
  JOIN "rotation_row_zones" AS "z" ON "z"."row_id" = "r"."id"
 WHERE NOT EXISTS (
        SELECT 1 FROM "rotation_day_norm_zones" AS "x" WHERE "x"."norm_id" = "n"."id"
       );
