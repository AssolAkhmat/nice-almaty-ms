import { eq } from 'drizzle-orm';

import { NotFoundError } from '@/lib/errors';

import type { AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import { organizations, type Organization } from '../schema';

/**
 * Сеть одна, создание сетей в UI выключено (D7).
 * Читается всегда через контекст доступа: чужая организация невидима.
 */
export async function requireOrganization(
  context: AccessContext,
  executor: Executor = getDb(),
): Promise<Organization> {
  const [organization] = await executor
    .select()
    .from(organizations)
    .where(eq(organizations.id, context.orgId))
    .limit(1);

  if (organization === undefined) {
    throw new NotFoundError('Организация не найдена');
  }

  return organization;
}
