ALTER TABLE "rotation_debts" DROP CONSTRAINT "rotation_debts_resolved_by_assignment_id_rotation_assignments_id_fk";
--> statement-breakpoint
ALTER TABLE "rotation_debts" DROP COLUMN "resolved_by_assignment_id";