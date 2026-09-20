#!/usr/bin/env bash
#
# Бэкап базы: дамп, проверка восстановления, шифрование, выгрузка на Drive
# и ротация старых копий (docs/BACKUP.md).
#
# Запускается из cron хоста в 22:30 UTC — это 03:30 по Алматы, переходов
# на летнее время там нет. Ставить CRON_TZ незачем: смещение постоянное.
#
# set -e   — падаем на первой ошибке;
# set -u   — необъявленная переменная это ошибка, а не пустая строка;
# pipefail — код возврата конвейера берётся от упавшей команды.
# Последнее здесь главное: `pg_dump | ...` с упавшим дампом иначе выглядел бы
# успешным прогоном, а на Drive уехал бы обрезанный файл.
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$REPO"

WORK_DIR=${BACKUP_WORK_DIR:-/var/tmp/nice-almaty-backup}
CHECK_DB=nice_almaty_restore_check

# Роль и база берутся оттуда же, откуда их берёт compose.
PG_USER=$(grep -E '^POSTGRES_USER=.+' .env | tail -1 | cut -d= -f2- || true)
PG_DB=$(grep -E '^POSTGRES_DB=.+' .env | tail -1 | cut -d= -f2- || true)
PG_USER=${PG_USER:-nice}
PG_DB=${PG_DB:-nice_almaty}

DATE=$(TZ=Asia/Almaty date +%F)
DUMP="$WORK_DIR/nice-almaty-$DATE.dump"

mkdir -p "$WORK_DIR"
chmod 700 "$WORK_DIR"

log() {
	echo "[$(TZ=Asia/Almaty date '+%F %T %Z')] $*"
}

# Незашифрованный дамп на диске сервера — ровно то, от чего защищает
# шифрование. Он удаляется в любом исходе, включая падение посередине.
cleanup() {
	rm -f "$DUMP" "$DUMP.age"
}
trap cleanup EXIT

compose() {
	docker compose "$@"
}

psql_in() {
	compose exec -T postgres psql -U "$PG_USER" -v ON_ERROR_STOP=1 -q "$@"
}

log "дамп базы $PG_DB"
compose exec -T postgres pg_dump -U "$PG_USER" -d "$PG_DB" -Fc --no-owner --no-privileges >"$DUMP"
log "дамп готов: $(stat -c %s "$DUMP") Б"

# Проверка восстановления до шифрования: дамп, который не разворачивается,
# дальше не идёт. Бэкап, который ни разу не разворачивали, бэкапом не является.
log "проверка восстановления в $CHECK_DB"
psql_in -d postgres -c "DROP DATABASE IF EXISTS $CHECK_DB" -c "CREATE DATABASE $CHECK_DB" >/dev/null
compose exec -T postgres pg_restore -U "$PG_USER" -d "$CHECK_DB" --no-owner --exit-on-error <"$DUMP"

# Числа снимаются одной строкой и сверяются с живой базой: развернувшийся,
# но пустой дамп — это тоже несработавший бэкап.
COUNTS_SQL="select (select count(*) from drizzle.__drizzle_migrations)
	|| '/' || (select count(*) from users)
	|| '/' || (select count(*) from houses)
	|| '/' || (select count(*) from accounts)
	|| '/' || (select count(*) from audit_log)"

SOURCE_COUNTS=$(psql_in -d "$PG_DB" -Atc "$COUNTS_SQL")
RESTORED_COUNTS=$(psql_in -d "$CHECK_DB" -Atc "$COUNTS_SQL")

psql_in -d postgres -c "DROP DATABASE $CHECK_DB" >/dev/null

if [ "$SOURCE_COUNTS" != "$RESTORED_COUNTS" ]; then
	log "ОТКАЗ: развёрнутая копия не совпала с базой: $SOURCE_COUNTS против $RESTORED_COUNTS"
	exit 1
fi

log "восстановление проверено: миграции/пользователи/дома/счета/аудит = $SOURCE_COUNTS"

log "шифрование и выгрузка на Drive"
compose run --rm -T backup pnpm tsx scripts/backup-drive.ts \
	--file="/work/$(basename "$DUMP")" --date="$DATE"

log "готово"
