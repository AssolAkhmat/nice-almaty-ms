CREATE TYPE "public"."absence_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."absence_type" AS ENUM('short', 'long', 'sick');--> statement-breakpoint
CREATE TYPE "public"."discount_status" AS ENUM('proposed', 'approved', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."fine_status" AS ENUM('pending', 'applied', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."rating_rule_kind" AS ENUM('score_delta', 'admin_action', 'threshold_down', 'threshold_up');--> statement-breakpoint
CREATE TABLE "absences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"house_id" uuid NOT NULL,
	"type" "absence_type" NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"start_at" timestamp with time zone,
	"reason" text NOT NULL,
	"status" "absence_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"doc_file_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"rule_id" uuid NOT NULL,
	"status" "discount_status" DEFAULT 'proposed' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"house_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"rule_id" uuid,
	"reason" text NOT NULL,
	"status" "fine_status" DEFAULT 'pending' NOT NULL,
	"invoice_id" uuid,
	"cancelled_by" uuid,
	"cancelled_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rating_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"delta" integer NOT NULL,
	"ref_type" text,
	"ref_id" uuid,
	"note" text,
	"created_by" uuid,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"period_start" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rating_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"house_id" uuid,
	"kind" "rating_rule_kind" NOT NULL,
	"code" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rating_threshold_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"armed" boolean DEFAULT true NOT NULL,
	"last_triggered_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "absences" ADD CONSTRAINT "absences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absences" ADD CONSTRAINT "absences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absences" ADD CONSTRAINT "absences_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absences" ADD CONSTRAINT "absences_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absences" ADD CONSTRAINT "absences_doc_file_id_files_id_fk" FOREIGN KEY ("doc_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_rule_id_rating_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rating_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fines" ADD CONSTRAINT "fines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fines" ADD CONSTRAINT "fines_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fines" ADD CONSTRAINT "fines_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fines" ADD CONSTRAINT "fines_rule_id_rating_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rating_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fines" ADD CONSTRAINT "fines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fines" ADD CONSTRAINT "fines_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fines" ADD CONSTRAINT "fines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_events" ADD CONSTRAINT "rating_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_events" ADD CONSTRAINT "rating_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_events" ADD CONSTRAINT "rating_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_rules" ADD CONSTRAINT "rating_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_rules" ADD CONSTRAINT "rating_rules_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_threshold_states" ADD CONSTRAINT "rating_threshold_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_threshold_states" ADD CONSTRAINT "rating_threshold_states_rule_id_rating_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rating_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "absences_house_idx" ON "absences" USING btree ("house_id","start_date");--> statement-breakpoint
CREATE INDEX "absences_user_idx" ON "absences" USING btree ("user_id","start_date");--> statement-breakpoint
CREATE INDEX "absences_status_idx" ON "absences" USING btree ("house_id","status");--> statement-breakpoint
CREATE INDEX "discounts_user_idx" ON "discounts" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "discounts_open_unique" ON "discounts" USING btree ("user_id","rule_id") WHERE "discounts"."status" <> 'revoked';--> statement-breakpoint
CREATE INDEX "fines_user_idx" ON "fines" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "rating_events_user_idx" ON "rating_events" USING btree ("user_id","period_start","effective_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rating_events_ref_unique" ON "rating_events" USING btree ("user_id","ref_type","ref_id") WHERE "rating_events"."ref_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "rating_rules_network_code_unique" ON "rating_rules" USING btree ("org_id","code") WHERE "rating_rules"."house_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "rating_rules_house_code_unique" ON "rating_rules" USING btree ("org_id","house_id","code") WHERE "rating_rules"."house_id" is not null;--> statement-breakpoint
CREATE INDEX "rating_rules_org_idx" ON "rating_rules" USING btree ("org_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "rating_threshold_states_unique" ON "rating_threshold_states" USING btree ("user_id","rule_id");