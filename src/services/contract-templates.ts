import { and, eq } from 'drizzle-orm';

import { getDb, type Executor } from '@/db/client';
import { contractTemplates } from '@/db/schema';
import {
  renderContractTemplate,
  SAMPLE_CONTRACT_VALUES,
  unknownTokens,
} from '@/domain/contract-template';
import { assertCan } from '@/lib/authz';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { now } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';
import { activeTemplate } from './contracts';

import type { ContractTemplate } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Редактор шаблона договора (модуль 11; T8.4).
 *
 * Шаблон приносил сид, а правился он только запросом в базу. Здесь он получает
 * хозяина: суперадмина, который видит палитру токенов и предпросмотр
 * на выдуманных данных.
 *
 * Неизвестный токен не сохраняется. Проверка та же, что при сборке договора,
 * но срабатывает она раньше: иначе опечатка всплыла бы у первого жильца,
 * которому договор понадобился, а не у того, кто её сделал.
 */
export interface ContractTemplateInput {
  name: string;
  bodyHtml: string;
}

function assertUsable(input: ContractTemplateInput): void {
  if (input.name.trim() === '') {
    throw new ValidationError('nameRequired');
  }

  if (input.bodyHtml.trim() === '') {
    throw new ValidationError('bodyRequired');
  }

  const unknown = unknownTokens(input.bodyHtml);

  if (unknown.length > 0) {
    throw new ValidationError('unknownTokens', { tokens: unknown });
  }
}

export async function readContractTemplate(
  actor: UserActor,
  executor: Executor = getDb(),
): Promise<ContractTemplate> {
  assertCan(actor.context, 'settings.org.read');

  const template = await activeTemplate(actor.context.orgId, executor);

  if (template === null) {
    throw new NotFoundError('Активный шаблон договора не задан');
  }

  return template;
}

export async function saveContractTemplate(
  actor: UserActor,
  input: ContractTemplateInput,
  executor: Executor = getDb(),
): Promise<ContractTemplate> {
  assertCan(actor.context, 'settings.org.write');
  assertUsable(input);

  const before = await readContractTemplate(actor, executor);

  /*
   * Правка не переписывает строку, а заводит следующую версию (T8.5).
   * Договор, собранный по прежней, ссылается на неё и остаётся тем же
   * документом: подписанное не меняется задним числом.
   */
  return executor.transaction(async (tx) => {
    await tx
      .update(contractTemplates)
      .set({ isActive: false, updatedAt: now() })
      .where(
        and(eq(contractTemplates.orgId, actor.context.orgId), eq(contractTemplates.isActive, true)),
      );

    const [updated] = await tx
      .insert(contractTemplates)
      .values({
        orgId: actor.context.orgId,
        name: input.name.trim(),
        version: before.version + 1,
        bodyHtml: input.bodyHtml,
        tokens: [],
        isActive: true,
      })
      .returning();

    if (updated === undefined) {
      throw new NotFoundError('Шаблон договора не найден');
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.contractTemplateSaved,
        entityType: 'contract_template',
        entityId: updated.id,
        before: { version: before.version, name: before.name, bodyHtml: before.bodyHtml },
        after: { version: updated.version, name: updated.name, bodyHtml: updated.bodyHtml },
      },
      tx,
    );

    return updated;
  });
}

/**
 * Предпросмотр на выдуманных данных: ни базы, ни чужого ИИН.
 * Права спрашиваются всё равно — незачем показывать текст договора тому,
 * кому не положено его править.
 */
export async function previewContractTemplate(actor: UserActor, bodyHtml: string): Promise<string> {
  assertCan(actor.context, 'settings.org.read');

  const unknown = unknownTokens(bodyHtml);

  if (unknown.length > 0) {
    throw new ValidationError('unknownTokens', { tokens: unknown });
  }

  return Promise.resolve(renderContractTemplate(bodyHtml, SAMPLE_CONTRACT_VALUES));
}
