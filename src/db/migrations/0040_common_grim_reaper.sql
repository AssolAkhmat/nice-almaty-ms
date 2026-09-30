CREATE TABLE "residency_month_rents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"residency_id" uuid NOT NULL,
	"month" date NOT NULL,
	"amount" bigint NOT NULL,
	"computed_amount" bigint NOT NULL,
	"comment" text NOT NULL,
	"consent_agreed_on" date NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "residency_month_rents_comment_present" CHECK (btrim("residency_month_rents"."comment") <> ''),
	CONSTRAINT "residency_month_rents_amounts_non_negative" CHECK ("residency_month_rents"."amount" >= 0 and "residency_month_rents"."computed_amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "residency_month_rents" ADD CONSTRAINT "residency_month_rents_residency_id_residencies_id_fk" FOREIGN KEY ("residency_id") REFERENCES "public"."residencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "residency_month_rents" ADD CONSTRAINT "residency_month_rents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "residency_month_rents_month_unique" ON "residency_month_rents" USING btree ("residency_id","month");