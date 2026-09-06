CREATE TYPE "public"."residency_status" AS ENUM('created', 'profile_pending', 'docs_pending', 'deposit_pending', 'active', 'terminating', 'archived');--> statement-breakpoint
CREATE TABLE "bed_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"residency_id" uuid NOT NULL,
	"bed_id" uuid NOT NULL,
	"price" bigint NOT NULL,
	"period" daterange NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "residencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"house_id" uuid NOT NULL,
	"status" "residency_status" DEFAULT 'created' NOT NULL,
	"contract_start" date,
	"contract_end" date,
	"move_in_date" date,
	"termination_requested_at" timestamp with time zone,
	"move_out_date" date,
	"deposit_due_date" date,
	"deposit_amount" bigint,
	"keys_issued" boolean DEFAULT false NOT NULL,
	"keys_issued_at" timestamp with time zone,
	"contract_signed_at" timestamp with time zone,
	"contract_file_id" uuid,
	"signature_file_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bed_assignments" ADD CONSTRAINT "bed_assignments_residency_id_residencies_id_fk" FOREIGN KEY ("residency_id") REFERENCES "public"."residencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bed_assignments" ADD CONSTRAINT "bed_assignments_bed_id_beds_id_fk" FOREIGN KEY ("bed_id") REFERENCES "public"."beds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bed_assignments" ADD CONSTRAINT "bed_assignments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "residencies" ADD CONSTRAINT "residencies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "residencies" ADD CONSTRAINT "residencies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "residencies" ADD CONSTRAINT "residencies_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bed_assignments_bed_idx" ON "bed_assignments" USING btree ("bed_id");--> statement-breakpoint
CREATE INDEX "bed_assignments_residency_idx" ON "bed_assignments" USING btree ("residency_id");--> statement-breakpoint
CREATE INDEX "residencies_house_status_idx" ON "residencies" USING btree ("house_id","status");--> statement-breakpoint
CREATE INDEX "residencies_user_idx" ON "residencies" USING btree ("user_id");
--> statement-breakpoint
-- Ограничения исключения дописаны руками: drizzle-kit их не выражает.
--
-- В отличие от фазы 0, где отсутствие btree_gist давало предупреждение,
-- здесь оно обязано ронять миграцию: без расширения ограничения не создать,
-- а без них одно место можно занять дважды. Тихо пропустить это нельзя.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
		RAISE EXCEPTION 'Расширение btree_gist не установлено. Без него ограничения занятости мест не создать: выполните CREATE EXTENSION btree_gist от роли с правом CREATE на базе и повторите миграцию';
	END IF;
END
$$;
--> statement-breakpoint
-- Инвариант 1: одно место не занято двумя проживаниями в пересекающиеся периоды.
ALTER TABLE "bed_assignments"
	ADD CONSTRAINT "bed_assignments_bed_period_excl"
	EXCLUDE USING gist ("bed_id" WITH =, "period" WITH &&);
--> statement-breakpoint
-- Инвариант 2: у проживания в любой момент не больше одного места.
-- Смена места закрывает прежний период и открывает новый, а не добавляет второй.
ALTER TABLE "bed_assignments"
	ADD CONSTRAINT "bed_assignments_residency_period_excl"
	EXCLUDE USING gist ("residency_id" WITH =, "period" WITH &&);
