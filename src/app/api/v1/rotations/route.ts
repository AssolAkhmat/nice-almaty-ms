import { ValidationError } from '@/lib/errors';
import { assertApiAccess } from '@/lib/api/access';
import { apiJson, apiRoute, requireApiActor } from '@/lib/api/route';
import { todayInAlmaty, tryParseBusinessDate } from '@/lib/time';
import { readCalendar } from '@/services/rotation-calendar';

/**
 * Ротации дня (docs/06-API.md, `GET /rotations`).
 *
 * Бот спрашивает, кому сегодня убирать, и напоминает об этом своим
 * способом. Оценки в ответ не идут: их видит только админ (§7), и через
 * токен они не открываются никому.
 */
export const GET = apiRoute(async (request, { requestId }) => {
  const actor = await requireApiActor(request, requestId);

  const url = new URL(request.url);
  const houseId = url.searchParams.get('house_id');
  const date = tryParseBusinessDate(url.searchParams.get('date') ?? '') ?? todayInAlmaty();

  if (actor.context.role === 'superadmin' && (houseId === null || houseId === '')) {
    throw new ValidationError('Укажите house_id: у сети домов больше одного');
  }

  assertApiAccess(actor, 'rotation.read', {
    houseId: houseId ?? actor.context.houseId,
    userId: actor.context.userId,
  });

  const calendar = await readCalendar(
    actor,
    { from: date, to: date },
    houseId === null || houseId === '' ? {} : { houseId },
  );

  const names = new Map(
    calendar.dictionaries.members.map((member) => [member.userId, member.name]),
  );
  const areas = new Map(calendar.dictionaries.areas.map((area) => [area.id, area.name]));

  return apiJson(
    {
      data: calendar.occurrences.map((item) => ({
        id: item.occurrence.id,
        date: item.occurrence.date,
        status: item.occurrence.status,
        type: item.occurrence.type,
        area_id: item.occurrence.areaId,
        area_name: areas.get(item.occurrence.areaId) ?? null,
        assignments: item.assignments.map((assignment) => ({
          id: assignment.id,
          state: assignment.state,
          user_id: assignment.userId,
          user_name: assignment.userId === null ? null : (names.get(assignment.userId) ?? null),
        })),
      })),
      house_id: calendar.houseId,
      date,
    },
    requestId,
  );
});
