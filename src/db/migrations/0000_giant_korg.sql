-- Расширение btree_gist нужно ограничению EXCLUDE в фазе 2:
-- одно спальное место не может быть занято двумя проживаниями в пересекающиеся периоды
-- (docs/02-DATA-MODEL.md, bed_assignments).
-- Ставится идемпотентно и не роняет миграцию там, где прав на установку нет:
-- в этом случае остаётся предупреждение, а фаза 2 упрётся в отсутствие расширения явно.
DO $$
BEGIN
	CREATE EXTENSION IF NOT EXISTS btree_gist;
EXCEPTION
	WHEN insufficient_privilege THEN
		RAISE WARNING 'btree_gist не установлен: недостаточно прав. Установите расширение вручную от имени администратора БД до фазы 2.';
END
$$;
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job" text NOT NULL,
	"period_key" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "job_runs_job_period_key_unique" ON "job_runs" USING btree ("job","period_key");