import { and, desc, eq } from 'drizzle-orm';

import { getStorageProvider } from '@/adapters/storage';
import { getPdfRenderer } from '@/adapters/pdf';
import { getDb, type Executor } from '@/db/client';
import { findPlacementOfResidency } from '@/db/repositories/areas';
import { requireHouseOfResidency } from '@/db/repositories/houses';
import { createFile, requireFile, updateFile } from '@/db/repositories/files';
import { requireProfile } from '@/db/repositories/resident-profiles';
import { requireResidency, updateResidency } from '@/db/repositories/residencies';
import { requireUser } from '@/db/repositories/users';
import { contractTemplates, type ContractTemplate } from '@/db/schema';
import { hasToken, renderContractTemplate, unknownTokens } from '@/domain/contract-template';
import { documentStorageKey } from '@/domain/files';
import { assertCan } from '@/lib/authz';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { now, todayInAlmaty, type BusinessDate } from '@/lib/time';

import { AUDIT_ACTIONS, recordAudit } from './audit';
import { ensureContractNumber } from './contract-numbers';
import { revealSensitiveField } from './resident-profiles';

import type { PdfRenderer } from '@/adapters/pdf';
import type { StorageProvider } from '@/adapters/storage';
import type { FileRecord, Residency } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Договор: сборка из шаблона, печать в PDF и подпись
 * (docs/04-MODULES/01-onboarding.md, docs/01-ARCHITECTURE.md).
 *
 * Отметки «договор подписан» и «ключи выданы» раздельные: ключи выдаёт админ
 * и это отдельное событие, а не следствие подписи.
 *
 * PDF собирается сервером и кладётся в хранилище напрямую: байты уже в руках,
 * и гонять их через двухшаговую загрузку клиента незачем — она нужна ровно
 * тогда, когда байты приходят от клиента.
 */
export interface ContractDeps {
  executor?: Executor;
  storage?: StorageProvider;
  pdf?: PdfRenderer;
  today?: BusinessDate;
}

interface Resolved {
  executor: Executor;
  storage: StorageProvider;
  pdf: PdfRenderer;
  today: BusinessDate;
}

function resolve(deps: ContractDeps): Resolved {
  return {
    executor: deps.executor ?? getDb(),
    storage: deps.storage ?? getStorageProvider(),
    pdf: deps.pdf ?? getPdfRenderer(),
    today: deps.today ?? todayInAlmaty(),
  };
}

/** Дата в договоре — человеческая: 01.09.2026, а не 2026-09-01. */
function humanDate(value: string | null): string {
  if (value === null) {
    return '';
  }

  const [year, month, day] = value.split('-');

  return day === undefined ? value : `${day}.${month}.${year}`;
}

function money(amount: number | null): string {
  return amount === null ? '' : `${amount.toLocaleString('ru-RU').replaceAll(',', ' ')} ₸`;
}

export async function activeTemplate(
  orgId: string,
  executor: Executor,
): Promise<ContractTemplate | null> {
  const [template] = await executor
    .select()
    .from(contractTemplates)
    .where(and(eq(contractTemplates.orgId, orgId), eq(contractTemplates.isActive, true)))
    .orderBy(desc(contractTemplates.version))
    .limit(1);

  return template ?? null;
}

/**
 * Шаблон, по которому собран договор этого проживания (T8.5).
 *
 * Пусто у проживаний, чей договор собирали до версионирования, — им достаётся
 * действующий шаблон. У остальных берётся именно их версия: подпись
 * пересобирает документ, и он обязан остаться тем же, что человек прочитал.
 */
async function templateOfResidency(
  residency: Residency,
  executor: Executor,
): Promise<ContractTemplate> {
  if (residency.contractTemplateId !== null) {
    const [stored] = await executor
      .select()
      .from(contractTemplates)
      .where(eq(contractTemplates.id, residency.contractTemplateId))
      .limit(1);

    if (stored !== undefined) {
      return stored;
    }
  }

  const active = await activeTemplate(residency.orgId, executor);

  if (active === null) {
    throw new NotFoundError('Активный шаблон договора не задан');
  }

  return active;
}

/**
 * Значения токенов для конкретного проживания. ИИН расшифровывается тем же
 * действием, что и в профиле, поэтому раскрытие остаётся в журнале —
 * договор не должен быть лазейкой в обход этого правила.
 */
