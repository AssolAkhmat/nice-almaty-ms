CREATE TYPE "public"."deposit_transaction_type" AS ENUM('charge', 'damage_share', 'damage_reversal', 'refund', 'burn', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."invoice_line_kind" AS ENUM('rent', 'utilities', 'fine', 'damage_carryover', 'extra', 'deposit', 'discount', 'proration');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('pending', 'issued', 'partially_paid', 'paid', 'cancelled', 'returned', 'burned');--> statement-breakpoint
CREATE TYPE "public"."invoice_type" AS ENUM('deposit', 'monthly', 'extra', 'deposit_refund');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('kaspi', 'cash');--> statement-breakpoint
CREATE TABLE "deposit_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"residency_id" uuid NOT NULL,
	"type" "deposit_transaction_type" NOT NULL,
	"amount" bigint NOT NULL,
	"ref_type" text,
	"ref_id" uuid,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"kind" "invoice_line_kind" NOT NULL,
	"title" text NOT NULL,
	"amount" bigint NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"house_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"residency_id" uuid NOT NULL,
	"type" "invoice_type" NOT NULL,
	"period_month" date,
	"status" "invoice_status" DEFAULT 'issued' NOT NULL,
	"total" bigint NOT NULL,
	"issued_at" timestamp with time zone,
	"due_date" date,
	"remote_sent_at" timestamp with time zone,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"method" "payment_method" NOT NULL,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deposit_transactions" ADD CONSTRAINT "deposit_transactions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_transactions" ADD CONSTRAINT "deposit_transactions_residency_id_residencies_id_fk" FOREIGN KEY ("residency_id") REFERENCES "public"."residencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_transactions" ADD CONSTRAINT "deposit_transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_residency_id_residencies_id_fk" FOREIGN KEY ("residency_id") REFERENCES "public"."residencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deposit_transactions_residency_idx" ON "deposit_transactions" USING btree ("residency_id","created_at");--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_idx" ON "invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoices_residency_idx" ON "invoices" USING btree ("residency_id");--> statement-breakpoint
CREATE INDEX "invoices_house_status_idx" ON "invoices" USING btree ("house_id","status");--> statement-breakpoint
CREATE INDEX "payments_invoice_idx" ON "payments" USING btree ("invoice_id");