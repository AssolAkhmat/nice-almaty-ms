import { listAreas, listBeds } from '@/db/repositories/areas';
import { listBedOccupantsOn } from '@/db/repositories/rotations';
import { assertApiAccess } from '@/lib/api/access';
import { apiJson, apiRoute, requireApiActor } from '@/lib/api/route';
import { todayInAlmaty, tryParseBusinessDate } from '@/lib/time';

/**
 * Занятость мест дома (docs/06-API.md, `GET /houses/{id}/beds`).
 *
 * Ради этого маршрута бот и заводится: он отвечает на вопрос «есть ли
 * свободное место». Кто именно занимает место, здесь не сказано —
 * это жильцы, другой скоуп; сказано только «занято» или «свободно».
 */
export const GET = apiRoute<{ id: string }>(async (request, { params, requestId }) => {
  const actor = await requireApiActor(request, requestId);

  assertApiAccess(actor, 'bed.read', { houseId: params.id });

  const url = new URL(request.url);
  const date = tryParseBusinessDate(url.searchParams.get('date') ?? '') ?? todayInAlmaty();

  const [beds, areas, occupants] = await Promise.all([
    listBeds(actor.context, params.id),
    listAreas(actor.context, params.id),
    listBedOccupantsOn(actor.context, params.id, date),
  ]);

  const areaNames = new Map(areas.map((area) => [area.id, area.name]));
  const taken = new Set(occupants.map((occupant) => occupant.bedId));

  return apiJson(
    {
      data: beds.map((bed) => ({
        id: bed.id,
        label: bed.label,
        number: bed.number,
        tier: bed.tier,
        area_id: bed.areaId,
        area_name: areaNames.get(bed.areaId) ?? null,
        default_price: bed.defaultPrice,
        occupied: taken.has(bed.id),
      })),
      date,
    },
    requestId,
  );
});
