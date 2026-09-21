ALTER TABLE "inventory_items" ADD COLUMN "area_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX "areas_id_house_unique" ON "areas" USING btree ("id","house_id");
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_area_house_fk" FOREIGN KEY ("area_id","house_id") REFERENCES "public"."areas"("id","house_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "inventory_items_area_idx" ON "inventory_items" USING btree ("area_id");