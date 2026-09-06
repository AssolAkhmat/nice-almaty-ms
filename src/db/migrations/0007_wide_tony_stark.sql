CREATE TYPE "public"."file_provider" AS ENUM('gdrive', 'local', 'supabase');--> statement-breakpoint
CREATE TYPE "public"."file_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"residency_id" uuid,
	"provider" "file_provider" NOT NULL,
	"external_id" text,
	"path" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"original_name" text NOT NULL,
	"checksum" text,
	"status" "file_status" DEFAULT 'pending' NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_residency_id_residencies_id_fk" FOREIGN KEY ("residency_id") REFERENCES "public"."residencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "files_provider_path_unique" ON "files" USING btree ("provider","path");--> statement-breakpoint
CREATE INDEX "files_residency_idx" ON "files" USING btree ("residency_id");--> statement-breakpoint
CREATE INDEX "files_org_status_idx" ON "files" USING btree ("org_id","status");--> statement-breakpoint
-- Дописано руками. Колонки `contract_file_id` и `signature_file_id` заведены
-- в фазе 2 до появления таблицы `files` (см. [ОТКРЫТО] в docs/08-DECISIONS.md):
-- форму таблицы менять дважды хуже, чем поставить ключи одной миграцией позже.
-- Drizzle об этих ключах не знает, поэтому перегенерация миграций их не тронет —
-- ровно как с ограничениями исключения в 0005.
ALTER TABLE "residencies" ADD CONSTRAINT "residencies_contract_file_id_files_id_fk" FOREIGN KEY ("contract_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "residencies" ADD CONSTRAINT "residencies_signature_file_id_files_id_fk" FOREIGN KEY ("signature_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;
