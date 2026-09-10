CREATE TYPE "public"."rotation_empty_reason" AS ENUM('empty_bed', 'absent', 'not_eligible', 'no_one');--> statement-breakpoint
CREATE TABLE "rotation_day_norm_zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"norm_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"area_id" uuid NOT NULL,
	"checklist_id" uuid NOT NULL,
	"people" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "rotation_day_norm_zones_people_positive" CHECK ("rotation_day_norm_zones"."people" >= 1)
);
--> statement-breakpoint
CREATE TABLE "rotation_day_norms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"row_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rotation_row_roster_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"roster_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"bed_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rotation_row_rosters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"row_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rotation_assignments" ADD COLUMN "empty_reason" "rotation_empty_reason";--> statement-breakpoint
ALTER TABLE "rotation_assignments" ADD COLUMN "queued_user_id" uuid;--> statement-breakpoint
ALTER TABLE "rotation_assignments" ADD COLUMN "write_off_debt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rotation_debts" ADD COLUMN "delta" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "rotation_occurrences" ADD COLUMN "people_needed" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "rotation_rows" ADD COLUMN "room_area_id" uuid;--> statement-breakpoint
ALTER TABLE "rotation_day_norm_zones" ADD CONSTRAINT "rotation_day_norm_zones_norm_id_rotation_day_norms_id_fk" FOREIGN KEY ("norm_id") REFERENCES "public"."rotation_day_norms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_day_norm_zones" ADD CONSTRAINT "rotation_day_norm_zones_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_day_norm_zones" ADD CONSTRAINT "rotation_day_norm_zones_checklist_id_area_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."area_checklists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_day_norms" ADD CONSTRAINT "rotation_day_norms_row_id_rotation_rows_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."rotation_rows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_row_roster_slots" ADD CONSTRAINT "rotation_row_roster_slots_roster_id_rotation_row_rosters_id_fk" FOREIGN KEY ("roster_id") REFERENCES "public"."rotation_row_rosters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_row_roster_slots" ADD CONSTRAINT "rotation_row_roster_slots_bed_id_beds_id_fk" FOREIGN KEY ("bed_id") REFERENCES "public"."beds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_row_rosters" ADD CONSTRAINT "rotation_row_rosters_row_id_rotation_rows_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."rotation_rows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_day_norm_zones_position_unique" ON "rotation_day_norm_zones" USING btree ("norm_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_day_norm_zones_area_unique" ON "rotation_day_norm_zones" USING btree ("norm_id","area_id","checklist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_day_norms_row_date_unique" ON "rotation_day_norms" USING btree ("row_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_row_roster_slots_position_unique" ON "rotation_row_roster_slots" USING btree ("roster_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_row_roster_slots_bed_unique" ON "rotation_row_roster_slots" USING btree ("roster_id","bed_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_row_rosters_row_date_unique" ON "rotation_row_rosters" USING btree ("row_id","effective_from");--> statement-breakpoint
ALTER TABLE "rotation_assignments" ADD CONSTRAINT "rotation_assignments_queued_user_id_users_id_fk" FOREIGN KEY ("queued_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_rows" ADD CONSTRAINT "rotation_rows_room_area_id_areas_id_fk" FOREIGN KEY ("room_area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_rows_common_weekday_unique" ON "rotation_rows" USING btree ("house_id","weekday") WHERE "rotation_rows"."type" = 'common' and "rotation_rows"."is_active";--> statement-breakpoint
/*
 * Дописано руками: старые назначения без исполнителя не помнят причину,
 * а проверка ниже её требует. 'no_one' — единственная причина, которая
 * не утверждает о жильце того, чего мы не знаем: зону никто не убирает.
 * Демо-данные пересобираются в T10.8, на боевой ротаций нет вовсе.
 */
UPDATE "rotation_assignments" SET "empty_reason" = 'no_one' WHERE "user_id" IS NULL AND "empty_reason" IS NULL;--> statement-breakpoint
ALTER TABLE "rotation_assignments" ADD CONSTRAINT "rotation_assignments_empty_has_reason" CHECK (("rotation_assignments"."user_id" is null) = ("rotation_assignments"."empty_reason" is not null));--> statement-breakpoint
ALTER TABLE "rotation_debts" ADD CONSTRAINT "rotation_debts_delta_step" CHECK ("rotation_debts"."delta" in (-1, 1));--> statement-breakpoint
ALTER TABLE "rotation_occurrences" ADD CONSTRAINT "rotation_occurrences_people_positive" CHECK ("rotation_occurrences"."people_needed" >= 1);--> statement-breakpoint
ALTER TABLE "rotation_rows" ADD CONSTRAINT "rotation_rows_room_has_area" CHECK (("rotation_rows"."type" = 'room' and "rotation_rows"."room_area_id" is not null) or ("rotation_rows"."type" <> 'room' and "rotation_rows"."room_area_id" is null));