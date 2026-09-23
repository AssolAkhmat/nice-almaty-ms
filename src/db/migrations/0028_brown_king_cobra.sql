-- Дом назначения места: «дом тогда» рядом с «домом сейчас» (указание владельца,
-- 22 сентября 2026, переселение жильца между домами без расторжения договора).
--
-- Колонка добавляется пустой и заполняется домом места: на боевой базе
-- назначения уже есть, и NOT NULL сразу отбил бы миграцию.
ALTER TABLE "bed_assignments" ADD COLUMN "house_id" uuid;--> statement-breakpoint

UPDATE "bed_assignments" AS a
SET "house_id" = b."house_id"
FROM "beds" AS b
WHERE b."id" = a."bed_id" AND a."house_id" IS NULL;--> statement-breakpoint

ALTER TABLE "bed_assignments" ALTER COLUMN "house_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "bed_assignments" ADD CONSTRAINT "bed_assignments_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Дом назначения равен дому места — это теперь факт базы, а не соглашение.
ALTER TABLE "bed_assignments" ADD CONSTRAINT "bed_assignments_bed_house_fk" FOREIGN KEY ("bed_id","house_id") REFERENCES "public"."beds"("id","house_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "bed_assignments_house_idx" ON "bed_assignments" USING btree ("house_id");--> statement-breakpoint

/*
 * Правило «место своего дома» (§1.2): место, которое назначают проживанию,
 * обязано быть в том доме, где проживание числится.
 *
 * Почему триггер, а не составной внешний ключ на `residencies(id, house_id)`:
 * такой ключ сверял бы назначение с домом проживания ВСЕГДА, а не в момент
 * назначения. Переселение меняет `residencies.house_id`, и все прошлые
 * назначения, указывающие на прежний дом, мгновенно стали бы нарушением —
 * ключ либо запретил бы переселение вовсе, либо (с ON UPDATE CASCADE)
 * переписал бы историю, объявив, что человек всегда жил в новом доме.
 * Ни то, ни другое не годится.
 *
 * Триггер срабатывает только когда назначают место: закрытие периода
 * трогает `period`, а не `bed_id`, поэтому переселение проходит —
 * сперва меняется дом проживания, потом открывается новое назначение.
 */
CREATE OR REPLACE FUNCTION bed_assignment_house_matches() RETURNS trigger AS $$
DECLARE
	residency_house uuid;
BEGIN
	SELECT r."house_id" INTO residency_house
	FROM "residencies" AS r
	WHERE r."id" = NEW."residency_id";

	IF residency_house IS NOT NULL AND residency_house <> NEW."house_id" THEN
		RAISE EXCEPTION 'Место другого дома: проживание числится в доме %, место в доме %',
			residency_house, NEW."house_id"
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER bed_assignments_house_matches
	BEFORE INSERT OR UPDATE OF "bed_id", "house_id", "residency_id" ON "bed_assignments"
	FOR EACH ROW EXECUTE FUNCTION bed_assignment_house_matches();
