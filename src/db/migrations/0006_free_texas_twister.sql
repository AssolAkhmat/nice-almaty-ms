CREATE TYPE "public"."preferred_payment" AS ENUM('kaspi', 'cash');--> statement-breakpoint
CREATE TYPE "public"."sex" AS ENUM('male', 'female');--> statement-breakpoint
CREATE TABLE "resident_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"last_name" text,
	"first_name" text,
	"middle_name" text,
	"sex" "sex",
	"birth_date" date,
	"phone" text,
	"id_doc_number_enc" "bytea",
	"id_doc_last4" text,
	"iin_enc" "bytea",
	"iin_last4" text,
	"university" text,
	"course" integer,
	"major" text,
	"emergency_name" text,
	"emergency_phone" text,
	"emergency_relation" text,
	"preferred_payment" "preferred_payment",
	"photo_file_id" uuid,
	"no_epilepsy" boolean,
	"no_asthma" boolean,
	"health_declared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resident_profiles" ADD CONSTRAINT "resident_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;