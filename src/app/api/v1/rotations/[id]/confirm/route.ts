import { assertApiAccess } from '@/lib/api/access';
import { apiJson, apiRoute, requireApiActor } from '@/lib/api/route';
import { confirmAssignment } from '@/services/rotation-confirmation';

/**
 * Подтверждение своей уборки (docs/06-API.md, `POST /rotations/{id}/confirm`).
 *
 * Тот же сервис, что и у экрана: логика подтверждения, оценки и долгов
 * не дублируется. Фото через токен не передаются — для них есть отдельный
 * двухшаговый маршрут файлов, и складывать его сюда незачем.
 */
export const POST = apiRoute<{ id: string }>(async (request, { params, requestId }) => {
  const actor = await requireApiActor(request, requestId);

  assertApiAccess(actor, 'rotation.manage', { houseId: actor.context.houseId });

  const assignment = await confirmAssignment(actor, params.id, {});

  return apiJson(
    {
      id: assignment.id,
      state: assignment.state,
      confirmed_at: assignment.confirmedAt?.toISOString() ?? null,
      done_at: assignment.doneAt?.toISOString() ?? null,
    },
    requestId,
  );
});
