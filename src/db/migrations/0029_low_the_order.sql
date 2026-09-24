CREATE TABLE "permission_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"allowed" boolean NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "permission_overrides" ADD CONSTRAINT "permission_overrides_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_overrides" ADD CONSTRAINT "permission_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_overrides" ADD CONSTRAINT "permission_overrides_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "permission_overrides_org_idx" ON "permission_overrides" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "permission_overrides_network_unique" ON "permission_overrides" USING btree ("org_id","action") WHERE "permission_overrides"."user_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "permission_overrides_user_unique" ON "permission_overrides" USING btree ("org_id","user_id","action") WHERE "permission_overrides"."user_id" is not null;