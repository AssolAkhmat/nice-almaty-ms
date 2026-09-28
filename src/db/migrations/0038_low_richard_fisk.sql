CREATE TABLE "utility_day_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"system_days" integer NOT NULL,
	"days" integer NOT NULL,
	"comment" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "utility_day_adjustments_comment_present" CHECK (btrim("utility_day_adjustments"."comment") <> ''),
	CONSTRAINT "utility_day_adjustments_days_non_negative" CHECK ("utility_day_adjustments"."days" >= 0 and "utility_day_adjustments"."system_days" >= 0)
);
--> statement-breakpoint
ALTER TABLE "utility_day_adjustments" ADD CONSTRAINT "utility_day_adjustments_period_id_utility_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."utility_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utility_day_adjustments" ADD CONSTRAINT "utility_day_adjustments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utility_day_adjustments" ADD CONSTRAINT "utility_day_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "utility_day_adjustments_user_unique" ON "utility_day_adjustments" USING btree ("period_id","user_id");