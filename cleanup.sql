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
  -- По одному имени в строке намеренно. Список — единственное, что стоит между
  -- скелетом сети и truncate: 8 сентября 2026 он потерял хвост при переносе,
  -- остался «organizations, houses, users» — и счета, типы документов и шаблон
  -- договора на боевой базе были стёрты. Урезанный массив остаётся правильным
  -- SQL, поэтому ниже он проверяется явно, а не принимается на веру.
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
begin
  if coalesce(array_length(keep, 1), 0) <> expected then
    raise exception 'Список сохраняемых таблиц урезан: % имён вместо %. Очистка отменена.',
      coalesce(array_length(keep, 1), 0), expected;
  end if;

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

  select string_agg(format('public.%I', tablename), ', ' order by tablename)
    into list
    from pg_tables
   where schemaname = 'public'
     and tablename <> all (keep);

  raise notice 'Очищаются таблицы: %', list;

  execute format('truncate table %s restart identity', list);
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

commit;

-- 3. Отчёт: ожидаемые числа в комментариях.
select
  (select count(*) from houses)             as houses,          -- 0
  (select count(*) from users)              as users,           -- 1
  (select count(*) from organizations)      as organizations,   -- 1
  (select count(*) from accounts)           as accounts,        -- 5
  (select count(*) from document_types)     as document_types,  -- 3
  (select count(*) from contract_templates) as templates,       -- 1
  (select count(*) from residencies)        as residencies;     -- 0
