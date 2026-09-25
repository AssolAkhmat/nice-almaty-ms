#!/usr/bin/env bash
#
# Состояние CI по коммиту — фактом, а не по памяти (CLAUDE.md §2,
# «правило увиденного отказа»).
#
# Отчёт о работе обязан содержать строку: прогон, коммит, результат.
# Семь случаев за неделю показали, чего стоит «тесты зелёные» без указания,
# где именно прогнаны: локально зелено и в CI зелено — разные утверждения.
#
# Без аргумента берётся HEAD. Сравнивается с тем, что реально развёрнуто:
# «CI зелёный» по коммиту, которого нет на сервере, ничего не говорит
# о сервере.
#
set -euo pipefail

cd "$(dirname "$0")/.."

readonly REPO="${CI_REPO:-AssolAkhmat/nice-almaty-ms}"
readonly HEALTH_URL="${HEALTH_URL:-https://nice.aqy.kz/api/health}"

commit="${1:-$(git rev-parse HEAD)}"

echo "коммит:    ${commit}"

deployed="$(curl -fsS "${HEALTH_URL}" 2>/dev/null | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p' || true)"

if [ -z "${deployed}" ]; then
  echo "на боевой: версия недоступна"
elif [ "${deployed}" = "${commit}" ]; then
  echo "на боевой: он же"
else
  echo "на боевой: ДРУГОЙ — ${deployed}"
fi

body="$(curl -fsS "https://api.github.com/repos/${REPO}/commits/${commit}/check-runs" \
  -H 'Accept: application/vnd.github+json' 2>/dev/null || true)"

if [ -z "${body}" ]; then
  echo "прогон:    состояние недоступно (лимит запросов или сеть)"
  exit 0
fi

printf '%s' "${body}" |
  python3 -c '
import json, sys

data = json.load(sys.stdin)
runs = data.get("check_runs", [])

if not runs:
    print("прогон:    ещё не запускался")
    raise SystemExit(0)

for run in runs:
    state = run.get("conclusion") or run.get("status")
    print("прогон:    " + run["name"] + " — " + str(state))
'
