import { and, desc, eq, gte, lte, type SQL } from 'drizzle-orm';

import { ForbiddenError } from '@/lib/errors';

import { isSuperadmin, type AccessContext } from '../access';
import { getDb, type Executor } from '../client';
import { auditLog, type AuditLogEntry, type NewAuditLogEntry } from '../schema';

/** Журнал читает только суперадмин (docs/03-BUSINESS-RULES.md §11). */
function assertCanRead(context: AccessContext): void {
  if (!isSuperadmin(context)) {
    throw new ForbiddenError('Журнал аудита доступен только суперадмину');
  }
}

export interface AuditFilter {
  actorUserId?: string;
  entityType?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export async function appendAuditEntry(
  entry: NewAuditLogEntry,
  executor: Executor = getDb(),
): Promise<void> {
  await executor.insert(auditLog).values(entry);
}

export async function listAuditEntries(
  context: AccessContext,
  filter: AuditFilter = {},
  executor: Executor = getDb(),
): Promise<AuditLogEntry[]> {
  assertCanRead(context);

  const conditions: SQL[] = [eq(auditLog.orgId, context.orgId)];

  if (filter.actorUserId !== undefined) {
    conditions.push(eq(auditLog.actorUserId, filter.actorUserId));
  }
  if (filter.entityType !== undefined) {
    conditions.push(eq(auditLog.entityType, filter.entityType));
  }
  if (filter.entityId !== undefined) {
    conditions.push(eq(auditLog.entityId, filter.entityId));
  }
  if (filter.from !== undefined) {
    conditions.push(gte(auditLog.createdAt, filter.from));
  }
  if (filter.to !== undefined) {
    conditions.push(lte(auditLog.createdAt, filter.to));
  }

  return executor
    .select()
    .from(auditLog)
    .where(and(...conditions))
    .orderBy(desc(auditLog.createdAt))
    .limit(filter.limit ?? 100);
}
