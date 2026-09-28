ALTER TABLE "utility_periods" ADD COLUMN "house_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "utility_periods" ADD COLUMN "house_days_comment" text;--> statement-breakpoint
ALTER TABLE "utility_periods" ADD COLUMN "house_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "utility_periods" ADD CONSTRAINT "utility_periods_house_days_non_negative" CHECK ("utility_periods"."house_days" >= 0 and "utility_periods"."house_amount" >= 0);--> statement-breakpoint
ALTER TABLE "utility_periods" ADD CONSTRAINT "utility_periods_house_days_comment" CHECK ("utility_periods"."house_days" = 0 or btrim(coalesce("utility_periods"."house_days_comment", '')) <> '');