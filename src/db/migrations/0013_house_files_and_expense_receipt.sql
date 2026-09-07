ALTER TABLE "ledger_entries" ADD COLUMN "receipt_file_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "house_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE no action ON UPDATE no action;