import { listHouses } from '@/db/repositories/houses';
import { assertApiAccess } from '@/lib/api/access';
import { apiJson, apiRoute, requireApiActor } from '@/lib/api/route';

/**
 * Дома сети (docs/06-API.md, `GET /houses`).
 *
 * Боту нужен список, чтобы спросить места в конкретном доме. Ничего,
 * кроме названия и адреса, здесь нет: жильцы, деньги и рейтинг — другие
 * скоупы и другие маршруты.
 */
export const GET = apiRoute(async (request, { requestId }) => {
  const actor = await requireApiActor(request, requestId);

  assertApiAccess(actor, 'house.read', { houseId: actor.context.houseId });

  const houses = await listHouses(actor.context);

  return apiJson(
    {
      data: houses.map((house) => ({
        id: house.id,
        name: house.name,
        slug: house.slug,
        address: house.address,
      })),
    },
    requestId,
  );
});
