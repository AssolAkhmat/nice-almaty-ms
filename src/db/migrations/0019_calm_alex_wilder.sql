ALTER TABLE "residencies" ADD COLUMN "contract_number" text;--> statement-breakpoint
ALTER TABLE "resident_profiles" ADD COLUMN "id_doc_issuer" text DEFAULT 'МВД РК';--> statement-breakpoint
ALTER TABLE "resident_profiles" ADD COLUMN "registration_address" text;--> statement-breakpoint
CREATE UNIQUE INDEX "residencies_org_contract_number_unique" ON "residencies" USING btree ("org_id","contract_number");