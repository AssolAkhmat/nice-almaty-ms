ALTER TYPE "public"."rotation_assignment_state" ADD VALUE 'unconfirmed' BEFORE 'cancelled';
--> statement-breakpoint
CREATE TABLE "temporary_residents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"house_id" uuid NOT NULL,
	"bed_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sex" "sex" NOT NULL,
	"period" daterange NOT NULL,
	"note" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "beds_id_house_unique" ON "beds" USING btree ("id","house_id");
--> statement-breakpoint
ALTER TABLE "temporary_residents" ADD CONSTRAINT "temporary_residents_bed_house_fk" FOREIGN KEY ("bed_id","house_id") REFERENCES "public"."beds"("id","house_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rotation_assignments" DROP CONSTRAINT "rotation_assignments_empty_has_reason";
--> statement-breakpoint
ALTER TABLE "rotation_assignments" ADD COLUMN "temporary_resident_id" uuid;
--> statement-breakpoint
ALTER TABLE "rotation_assignments" ADD COLUMN "queued_temporary_resident_id" uuid;
--> statement-breakpoint
ALTER TABLE "temporary_residents" ADD CONSTRAINT "temporary_residents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "temporary_residents" ADD CONSTRAINT "temporary_residents_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "temporary_residents" ADD CONSTRAINT "temporary_residents_bed_id_beds_id_fk" FOREIGN KEY ("bed_id") REFERENCES "public"."beds"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "temporary_residents" ADD CONSTRAINT "temporary_residents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "temporary_residents" ADD CONSTRAINT "temporary_residents_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "temporary_residents_house_idx" ON "temporary_residents" USING btree ("house_id");
--> statement-breakpoint
CREATE INDEX "temporary_residents_bed_idx" ON "temporary_residents" USING btree ("bed_id");
--> statement-breakpoint
ALTER TABLE "rotation_assignments" ADD CONSTRAINT "rotation_assignments_temporary_resident_id_temporary_residents_id_fk" FOREIGN KEY ("temporary_resident_id") REFERENCES "public"."temporary_residents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rotation_assignments" ADD CONSTRAINT "rotation_assignments_queued_temporary_resident_id_temporary_residents_id_fk" FOREIGN KEY ("queued_temporary_resident_id") REFERENCES "public"."temporary_residents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rotation_assignments" ADD CONSTRAINT "rotation_assignments_single_executor" CHECK (not ("rotation_assignments"."user_id" is not null and "rotation_assignments"."temporary_resident_id" is not null));
--> statement-breakpoint
ALTER TABLE "rotation_assignments" ADD CONSTRAINT "rotation_assignments_empty_has_reason" CHECK (("rotation_assignments"."user_id" is null and "rotation_assignments"."temporary_resident_id" is null) = ("rotation_assignments"."empty_reason" is not null));
--> statement-breakpoint
-- Рукописная часть: drizzle-kit не выражает ни ограничений исключения,
-- ни межтабличных запретов.
--
-- Инвариант 1: на одном месте не бывает двух временных жильцов
-- в пересекающиеся дни — та же защита, что у настоящих проживаний.
ALTER TABLE "temporary_residents"
	ADD CONSTRAINT "temporary_residents_bed_period_excl"
	EXCLUDE USING gist ("bed_id" WITH =, "period" WITH &&);
--> statement-breakpoint
-- Инвариант 2: место не может быть одновременно за временным жильцом
-- и за настоящим проживанием (указание владельца, 21 сентября 2026).
--
-- Межтабличный EXCLUDE в PostgreSQL невозможен, поэтому запрет держат два
-- триггера — по одному с каждой стороны. Проверка в сервисе тут не годится:
-- она защищает только тот путь, который через сервис и проходит.
--
-- Код ошибки 23P01 (нарушение исключения) выбран намеренно: по смыслу это
-- то же самое, что и EXCLUDE выше, и тесты опознают обе защиты одинаково.
CREATE OR REPLACE FUNCTION "temporary_resident_bed_is_free"() RETURNS trigger AS $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "bed_assignments"
		WHERE "bed_assignments"."bed_id" = NEW."bed_id"
			AND "bed_assignments"."period" && NEW."period"
	) THEN
		RAISE EXCEPTION 'temporary_residents_bed_taken: место занято проживанием в эти дни'
			USING ERRCODE = '23P01';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "temporary_residents_bed_is_free"
	BEFORE INSERT OR UPDATE OF "bed_id", "period" ON "temporary_residents"
	FOR EACH ROW EXECUTE FUNCTION "temporary_resident_bed_is_free"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "bed_assignment_has_no_temporary"() RETURNS trigger AS $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "temporary_residents"
		WHERE "temporary_residents"."bed_id" = NEW."bed_id"
			AND "temporary_residents"."period" && NEW."period"
	) THEN
		RAISE EXCEPTION 'bed_assignments_temporary_taken: на это место заведён временный жилец в эти дни'
			USING ERRCODE = '23P01';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "bed_assignments_has_no_temporary"
	BEFORE INSERT OR UPDATE OF "bed_id", "period" ON "bed_assignments"
	FOR EACH ROW EXECUTE FUNCTION "bed_assignment_has_no_temporary"();