async function contractValues(
  actor: UserActor,
  residency: Residency,
  deps: Resolved,
  contractNumber: string,
): Promise<Record<string, string>> {
  const { executor, today } = deps;

  const house = await requireHouseOfResidency(actor.context, residency.id, executor);
  // Место видно через проживание: у жильца в контексте дома нет (P2-5).
  const placement = await findPlacementOfResidency(actor.context, residency.id, executor);

  const profile = await requireProfile(actor.context, residency.userId, executor);
  // Телефон входа — резерв для договора: у входа он обязателен всегда,
  // а в профиле это отдельное, необязательное контактное поле (T9.7).
  const user = await requireUser(actor.context, residency.userId, executor);

  const fullName = [profile.lastName, profile.firstName, profile.middleName]
    .filter((part) => part !== null && part !== '')
    .join(' ');

  const iin =
    profile.iinEnc === null
      ? ''
      : await revealSensitiveField(actor, residency.userId, 'iin', executor);

  const idDocNumber =
    profile.idDocNumberEnc === null
      ? ''
      : await revealSensitiveField(actor, residency.userId, 'idDocNumber', executor);

  return {
    'resident.full_name': fullName,
    'resident.iin': iin,
    'residency.contract_start': humanDate(residency.contractStart),
    'residency.contract_end': humanDate(residency.contractEnd),
    'bed.room': placement?.area.name ?? '',
    'bed.label': placement?.bed.label ?? '',
    'bed.price': placement === null ? '' : money(placement.price),
    'house.name': house.name,
    'house.address': house.address ?? '',
    today: humanDate(today),
    'resident.id_doc_issuer': profile.idDocIssuer ?? '',
    'resident.registration_address': profile.registrationAddress ?? '',
    'residency.contract_number': contractNumber,
    'resident.id_doc_number': idDocNumber,
    'residency.deposit_amount': money(residency.depositAmount),
    'resident.phone': profile.phone ?? user.phone,
    'resident.emergency_name': profile.emergencyName ?? '',
    'resident.emergency_phone': profile.emergencyPhone ?? '',
    'resident.university': profile.university ?? '',
    'resident.course': profile.course === null ? '' : String(profile.course),
  };
}

/** Картинка подписи. Собирается сервером из байтов файла, не из ввода человека. */
function signatureImage(dataUrl: string): string {
  return `<img alt="" src="${dataUrl}" style="max-height:120px" />`;
}

/**
 * Подпись блоком в конце документа — для шаблонов без токена
 * `{{resident.signature}}`.
 *
 * Так было до 21 сентября 2026 у всех договоров (P2-17). Теперь место подписи
 * задаётся токеном, но шаблоны, написанные раньше, токена не содержат:
 * убрать этот путь значило бы напечатать подписанный договор без подписи.
 */
function withSignature(html: string, signature: string | null): string {
  if (signature === null) {
    return html;
  }

  return `${html}<div style="margin-top:24px">${signatureImage(signature)}</div>`;
}

/**
 * Готовый HTML договора. Подпись встаёт на место токена, а у шаблона без него —
 * блоком в конце. Пустая строка до подписания: токен обязан иметь значение,
 * иначе подстановка падает на «Нет значения для токена».
 */
function renderContract(
  bodyHtml: string,
  values: Readonly<Record<string, string>>,
  dataUrl: string | null,
): string {
  const html = renderContractTemplate(bodyHtml, {
    ...values,
    'resident.signature': dataUrl === null ? '' : signatureImage(dataUrl),
  });

  return hasToken(bodyHtml, 'resident.signature') ? html : withSignature(html, dataUrl);
}

async function storeServerFile(
  actor: UserActor,
  input: {
    residency: Residency;
    documentType: string;
    mime: string;
    bytes: Uint8Array;
    originalName: string;
  },
  deps: Resolved,
): Promise<FileRecord> {
  const { executor, storage } = deps;

  const house = await requireHouseOfResidency(actor.context, input.residency.id, executor);
  const fileId = crypto.randomUUID();
  const path = documentStorageKey({
    houseSlug: house.slug,
    residencyId: input.residency.id,
    documentType: input.documentType,
    fileId,
    mime: input.mime,
  });

  const stored = await storage.put(path, input.bytes);

  const file = await createFile(
    actor.context,
    {
      id: fileId,
      residencyId: input.residency.id,
      provider: storage.driver,
      path,
      mime: input.mime,
      sizeBytes: stored.sizeBytes,
      originalName: input.originalName,
      uploadedBy: actor.context.userId,
      scope: { documentType: input.documentType },
    },
    executor,
  );

  // Байты положил сам сервер: подтверждать нечего, файл сразу готов.
  const ready = await updateFile(actor.context, file.id, { status: 'ready' }, executor);

  return ready ?? file;
}

export interface ContractResult {
  residency: Residency;
  file: FileRecord;
}

/**
 * Сборка договора в PDF. Пересборка разрешена, пока договор не подписан:
 * после подписи документ фиксируется, иначе подпись оказалась бы под другим
 * текстом, чем тот, который жилец видел.
 */
