CREATE TYPE "public"."checklist_type" AS ENUM('regular', 'general');--> statement-breakpoint
CREATE TYPE "public"."rotation_assignment_source" AS ENUM('auto', 'manual', 'debt');--> statement-breakpoint
CREATE TYPE "public"."rotation_assignment_state" AS ENUM('assigned', 'needs_reassignment', 'confirmed', 'missed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."rotation_occurrence_type" AS ENUM('regular', 'room', 'general', 'extra');--> statement-breakpoint
CREATE TYPE "public"."rotation_row_type" AS ENUM('common', 'room');--> statement-breakpoint
CREATE TYPE "public"."rotation_status" AS ENUM('scheduled', 'done', 'missed', 'cancelled');--> statement-breakpoint
CREATE TABLE "area_checklists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"area_id" uuid NOT NULL,
	"type" "checklist_type" NOT NULL,
	"title" text NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"people_needed" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "area_eligibility" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"area_id" uuid NOT NULL,
	"checklist_type" "checklist_type" NOT NULL,
	"group_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eligibility_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"house_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rule" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rotation_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"user_id" uuid,
	"slot_position" integer,
	"source" "rotation_assignment_source" DEFAULT 'auto' NOT NULL,
	"state" "rotation_assignment_state" DEFAULT 'assigned' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"confirmed_by" uuid,
	"score" integer,
	"scored_by" uuid,
	"scored_at" timestamp with time zone,
	"photo_file_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rotation_debts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"source_assignment_id" uuid,
	"resolved_by_assignment_id" uuid,
	"expires_at" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rotation_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"house_id" uuid NOT NULL,
	"row_id" uuid,
	"area_id" uuid NOT NULL,
	"checklist_id" uuid NOT NULL,
	"date" date NOT NULL,
	"type" "rotation_occurrence_type" NOT NULL,
	"status" "rotation_status" DEFAULT 'scheduled' NOT NULL,
	"moved_from_date" date,
	"cycle_index" integer,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rotation_row_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"row_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"bed_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rotation_row_zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"row_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"area_id" uuid NOT NULL,
	"checklist_id" uuid NOT NULL,
	"people_needed" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rotation_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"house_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "rotation_row_type" NOT NULL,
	"weekday" integer NOT NULL,
	"start_date" date NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rotation_templates_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"house_id" uuid NOT NULL,
	"type" "checklist_type" NOT NULL,
	"header_i18n" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"footer_i18n" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "area_checklists" ADD CONSTRAINT "area_checklists_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "area_eligibility" ADD CONSTRAINT "area_eligibility_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "area_eligibility" ADD CONSTRAINT "area_eligibility_group_id_eligibility_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."eligibility_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eligibility_groups" ADD CONSTRAINT "eligibility_groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eligibility_groups" ADD CONSTRAINT "eligibility_groups_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_assignments" ADD CONSTRAINT "rotation_assignments_occurrence_id_rotation_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."rotation_occurrences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_assignments" ADD CONSTRAINT "rotation_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_assignments" ADD CONSTRAINT "rotation_assignments_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_assignments" ADD CONSTRAINT "rotation_assignments_scored_by_users_id_fk" FOREIGN KEY ("scored_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_debts" ADD CONSTRAINT "rotation_debts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_debts" ADD CONSTRAINT "rotation_debts_source_assignment_id_rotation_assignments_id_fk" FOREIGN KEY ("source_assignment_id") REFERENCES "public"."rotation_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_debts" ADD CONSTRAINT "rotation_debts_resolved_by_assignment_id_rotation_assignments_id_fk" FOREIGN KEY ("resolved_by_assignment_id") REFERENCES "public"."rotation_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_occurrences" ADD CONSTRAINT "rotation_occurrences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_occurrences" ADD CONSTRAINT "rotation_occurrences_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_occurrences" ADD CONSTRAINT "rotation_occurrences_row_id_rotation_rows_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."rotation_rows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_occurrences" ADD CONSTRAINT "rotation_occurrences_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_occurrences" ADD CONSTRAINT "rotation_occurrences_checklist_id_area_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."area_checklists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_occurrences" ADD CONSTRAINT "rotation_occurrences_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_row_slots" ADD CONSTRAINT "rotation_row_slots_row_id_rotation_rows_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."rotation_rows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_row_slots" ADD CONSTRAINT "rotation_row_slots_bed_id_beds_id_fk" FOREIGN KEY ("bed_id") REFERENCES "public"."beds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_row_zones" ADD CONSTRAINT "rotation_row_zones_row_id_rotation_rows_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."rotation_rows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_row_zones" ADD CONSTRAINT "rotation_row_zones_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_row_zones" ADD CONSTRAINT "rotation_row_zones_checklist_id_area_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."area_checklists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_rows" ADD CONSTRAINT "rotation_rows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_rows" ADD CONSTRAINT "rotation_rows_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_templates_settings" ADD CONSTRAINT "rotation_templates_settings_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "area_checklists_area_type_unique" ON "area_checklists" USING btree ("area_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "area_eligibility_unique" ON "area_eligibility" USING btree ("area_id","checklist_type","group_id");--> statement-breakpoint
CREATE INDEX "eligibility_groups_house_idx" ON "eligibility_groups" USING btree ("house_id","name");--> statement-breakpoint
CREATE INDEX "rotation_assignments_occurrence_idx" ON "rotation_assignments" USING btree ("occurrence_id");--> statement-breakpoint
CREATE INDEX "rotation_assignments_user_idx" ON "rotation_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "rotation_debts_user_idx" ON "rotation_debts" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "rotation_occurrences_house_date_idx" ON "rotation_occurrences" USING btree ("house_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_occurrences_row_area_date_unique" ON "rotation_occurrences" USING btree ("row_id","area_id","date") WHERE "rotation_occurrences"."row_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_row_slots_position_unique" ON "rotation_row_slots" USING btree ("row_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_row_slots_bed_unique" ON "rotation_row_slots" USING btree ("row_id","bed_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_row_zones_position_unique" ON "rotation_row_zones" USING btree ("row_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_row_zones_area_unique" ON "rotation_row_zones" USING btree ("row_id","area_id","checklist_id");--> statement-breakpoint
CREATE INDEX "rotation_rows_house_idx" ON "rotation_rows" USING btree ("house_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_templates_house_type_unique" ON "rotation_templates_settings" USING btree ("house_id","type");