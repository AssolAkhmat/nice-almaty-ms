CREATE TYPE "public"."account_type" AS ENUM('deposit_fund', 'house_fund', 'utility_fund', 'common_fund', 'cash', 'kaspi', 'external');--> statement-breakpoint
CREATE TYPE "public"."ledger_direction" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."damage_split_mode" AS ENUM('single', 'room', 'all', 'all_except', 'custom');--> statement-breakpoint
CREATE TYPE "public"."utility_period_status" AS ENUM('draft', 'closed');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"house_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "account_type" NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"description" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"reversed_by_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"direction" "ledger_direction" NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "damage_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"damage_id" uuid NOT NULL,
	"residency_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "damages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"house_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"amount" bigint NOT NULL,
	"receipt_file_id" uuid,
	"split_mode" "damage_split_mode" NOT NULL,
	"split_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"surplus" bigint DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "utility_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"days" integer NOT NULL,
	"amount" bigint NOT NULL,
	"invoice_line_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "utility_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_id" uuid NOT NULL,
	"title" text NOT NULL,
	"amount" bigint NOT NULL,
	"receipt_file_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "utility_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"house_id" uuid NOT NULL,
	"month" date NOT NULL,
	"status" "utility_period_status" DEFAULT 'draft' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_lines" ADD CONSTRAINT "ledger_lines_entry_id_ledger_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_lines" ADD CONSTRAINT "ledger_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "damage_shares" ADD CONSTRAINT "damage_shares_damage_id_damages_id_fk" FOREIGN KEY ("damage_id") REFERENCES "public"."damages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "damage_shares" ADD CONSTRAINT "damage_shares_residency_id_residencies_id_fk" FOREIGN KEY ("residency_id") REFERENCES "public"."residencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "damage_shares" ADD CONSTRAINT "damage_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "damages" ADD CONSTRAINT "damages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "damages" ADD CONSTRAINT "damages_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "damages" ADD CONSTRAINT "damages_receipt_file_id_files_id_fk" FOREIGN KEY ("receipt_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "damages" ADD CONSTRAINT "damages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "damages" ADD CONSTRAINT "damages_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utility_allocations" ADD CONSTRAINT "utility_allocations_period_id_utility_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."utility_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utility_allocations" ADD CONSTRAINT "utility_allocations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utility_allocations" ADD CONSTRAINT "utility_allocations_invoice_line_id_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."invoice_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utility_lines" ADD CONSTRAINT "utility_lines_period_id_utility_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."utility_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utility_lines" ADD CONSTRAINT "utility_lines_receipt_file_id_files_id_fk" FOREIGN KEY ("receipt_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utility_periods" ADD CONSTRAINT "utility_periods_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utility_periods" ADD CONSTRAINT "utility_periods_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utility_periods" ADD CONSTRAINT "utility_periods_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_org_code_unique" ON "accounts" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "accounts_house_idx" ON "accounts" USING btree ("house_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_org_date_idx" ON "ledger_entries" USING btree ("org_id","entry_date");--> statement-breakpoint
CREATE INDEX "ledger_entries_source_idx" ON "ledger_entries" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "ledger_lines_entry_idx" ON "ledger_lines" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "ledger_lines_account_idx" ON "ledger_lines" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "damage_shares_damage_residency_unique" ON "damage_shares" USING btree ("damage_id","residency_id");--> statement-breakpoint
CREATE INDEX "damages_house_idx" ON "damages" USING btree ("house_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "utility_allocations_period_user_unique" ON "utility_allocations" USING btree ("period_id","user_id");--> statement-breakpoint
CREATE INDEX "utility_lines_period_idx" ON "utility_lines" USING btree ("period_id");--> statement-breakpoint
CREATE UNIQUE INDEX "utility_periods_house_month_unique" ON "utility_periods" USING btree ("house_id","month");