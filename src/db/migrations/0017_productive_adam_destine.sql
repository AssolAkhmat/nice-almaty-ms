CREATE TYPE "public"."inventory_audit_status" AS ENUM('draft', 'closed');--> statement-breakpoint
CREATE TYPE "public"."inventory_movement_type" AS ENUM('in', 'out', 'write_off', 'transfer', 'audit_adjust');--> statement-breakpoint
CREATE TYPE "public"."inventory_status" AS ENUM('in_use', 'written_off');--> statement-breakpoint
CREATE TABLE "inventory_audit_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"expected_qty" numeric(12, 2) NOT NULL,
	"actual_qty" numeric(12, 2),
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"house_id" uuid NOT NULL,
	"date" date NOT NULL,
	"status" "inventory_audit_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"house_id" uuid NOT NULL,
	"name" text NOT NULL,
	"qty" numeric(12, 2) DEFAULT '0' NOT NULL,
	"unit" text NOT NULL,
	"unit_cost" bigint DEFAULT 0 NOT NULL,
	"responsible_user_id" uuid,
	"status" "inventory_status" DEFAULT 'in_use' NOT NULL,
	"acquired_at" date,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"type" "inventory_movement_type" NOT NULL,
	"qty" numeric(12, 2) NOT NULL,
	"date" date NOT NULL,
	"from_house_id" uuid,
	"to_house_id" uuid,
	"doc_ref" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_audit_lines" ADD CONSTRAINT "inventory_audit_lines_audit_id_inventory_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."inventory_audits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_audit_lines" ADD CONSTRAINT "inventory_audit_lines_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_audits" ADD CONSTRAINT "inventory_audits_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_audits" ADD CONSTRAINT "inventory_audits_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_audits" ADD CONSTRAINT "inventory_audits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_responsible_user_id_users_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_from_house_id_houses_id_fk" FOREIGN KEY ("from_house_id") REFERENCES "public"."houses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_to_house_id_houses_id_fk" FOREIGN KEY ("to_house_id") REFERENCES "public"."houses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_audit_lines_audit_idx" ON "inventory_audit_lines" USING btree ("audit_id","item_id");--> statement-breakpoint
CREATE INDEX "inventory_audits_house_idx" ON "inventory_audits" USING btree ("house_id","date");--> statement-breakpoint
CREATE INDEX "inventory_items_house_idx" ON "inventory_items" USING btree ("house_id","status");--> statement-breakpoint
CREATE INDEX "inventory_movements_item_idx" ON "inventory_movements" USING btree ("item_id","date");