export async function buildContract(
  actor: UserActor,
  residencyId: string,
  deps: ContractDeps = {},
): Promise<ContractResult> {
  const resolved = resolve(deps);
  const { executor } = resolved;

  const residency = await requireResidency(actor.context, residencyId, executor);
  assertCan(actor.context, 'contract.generate', {
    houseId: residency.houseId,
    userId: residency.userId,
  });

  if (residency.contractSignedAt !== null) {
    throw new ConflictError('Договор уже подписан: пересборка изменила бы подписанный текст');
  }

  const template = await activeTemplate(actor.context.orgId, executor);
  if (template === null) {
    throw new NotFoundError('Активный шаблон договора не задан');
  }

  const unknown = unknownTokens(template.bodyHtml);
  if (unknown.length > 0) {
    throw new ValidationError('contracts.unknownTokens', { tokens: unknown });
  }

  const contractNumber = await ensureContractNumber(actor.context, residency, executor);
  const values = await contractValues(actor, residency, resolved, contractNumber);
  // Договор до подписания: токен подписи получает пустое значение.
  const html = renderContract(template.bodyHtml, values, null);
  const pdf = await resolved.pdf.render(html);

  const file = await storeServerFile(
    actor,
    {
      residency,
      documentType: 'contract',
      mime: 'application/pdf',
      bytes: pdf,
      originalName: 'dogovor.pdf',
    },
    resolved,
  );

  return executor.transaction(async (tx) => {
    const updated = await updateResidency(
      actor.context,
      residency.id,
      // Версия запоминается вместе с файлом: подпись и пересборка пойдут по ней.
      { contractFileId: file.id, contractTemplateId: template.id },
      tx,
    );

    if (updated === null) {
      throw new NotFoundError('Проживание не найдено');
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.contractGenerated,
        entityType: 'residency',
        entityId: residency.id,
        after: {
          contractFileId: file.id,
          templateId: template.id,
          templateVersion: template.version,
          contractNumber,
        },
      },
      tx,
    );

    return { residency: updated, file };
  });
}

/**
 * Подпись: PNG с canvas уже загружен обычной двухшаговой загрузкой, здесь он
 * вкладывается в договор, и документ пересобирается вместе с ним.
 */
export async function signContract(
  actor: UserActor,
  residencyId: string,
  signatureFileId: string,
  deps: ContractDeps = {},
): Promise<ContractResult> {
  const resolved = resolve(deps);
  const { executor, storage } = resolved;

  const residency = await requireResidency(actor.context, residencyId, executor);
  assertCan(actor.context, 'contract.sign', {
    houseId: residency.houseId,
    userId: residency.userId,
  });

  if (residency.contractSignedAt !== null) {
    throw new ConflictError('Договор уже подписан');
  }

  const signature = await requireFile(actor.context, signatureFileId, executor);
  if (signature.status !== 'ready' || signature.residencyId !== residency.id) {
    throw new NotFoundError('Подпись не найдена');
  }

  if (signature.mime !== 'image/png') {
    throw new ValidationError('contracts.signatureMustBePng');
  }

  const template = await templateOfResidency(residency, executor);

  const bytes = await storage.get(signature.path);
  if (bytes === null) {
    throw new NotFoundError('Подпись не найдена');
  }

  const dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
  const contractNumber = await ensureContractNumber(actor.context, residency, executor);
  const values = await contractValues(actor, residency, resolved, contractNumber);
  const html = renderContract(template.bodyHtml, values, dataUrl);
  const pdf = await resolved.pdf.render(html);

  const file = await storeServerFile(
    actor,
    {
      residency,
      documentType: 'contract',
      mime: 'application/pdf',
      bytes: pdf,
      originalName: 'dogovor-podpisan.pdf',
    },
    resolved,
  );

  return executor.transaction(async (tx) => {
    const signedAt = now();
    const updated = await updateResidency(
      actor.context,
      residency.id,
      { contractFileId: file.id, signatureFileId: signature.id, contractSignedAt: signedAt },
      tx,
    );

    if (updated === null) {
      throw new NotFoundError('Проживание не найдено');
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.contractSigned,
        entityType: 'residency',
        entityId: residency.id,
        // Время подписания в самом снимке: `created_at` строки журнала — это
        // время записи, а договор подписан моментом, который лежит в проживании.
        after: {
          contractFileId: file.id,
          signatureFileId: signature.id,
          contractSignedAt: signedAt.toISOString(),
        },
      },
      tx,
    );

    return { residency: updated, file };
  });
}

/**
 * «Ключи выданы» — отдельная отметка админа. Она ничего не блокирует
 * и не следует из подписи: договор может быть подписан, а ключи ещё нет.
 */
export async function markKeysIssued(
  actor: UserActor,
  residencyId: string,
  deps: ContractDeps = {},
): Promise<Residency> {
  const { executor } = resolve(deps);

  const residency = await requireResidency(actor.context, residencyId, executor);
  assertCan(actor.context, 'residency.issueKeys', {
    houseId: residency.houseId,
    userId: residency.userId,
  });

  if (residency.keysIssued) {
    return residency;
  }

  return executor.transaction(async (tx) => {
    const updated = await updateResidency(
      actor.context,
      residency.id,
      { keysIssued: true, keysIssuedAt: now() },
      tx,
    );

    if (updated === null) {
      throw new NotFoundError('Проживание не найдено');
    }

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.keysIssued,
        entityType: 'residency',
        entityId: residency.id,
        before: { keysIssued: false },
        after: { keysIssued: true },
      },
      tx,
    );

    return updated;
  });
}
