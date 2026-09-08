import { appendAuditEntry } from '@/db/repositories/audit-log';
import { diffForAudit, snapshotForAudit, type AuditValues } from '@/lib/audit-diff';

import type { AccessContext } from '@/db/access';
import type { Executor, Transaction } from '@/db/client';

/**
 * Журнал действий (docs/03-BUSINESS-RULES.md §11).
 *
 * Запись идёт в той же транзакции, что и само изменение: если журнал
 * не записался, изменения быть не должно. Иначе аудит превращается
 * в набор пропусков ровно там, где он нужнее всего.
 */
export const AUDIT_ACTIONS = {
  signIn: 'auth.sign_in',
  signInWithResetPermission: 'auth.sign_in_with_reset_permission',
  signOut: 'auth.sign_out',
  passwordChanged: 'auth.password_changed',
  passwordResetAllowed: 'auth.password_reset_allowed',
  userCreated: 'user.created',
  userUpdated: 'user.updated',
  userArchived: 'user.archived',
  userRoleChanged: 'user.role_changed',
  userHouseChanged: 'user.house_changed',
  userPhoneChanged: 'user.phone_changed',
  houseCreated: 'house.created',
  houseUpdated: 'house.updated',
  houseArchived: 'house.archived',
  settingChanged: 'setting.changed',
  sensitiveFieldRevealed: 'resident.sensitive_field_revealed',
  fileUploaded: 'file.uploaded',
  fileRead: 'file.read',
  documentSubmitted: 'document.submitted',
  documentApproved: 'document.approved',
  documentRejected: 'document.rejected',
  contractGenerated: 'contract.generated',
  contractSigned: 'contract.signed',
  keysIssued: 'residency.keys_issued',
  invoiceIssued: 'invoice.issued',
  invoiceEdited: 'invoice.edited',
  invoiceCancelled: 'invoice.cancelled',
  invoiceSentRemotely: 'invoice.sent_remotely',
  paymentRecorded: 'payment.recorded',
  depositCharged: 'deposit.charged',
  residencyCreated: 'residency.created',
  residencyActivated: 'residency.activated',
  areaCreated: 'area.created',
  areaUpdated: 'area.updated',
  areaArchived: 'area.archived',
  bedCreated: 'bed.created',
  bedUpdated: 'bed.updated',
  bedArchived: 'bed.archived',
  bedAssigned: 'bed.assigned',
  bedReleased: 'bed.released',
  residencyTerminated: 'residency.terminated',
  residencyArchived: 'residency.archived',
  depositRefundIssued: 'deposit.refund_issued',
  depositRefunded: 'deposit.refunded',
  depositBurned: 'deposit.burned',
  damageCreated: 'damage.created',
  damageReversed: 'damage.reversed',
  utilityPeriodClosed: 'utility_period.closed',
  utilityPeriodReopened: 'utility_period.reopened',
  expenseRecorded: 'expense.recorded',
  ledgerEntryPosted: 'ledger.entry_posted',
  ledgerEntryReversed: 'ledger.entry_reversed',
  checklistSaved: 'checklist.saved',
  checklistArchived: 'checklist.archived',
  eligibilityGroupSaved: 'eligibility_group.saved',
  areaEligibilitySet: 'area_eligibility.set',
  rotationRowSaved: 'rotation_row.saved',
  rotationRowArchived: 'rotation_row.archived',
  rotationMoved: 'rotation.moved',
  rotationCancelled: 'rotation.cancelled',
  rotationReassigned: 'rotation.reassigned',
  rotationExtraCreated: 'rotation.extra_created',
  rotationRangeCancelled: 'rotation.range_cancelled',
  generalCleaningPlanned: 'rotation.general_cleaning_planned',
  rotationConfirmed: 'rotation.confirmed',
  rotationMarked: 'rotation.marked',
  rotationScored: 'rotation.scored',
  rotationTemplateSaved: 'rotation_template.saved',
  absenceSubmitted: 'absence.submitted',
  absenceApproved: 'absence.approved',
  absenceRejected: 'absence.rejected',
  ratingEventAdded: 'rating_event.added',
  fineAdded: 'fine.added',
  fineCancelled: 'fine.cancelled',
  discountApproved: 'discount.approved',
  ratingRuleSaved: 'rating_rule.saved',
  documentTypeSaved: 'document_type.saved',
  accountSaved: 'account.saved',
  accountArchived: 'account.archived',
  contractTemplateSaved: 'contract_template.saved',
  documentTypeArchived: 'document_type.archived',
  inventoryItemCreated: 'inventory_item.created',
  inventoryItemUpdated: 'inventory_item.updated',
  inventoryMoved: 'inventory_item.moved',
  inventoryWrittenOff: 'inventory_item.written_off',
  inventoryAuditClosed: 'inventory_audit.closed',
  apiTokenIssued: 'api_token.issued',
  apiTokenRevoked: 'api_token.revoked',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditActor {
  /** Организация и пользователь берутся из контекста доступа. */
  context: Pick<AccessContext, 'orgId' | 'userId'>;
  ip?: string | undefined;
  requestId?: string | undefined;
}

export interface AuditRecord {
  action: AuditAction;
  entityType: string;
  entityId?: string | undefined;
  before?: AuditValues | undefined;
  after?: AuditValues | undefined;
}

function toEntry(actor: AuditActor, record: AuditRecord) {
  const { before, after } = record;

  // Обе стороны есть — пишем только изменившиеся поля; одна — снимок.
  const values =
    before !== undefined && after !== undefined
      ? (diffForAudit(before, after) ?? { before: {}, after: {} })
      : {
          before: before === undefined ? null : snapshotForAudit(before),
          after: after === undefined ? null : snapshotForAudit(after),
        };

  return {
    orgId: actor.context.orgId,
    actorUserId: actor.context.userId,
    action: record.action,
    entityType: record.entityType,
    entityId: record.entityId ?? null,
    before: values.before,
    after: values.after,
    ip: actor.ip ?? null,
    requestId: actor.requestId ?? null,
  };
}

export async function recordAudit(
  actor: AuditActor,
  record: AuditRecord,
  executor: Executor,
): Promise<void> {
  await appendAuditEntry(toEntry(actor, record), executor);
}

/**
 * Мутация вместе с записью в журнал, одной транзакцией.
 * На уже открытой транзакции создаётся точка сохранения — вложенность допустима.
 */
export async function withAudit<T>(
  actor: AuditActor,
  body: (tx: Transaction) => Promise<{ result: T; audit: AuditRecord | AuditRecord[] }>,
  executor: Executor,
): Promise<T> {
  return executor.transaction(async (tx) => {
    const { result, audit } = await body(tx);
    const records = Array.isArray(audit) ? audit : [audit];

    for (const record of records) {
      await recordAudit(actor, record, tx);
    }

    return result;
  });
}
