#!/usr/bin/env bash
#
# Развёртывание на боевой с проверкой, а не с надеждой.
#
# Разбор I19 (24 сентября 2026): сборка образа падала, а команда запускалась
# с `| tail -1`, и хвост упавшей сборки выглядел как хвост успешной. Compose
# поднимал прежний образ и честно отвечал «Started», /api/health отвечал 200.
# Два дня боевой сервер крутил старый код при всех признаках успеха.
#
# Отсюда правила этого скрипта:
# 1. `set -euo pipefail` и никаких конвейеров вокруг сборки: код возврата
#    не должен терять по дороге ни один шаг.
# 2. Хеш коммита запекается в образ и сверяется через /api/health после
#    запуска. Несовпадение — ошибка, а не примечание.
# 3. Незакоммиченные изменения — отказ: иначе «развёрнут коммит X» неправда.
#
set -euo pipefail

cd "$(dirname "$0")/.."

readonly HEALTH_URL="${HEALTH_URL:-https://nice.aqy.kz/api/health}"
# Настоящая страница, а не только health: 25 сентября health был зелёным
# на лежащем сайте, потому что делал `select 1` (разбор I21).
readonly PAGE_URL="${PAGE_URL:-https://nice.aqy.kz/login}"
readonly SERVICES="${SERVICES:-app}"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "deploy: в рабочем дереве есть незакоммиченные изменения." >&2
  echo "deploy: развёрнутый хеш тогда не описывает то, что запущено." >&2
  exit 1
fi

APP_COMMIT="$(git rev-parse HEAD)"
export APP_COMMIT
readonly APP_COMMIT

echo "deploy: коммит ${APP_COMMIT}"
echo "deploy: сборка ${SERVICES}"

# shellcheck disable=SC2086
docker compose build ${SERVICES}

#
# Миграции — до пересоздания контейнера: приложение, поднятое на отставшей
# базе, падает при первом обращении к ней. Сборка образа сначала, потому что
# упавшая сборка не должна оставлять базу изменённой.
#
echo "deploy: миграции"
docker compose run --rm migrate

echo "deploy: запуск"
# shellcheck disable=SC2086
docker compose up -d --force-recreate ${SERVICES}

echo "deploy: ожидание готовности"

deployed=""

for _ in $(seq 1 30); do
  sleep 2

  body="$(curl -fsS "${HEALTH_URL}" || true)"

  if [ -z "${body}" ]; then
    continue
  fi

  deployed="$(printf '%s' "${body}" | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p')"

  if [ -n "${deployed}" ]; then
    health_body="${body}"
    break
  fi
done

if [ -z "${deployed}" ]; then
  echo "deploy: /api/health не отдал версию — развёртывание не подтверждено." >&2
  exit 1
fi

if [ "${deployed}" != "${APP_COMMIT}" ]; then
  echo "deploy: запущен коммит ${deployed}, а ожидался ${APP_COMMIT}." >&2
  echo "deploy: образ не пересобрался или контейнер не пересоздан." >&2
  exit 1
fi

#
# Здоровье целиком, а не только наличие версии: health знает про схему,
# и «зелёный health на лежащем сайте» больше не должен быть возможен.
#
status="$(printf '%s' "${health_body:-}" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"

if [ "${status}" != "ok" ]; then
  echo "deploy: health отвечает «${status}», а не «ok»:" >&2
  printf '%s\n' "${health_body:-}" >&2
  exit 1
fi

#
# И настоящая страница: она проверяет, что приложение вообще отдаёт разметку.
# Расхождение схемы ловится шагом выше — в health: страницы защищённой зоны
# без сессии отдают перенаправление, и раскладку с её проверкой схемы
# неавторизованным запросом не достать.
#
echo "deploy: проверка страницы ${PAGE_URL}"

page_code="$(curl -s -o /dev/null -w '%{http_code}' "${PAGE_URL}")"

if [ "${page_code}" != "200" ]; then
  echo "deploy: страница ответила ${page_code}, а не 200 — развёртывание не подтверждено." >&2
  exit 1
fi

echo "deploy: подтверждено, запущен ${deployed}, схема и страница в порядке"
