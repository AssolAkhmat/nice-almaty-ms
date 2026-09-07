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
  keep constant text[] := array[
    'organizations', 'houses', 'users', 'accounts', 'document_types', 'contract_templates'
  ];
  list text;
begin
  select string_agg(format('public.%I', tablename), ', ')
    into list
    from pg_tables
   where schemaname = 'public'
     and tablename <> all (keep);

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
