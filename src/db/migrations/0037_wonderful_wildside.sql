CREATE TABLE "temporary_placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"residency_id" uuid NOT NULL,
	"house_id" uuid NOT NULL,
	"bed_id" uuid NOT NULL,
	"period" daterange NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "temporary_placements" ADD CONSTRAINT "temporary_placements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temporary_placements" ADD CONSTRAINT "temporary_placements_residency_id_residencies_id_fk" FOREIGN KEY ("residency_id") REFERENCES "public"."residencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temporary_placements" ADD CONSTRAINT "temporary_placements_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temporary_placements" ADD CONSTRAINT "temporary_placements_bed_id_beds_id_fk" FOREIGN KEY ("bed_id") REFERENCES "public"."beds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temporary_placements" ADD CONSTRAINT "temporary_placements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temporary_placements" ADD CONSTRAINT "temporary_placements_bed_house_fk" FOREIGN KEY ("bed_id","house_id") REFERENCES "public"."beds"("id","house_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "temporary_placements_residency_idx" ON "temporary_placements" USING btree ("residency_id");--> statement-breakpoint
CREATE INDEX "temporary_placements_bed_idx" ON "temporary_placements" USING btree ("bed_id");--> statement-breakpoint
/*
 * Два человека не размещаются временно на одном месте одновременно, и один
 * человек не бывает размещён в двух местах сразу (P1-5, 27 сентября 2026).
 * Тем же приёмом, что у назначений мест и временных жильцов: пересечение
 * отвергает база, а не проверка в сервисе.
 *
 * Назначения мест это ограничение не касается вовсе: расчётное место
 * остаётся за жильцом, и таблица `bed_assignments` при временном размещении
 * не трогается.
 */
ALTER TABLE "temporary_placements"
  ADD CONSTRAINT "temporary_placements_bed_no_overlap"
  EXCLUDE USING gist ("bed_id" WITH =, "period" WITH &&);--> statement-breakpoint
ALTER TABLE "temporary_placements"
  ADD CONSTRAINT "temporary_placements_residency_no_overlap"
  EXCLUDE USING gist ("residency_id" WITH =, "period" WITH &&);
