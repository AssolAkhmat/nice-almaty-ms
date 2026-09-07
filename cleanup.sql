-- Очистка базы от демо-сида (docs/OWNER-NOTES.md, раздел 2).
--
-- Схема, индексы и учёт миграций не затрагиваются: таблица миграций лежит
-- в схеме drizzle, а не в public.
--
-- Запуск: psql "<строка подключения>" -f cleanup.sql
--
-- ON_ERROR_STOP — команда psql, а не SQL: без неё psql после ошибки доделывает
-- остаток файла. Вместе с begin/commit это значит, что неудачная очистка
-- не оставляет базу разобранной наполовину: не сделано вообще ничего.
\set ON_ERROR_STOP on

begin;

-- 1. Данные: все таблицы схемы public, кроме скелета сети.
do $$
declare
  -- По одному имени в строке намеренно: потерянная строка видна глазом.
  keep constant text[] := array[
    'organizations',
    'houses',
    'users',
    'accounts',
    'document_types',
    'contract_templates'
  ];
  expected constant integer := 6;
  absent text[];
  list text;
  tbl text;
  rows_now bigint;
  before_counts jsonb := '{}'::jsonb;
  lost text;
begin
  -- Проверка первая: список не урезан.
  if coalesce(array_length(keep, 1), 0) <> expected then
    raise exception 'Список сохраняемых таблиц урезан: % имён вместо %. Очистка отменена.',
      coalesce(array_length(keep, 1), 0), expected;
  end if;

  -- Проверка вторая: все имена действительно существуют в схеме.
  select array_agg(name order by name)
    into absent
    from unnest(keep) as name
   where not exists (
     select 1 from pg_tables where schemaname = 'public' and tablename = name
   );

  if absent is not null then
    raise exception 'В схеме public нет таблиц: %. Имя изменилось или база не та — очистка отменена.',
      absent;
  end if;

  -- Снимок до очистки. Проверки выше отвечают за список; этот снимок отвечает
  -- за результат и не зависит от причины: что бы ни увело строки из сохраняемой
  -- таблицы — список, каскад, триггер, — расхождение будет видно ниже.
  foreach tbl in array keep loop
    execute format('select count(*) from public.%I', tbl) into rows_now;
    before_counts := before_counts || jsonb_build_object(tbl, rows_now);
  end loop;

  select string_agg(format('public.%I', tablename), ', ' order by tablename)
    into list
    from pg_tables
   where schemaname = 'public'
     and tablename <> all (keep);

  raise notice 'Очищаются таблицы: %', list;

  execute format('truncate table %s restart identity', list);

  -- Проверка третья: сохраняемые таблицы после очистки не похудели.
  foreach tbl in array keep loop
    execute format('select count(*) from public.%I', tbl) into rows_now;

    if rows_now < (before_counts ->> tbl)::bigint then
      lost := concat_ws('; ', lost,
        format('%s: было %s, стало %s', tbl, before_counts ->> tbl, rows_now));
    end if;
  end loop;

  if lost is not null then
    raise exception 'Очистка задела скелет сети (%). Транзакция откачена, база не изменена.',
      lost;
  end if;
end
$$;

-- 2. Демо-дома, их админы и фонды домов. Порядок продиктован внешними ключами:
--    все они объявлены on delete no action, каскада нет ни одного.
--
--    house_id у админов не обнуляется: проверка users_admin_has_house требует
--    дома у роли admin, и обнуление её нарушает. Шаг был и лишним — админы
--    уходят целыми строками прямо здесь.
delete from users where phone <> '+77010000000';
delete from accounts where house_id is not null;
delete from houses;

-- 3. Итоговая проверка перед commit: сеть должна остаться пригодной к работе.
--    Экранов у типов документов, шаблона договора и счетов сети нет (модули 10
--    и 11), поэтому пустыми они остаться не могут — их неоткуда завести, кроме
--    `pnpm db:seed --skeleton`.
do $$
declare
  types integer;
  templates integer;
  network integer;
  people integer;
begin
  select count(*) into types from document_types;
  select count(*) into templates from contract_templates;
  select count(*) into network from accounts where house_id is null;
  select count(*) into people from users;

  if types = 0 or templates = 0 or network = 0 or people = 0 then
    raise exception
      'После очистки скелет сети пуст: типов документов %, шаблонов %, счетов сети %, учётных записей %. Транзакция откачена. Если их не было и до очистки, сперва восстановите скелет: pnpm db:seed --skeleton',
      types, templates, network, people;
  end if;
end
$$;

commit;

-- 4. Отчёт: ожидаемые числа в комментариях.
select
  (select count(*) from houses)             as houses,          -- 0
  (select count(*) from users)              as users,           -- 1
  (select count(*) from organizations)      as organizations,   -- 1
  (select count(*) from accounts)           as accounts,        -- 5
  (select count(*) from document_types)     as document_types,  -- 3
  (select count(*) from contract_templates) as templates,       -- 1
  (select count(*) from residencies)        as residencies;     -- 0
