import { getDb, type Executor } from '@/db/client';
import {
  accountBalances,
  createAccount as insertAccount,
  findAccountByCode,
  listAccounts,
  requireAccount,
  updateAccount,
} from '@/db/repositories/accounts';
import { listHouses } from '@/db/repositories/houses';
import { assertCan } from '@/lib/authz';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { now } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { Account } from '@/db/schema';
import type { UserActor } from './users';

/**
 * План счетов сети (модуль 10, «Учёт»; T8.3).
 *
 * Счета заводил только сид, и после очистки боевой базы сеть осталась без них:
 * ни платёж, ни депозит без счетов не проводятся. Экран у суперадмина —
 * деньги всей сети не дело одного дома; журнал проводок админ по-прежнему
 * видит на своём экране учёта.
 *
 * Удаления нет и здесь: на счёт ссылаются проводки, а системные счета
 * не архивируются вовсе — на них стоят типовые движения (§10.1).
 */
export interface ChartAccountRow {
  id: string;
  code: string;
  name: string;
  type: Account['type'];
  houseId: string | null;
  houseName: string | null;
  isSystem: boolean;
  isArchived: boolean;
  /** Дебет минус кредит; у фондов обязательство идёт со знаком минус. */
  balance: number;
}

/** Типы, которые заводят руками. Фонды и фонд дома появляются вместе с сетью и домом. */
const CREATABLE_TYPES = ['cash', 'kaspi', 'common_fund'] as const;

export type CreatableAccountType = (typeof CREATABLE_TYPES)[number];

export interface CreateAccountInput {
  code: string;
  name: string;
  type: CreatableAccountType;
}

const CODE_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;

function assertName(name: string): void {
  if (name.trim() === '') {
    throw new ValidationError('nameRequired');
  }
}

export async function readChartOfAccounts(
  actor: UserActor,
  executor: Executor = getDb(),
): Promise<ChartAccountRow[]> {
  assertCan(actor.context, 'settings.org.read');

  const [accounts, balances, houses] = await Promise.all([
    listAccounts(actor.context, { includeArchived: true }, executor),
    accountBalances(actor.context, {}, executor),
    listHouses(actor.context, { includeArchived: true }, executor),
  ]);

  const balanceOf = new Map(balances.map((row) => [row.accountId, row.balance]));
  const houseName = new Map(houses.map((house) => [house.id, house.name]));

  return accounts.map((account) => ({
    id: account.id,
    code: account.code,
    name: account.name,
    type: account.type,
    houseId: account.houseId,
    houseName: account.houseId === null ? null : (houseName.get(account.houseId) ?? null),
    isSystem: account.isSystem,
    isArchived: account.archivedAt !== null,
    balance: balanceOf.get(account.id) ?? 0,
  }));
}

export async function createAccount(
  actor: UserActor,
  input: CreateAccountInput,
  executor: Executor = getDb(),
): Promise<Account> {
  assertCan(actor.context, 'settings.org.write');

  const code = input.code.trim();

  if (!CODE_PATTERN.test(code)) {
    throw new ValidationError('codeInvalid', { code });
  }

  assertName(input.name);

  if (!CREATABLE_TYPES.includes(input.type)) {
    throw new ValidationError('typeInvalid', { type: input.type });
  }

  const existing = await findAccountByCode(actor.context, code, executor);
  if (existing !== null) {
    throw new ValidationError('codeTaken', { code });
  }

  return executor.transaction(async (tx) => {
    const created = await insertAccount(
      actor.context,
      { code, name: input.name.trim(), type: input.type, houseId: null, isSystem: false },
      tx,
    );

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.accountSaved,
        entityType: 'account',
        entityId: created.id,
        after: { code: created.code, name: created.name, type: created.type },
      },
      tx,
    );

    return created;
  });
}

/** Переименование. Код и тип не меняются: на них ссылаются проводки и расчёты. */
export async function renameAccount(
  actor: UserActor,
  accountId: string,
  name: string,
  executor: Executor = getDb(),
): Promise<Account> {
  assertCan(actor.context, 'settings.org.write');
  assertName(name);

  const before = await requireAccount(actor.context, accountId, executor);

  return executor.transaction(async (tx) => {
    const updated = await updateAccount(actor.context, accountId, { name: name.trim() }, tx);
    if (updated === null) {
      throw new NotFoundError('Счёт не найден');
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.accountSaved,
        entityType: 'account',
        entityId: accountId,
        before: { name: before.name },
        after: { name: updated.name },
      },
      tx,
    );

    return updated;
  });
}

export async function archiveAccount(
  actor: UserActor,
  accountId: string,
  executor: Executor = getDb(),
): Promise<Account> {
  assertCan(actor.context, 'settings.org.write');

  const before = await requireAccount(actor.context, accountId, executor);

  if (before.isSystem) {
    throw new ValidationError('systemAccount', { code: before.code });
  }

  return executor.transaction(async (tx) => {
    const updated = await updateAccount(actor.context, accountId, { archivedAt: now() }, tx);
    if (updated === null) {
      throw new NotFoundError('Счёт не найден');
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.accountArchived,
        entityType: 'account',
        entityId: accountId,
        before: { archivedAt: before.archivedAt },
        after: { archivedAt: updated.archivedAt },
      },
      tx,
    );

    return updated;
  });
}
