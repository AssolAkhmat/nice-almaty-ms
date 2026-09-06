CREATE TYPE "public"."user_theme" AS ENUM('light', 'dark', 'system');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "theme" "user_theme" DEFAULT 'system' NOT NULL;