ALTER TYPE "public"."account_type" ADD VALUE 'bank' BEFORE 'external';--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE 'transfer';
