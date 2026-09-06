-- Закрывает прямой доступ к данным в обход приложения.
--
-- Решение D6: авторизация живёт в приложении, RLS мы намеренно не используем.
-- На Supabase это опасное сочетание: проект по умолчанию отдаёт Data API
-- (PostgREST), а роли anon и authenticated по умолчанию получают права
-- на схему public. Наши таблицы лежат именно там и RLS на них нет.
-- Значит, любой, у кого есть адрес проекта и публикуемый ключ, читал бы
-- и писал данные напрямую, минуя authz.ts целиком.
--
-- Закрывают доступ два действия: отзыв прав на существующие объекты и отзыв
-- прав по умолчанию на будущие. Второе важнее: без него каждая новая таблица
-- в следующих фазах снова открывалась бы, и про это забыли бы.
--
-- USAGE на схему public остаётся: его PostgreSQL выдаёт роли PUBLIC, и сам
-- по себе он ничего не открывает — без прав на таблицы читать нечего.
-- Отзывать его у PUBLIC не станем: это задело бы служебные механизмы Supabase.
--
-- На обычном PostgreSQL ролей anon и authenticated нет, поэтому блок
-- проверяет их существование и там ничего не делает.
DO $$
DECLARE
	target_role text;
BEGIN
	FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
		IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
			EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', target_role);
			EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', target_role);
			EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', target_role);
			EXECUTE format('REVOKE USAGE ON SCHEMA public FROM %I', target_role);
			EXECUTE format(
				'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I',
				target_role
			);
			EXECUTE format(
				'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',
				target_role
			);

			RAISE NOTICE 'Права роли % на схему public отозваны', target_role;
		END IF;
	END LOOP;
END
$$;
