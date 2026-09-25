CREATE TYPE "public"."profile_field_type" AS ENUM('text', 'number', 'date', 'boolean', 'choice');--> statement-breakpoint
CREATE TABLE "profile_field_defs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name_i18n" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"type" "profile_field_type" NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_field_defs_code_shape" CHECK ("profile_field_defs"."code" ~ '^[a-z][a-z0-9_]{0,38}$'),
	CONSTRAINT "profile_field_defs_name_object" CHECK (jsonb_typeof("profile_field_defs"."name_i18n") = 'object'),
	CONSTRAINT "profile_field_defs_options_shape" CHECK (jsonb_typeof("profile_field_defs"."options") = 'array' and case when "profile_field_defs"."type" = 'choice' then jsonb_array_length("profile_field_defs"."options") > 0 else jsonb_array_length("profile_field_defs"."options") = 0 end)
);--> statement-breakpoint
CREATE TABLE "profile_field_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "profile_field_defs" ADD CONSTRAINT "profile_field_defs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_field_values" ADD CONSTRAINT "profile_field_values_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "profile_field_defs_org_code_unique" ON "profile_field_defs" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "profile_field_defs_org_idx" ON "profile_field_defs" USING btree ("org_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_field_values_user_field_unique" ON "profile_field_values" USING btree ("user_id","field_id");--> statement-breakpoint
CREATE INDEX "profile_field_values_field_idx" ON "profile_field_values" USING btree ("field_id","value");--> statement-breakpoint
/*
 * Значение соответствует объявлению поля, и база проверяет это сама.
 *
 * Пять типов объявляются данными, а значение хранится текстом: без этой
 * проверки в поле «дата выпуска» легла бы строка «скоро», договор напечатал
 * бы её, и узналось бы это от жильца. Здесь же отвергается запись в
 * архивированное поле: читать прежнее значение можно всегда — на него
 * ссылаются подписанные договоры, — а дописывать новое нельзя.
 *
 * Проверка стоит в базе, а не только в сервисе, потому что «сервис проверяет»
 * держится на том, что мимо сервиса никто не ходит, а это не проверено ничем.
 */
CREATE OR REPLACE FUNCTION profile_field_value_matches_def() RETURNS trigger AS $$
DECLARE
  def profile_field_defs;
BEGIN
  SELECT * INTO def FROM profile_field_defs WHERE id = NEW.field_id;

  IF def.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'поле % архивировано: новое значение не записывается', def.code
      USING ERRCODE = '23514';
  END IF;

  IF def.type = 'number' AND NEW.value !~ '^-?[0-9]+(\.[0-9]+)?$' THEN
    RAISE EXCEPTION 'поле % объявлено числом, значение %', def.code, NEW.value
      USING ERRCODE = '23514';
  END IF;

  IF def.type = 'date' THEN
    IF NEW.value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'поле % объявлено датой, значение %', def.code, NEW.value
        USING ERRCODE = '23514';
    END IF;

    BEGIN
      PERFORM NEW.value::date;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'поле % объявлено датой, такой даты нет: %', def.code, NEW.value
          USING ERRCODE = '23514';
    END;
  END IF;

  IF def.type = 'boolean' AND NEW.value NOT IN ('true', 'false') THEN
    RAISE EXCEPTION 'поле % объявлено да/нет, значение %', def.code, NEW.value
      USING ERRCODE = '23514';
  END IF;

  IF def.type = 'choice' AND NOT (def.options ? NEW.value) THEN
    RAISE EXCEPTION 'поле % не имеет варианта %', def.code, NEW.value
      USING ERRCODE = '23514';
  END IF;

  IF btrim(NEW.value) = '' THEN
    RAISE EXCEPTION 'поле %: пустое значение не хранится, строка удаляется', def.code
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER profile_field_values_match_def
  BEFORE INSERT OR UPDATE OF value, field_id ON profile_field_values
  FOR EACH ROW EXECUTE FUNCTION profile_field_value_matches_def();--> statement-breakpoint
/*
 * Порядок отличается от того, что выдал генератор: уникальные индексы
 * `(id, org_id)` стоят раньше составных внешних ключей, которые на них
 * опираются. Генератор ставит ключи первыми, и миграция падает на чистой
 * базе с «there is no unique constraint matching given keys» — проверено
 * прогоном на тестовой базе, а не предположено.
 */
CREATE UNIQUE INDEX "profile_field_defs_id_org_unique" ON "profile_field_defs" USING btree ("id","org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_id_org_unique" ON "users" USING btree ("id","org_id");--> statement-breakpoint
ALTER TABLE "profile_field_values" ADD CONSTRAINT "profile_field_values_field_org_fk" FOREIGN KEY ("field_id","org_id") REFERENCES "public"."profile_field_defs"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_field_values" ADD CONSTRAINT "profile_field_values_user_org_fk" FOREIGN KEY ("user_id","org_id") REFERENCES "public"."users"("id","org_id") ON DELETE no action ON UPDATE no action;
