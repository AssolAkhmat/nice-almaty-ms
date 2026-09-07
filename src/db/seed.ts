import { and, eq } from 'drizzle-orm';

import { generateTemporaryPassword, hashPassword } from '@/lib/password';

import { getDb, type Executor } from './client';
import { seedContent } from './seed-content';
import {
  ACCOUNT_CODES,
  accounts as accountsTable,
  contractTemplates,
  documentTypes,
  houseFundCode,
  houses,
  organizations,
  users,
} from './schema';

/**
 * Сид сети (docs/07-ROADMAP.md, «Сид-данные»).
 * Идемпотентен: повторный запуск ничего не дублирует и не сбрасывает пароли
 * уже существующим учётным записям.
 *
 * Комнаты, места и жильцы появятся в фазе 2, ротации — в фазе 4.
 * Бутстрап первого суперадмина идёт только отсюда: пароль в переменной
 * окружения жил бы вечно и утёк бы в логи сборки.
 */
export const ORG_SLUG = 'nice-almaty';

/**
 * Домов в сети по умолчанию — пять, как в сид-данных роадмапа.
 *
 * Прогон приёмок просит больше: дома с третьего по одиннадцатый отданы
 * приёмкам фаз 3–7, по одному на ширину. В живой установке лишние дома
 * незачем — там их заводит владелец (P7-19).
 */
export const HOUSE_COUNT = 5;

export const SUPERADMIN_PHONE = '+77010000000';

/**
 * Телефоны админов: по одному на дом, номер совпадает с номером дома.
 *
 * Номер дополняется до одиннадцати цифр, а не приклеивается в конец:
 * с десятого дома простая склейка давала `+770100000010` — на две цифры
 * длиннее настоящего казахстанского номера. У домов с первого по девятый
 * номера от этого не изменились.
 */
export function adminPhone(houseNumber: number): string {
  return `+7701${String(houseNumber).padStart(7, '0')}`;
}

export function houseSlug(houseNumber: number): string {
  return `dom-${houseNumber}`;
}

/**
 * Типы документов из docs/02-DATA-MODEL.md и §1.3: фото 3×4 бессрочно,
 * справка — год от загрузки, флюорография — год от даты снимка.
 * Новые типы заводит суперадмин через настройки, а не сид.
 */
export const DOCUMENT_TYPE_SEED = [
  {
    code: 'photo_3x4',
    nameI18n: { ru: 'Фото 3×4', kk: '3×4 фото', en: 'Photo 3×4' },
    validityMonths: null,
    requiresIssueDate: false,
    sortOrder: 10,
  },
  {
    code: 'dispensary',
    nameI18n: {
      ru: 'Справка ПНД/нарко/пневмо',
      kk: 'ПНД/нарко/пневмо анықтамасы',
      en: 'Dispensary certificate',
    },
    validityMonths: 12,
    requiresIssueDate: false,
    sortOrder: 20,
  },
  {
    code: 'fluorography',
    nameI18n: { ru: 'Флюорография', kk: 'Флюорография', en: 'Fluorography' },
    validityMonths: 12,
    requiresIssueDate: true,
    sortOrder: 30,
  },
] as const;

/**
 * Базовый шаблон договора. Суперадмин правит его в настройках сети;
 * без активного шаблона договор не собрать вовсе, поэтому пустая установка
 * получает рабочий минимум, а не отказ на первом же заселении (P2-18).
 */
export const CONTRACT_TEMPLATE_HTML = [
  '<h1>Договор найма койко-места</h1>',
  '<p>Договор № {{residency.contract_number}} от {{today}}</p>',
  '<p>Наймодатель: {{house.name}}, адрес: {{house.address}}.</p>',
  '<p>Наниматель: {{resident.full_name}}, ИИН {{resident.iin}}.</p>',
  '<p>Удостоверение выдано: {{resident.id_doc_issuer}}.</p>',
  '<p>Адрес прописки: {{resident.registration_address}}.</p>',
  '<p>Предмет договора: {{bed.room}}, {{bed.label}}.</p>',
  '<p>Плата за проживание: {{bed.price}} в месяц.</p>',
  '<p>Срок: с {{residency.contract_start}} по {{residency.contract_end}}.</p>',
  '<p>Подпись нанимателя:</p>',
].join('');

export interface SeedAccount {
  phone: string;
  role: 'superadmin' | 'admin';
  house?: string;
  /** Заполнен только у созданных сейчас: у существующих пароль не трогаем. */
  temporaryPassword?: string;
}

export interface SeedResult {
  orgId: string;
  houseIds: string[];
  accounts: SeedAccount[];
  /** Сколько жильцов завёл этот запуск: повторный не заводит никого. */
  residents: number;
}

export interface SeedOptions {
  executor?: Executor;
  /**
   * Пароль для создаваемой учётной записи. По умолчанию случайный.
   * Тесты передают предсказуемый, чтобы не выуживать его из вывода.
   */
  passwordFor?: (phone: string) => string;
  /**
   * Наполнять ли дома жильцами, зонами и рядами ротаций.
   * Прогон приёмок обходится каркасом: свои данные он заводит сам,
   * а чужие жильцы мешали бы его проверкам (P7-13).
   */
  withContent?: boolean;
  /** Сколько домов завести. По умолчанию — `HOUSE_COUNT`. */
  houses?: number;
}

async function ensureOrganization(executor: Executor): Promise<string> {
  const [existing] = await executor
    .select()
    .from(organizations)
    .where(eq(organizations.slug, ORG_SLUG))
    .limit(1);

  if (existing !== undefined) {
    return existing.id;
  }

  const [created] = await executor
    .insert(organizations)
    .values({ name: 'Nice Almaty', slug: ORG_SLUG })
    .returning();

  if (created === undefined) {
    throw new Error('Организация не создана');
  }

  return created.id;
}

async function ensureHouse(executor: Executor, orgId: string, number: number): Promise<string> {
  const slug = houseSlug(number);

  const [existing] = await executor.select().from(houses).where(eq(houses.slug, slug)).limit(1);

  if (existing !== undefined) {
    return existing.id;
  }

  const [created] = await executor
    .insert(houses)
    .values({ orgId, name: `Дом ${number}`, slug })
    .returning();

  if (created === undefined) {
    throw new Error(`Дом ${number} не создан`);
  }

  return created.id;
}

async function ensureUser(
  executor: Executor,
  input: {
    orgId: string;
    phone: string;
    role: 'superadmin' | 'admin';
    houseId: string | null;
    password: string;
  },
): Promise<{ created: boolean }> {
  const [existing] = await executor
    .select()
    .from(users)
    .where(eq(users.phone, input.phone))
    .limit(1);

  if (existing !== undefined) {
    return { created: false };
  }

  await executor.insert(users).values({
    orgId: input.orgId,
    phone: input.phone,
    passwordHash: await hashPassword(input.password),
    role: input.role,
    houseId: input.houseId,
    // Временный пароль обязателен к смене при первом входе.
    mustChangePassword: true,
  });

  return { created: true };
}

/** Типы документов сети. Существующие не трогаются: срок мог быть изменён вручную. */
async function ensureDocumentTypes(executor: Executor, orgId: string): Promise<void> {
  for (const type of DOCUMENT_TYPE_SEED) {
    const [existing] = await executor
      .select({ id: documentTypes.id })
      .from(documentTypes)
      .where(and(eq(documentTypes.orgId, orgId), eq(documentTypes.code, type.code)))
      .limit(1);

    if (existing !== undefined) {
      continue;
    }

    await executor.insert(documentTypes).values({
      orgId,
      code: type.code,
      nameI18n: type.nameI18n,
      validityMonths: type.validityMonths,
      requiresIssueDate: type.requiresIssueDate,
      sortOrder: type.sortOrder,
    });
  }
}

/**
 * План счетов сети (§10.1). Счета системные: на них стоят типовые проводки,
 * и удалить их нельзя. Фонд дома заводится по одному на дом — иначе деньги
 * пяти домов слились бы в одну кучу, а §10.1 требует обратного.
 */
const NETWORK_ACCOUNTS = [
  { code: ACCOUNT_CODES.depositFund, name: 'Депозитный фонд', type: 'deposit_fund' as const },
  { code: ACCOUNT_CODES.utilityFund, name: 'Коммунальный фонд', type: 'utility_fund' as const },
  { code: ACCOUNT_CODES.commonFund, name: 'Общий счёт', type: 'common_fund' as const },
  { code: ACCOUNT_CODES.cash, name: 'Касса', type: 'cash' as const },
  { code: ACCOUNT_CODES.kaspi, name: 'Kaspi', type: 'kaspi' as const },
];

async function ensureAccount(
  executor: Executor,
  input: {
    orgId: string;
    code: string;
    name: string;
    type: (typeof NETWORK_ACCOUNTS)[number]['type'] | 'house_fund';
    houseId?: string | null;
  },
): Promise<void> {
  const [existing] = await executor
    .select({ id: accountsTable.id })
    .from(accountsTable)
    .where(and(eq(accountsTable.orgId, input.orgId), eq(accountsTable.code, input.code)))
    .limit(1);

  if (existing !== undefined) {
    return;
  }

  await executor.insert(accountsTable).values({
    orgId: input.orgId,
    code: input.code,
    name: input.name,
    type: input.type,
    houseId: input.houseId ?? null,
    isSystem: true,
  });
}

async function ensureAccounts(
  executor: Executor,
  orgId: string,
  houseIds: readonly string[],
): Promise<void> {
  for (const account of NETWORK_ACCOUNTS) {
    await ensureAccount(executor, { orgId, ...account });
  }

  for (const [index, houseId] of houseIds.entries()) {
    const number = index + 1;

    await ensureAccount(executor, {
      orgId,
      code: houseFundCode(houseSlug(number)),
      name: `Фонд дома ${String(number)}`,
      type: 'house_fund',
      houseId,
    });
  }
}

/** Шаблон договора заводится один раз: правки суперадмина сид не откатывает. */
async function ensureContractTemplate(executor: Executor, orgId: string): Promise<void> {
  const [existing] = await executor
    .select({ id: contractTemplates.id })
    .from(contractTemplates)
    .where(eq(contractTemplates.orgId, orgId))
    .limit(1);

  if (existing !== undefined) {
    return;
  }

  await executor.insert(contractTemplates).values({
    orgId,
    name: 'Базовый договор найма',
    version: 1,
    bodyHtml: CONTRACT_TEMPLATE_HTML,
    tokens: [],
    isActive: true,
  });
}

export async function seedNetwork(options: SeedOptions = {}): Promise<SeedResult> {
  const executor = options.executor ?? getDb();
  const passwordFor = options.passwordFor ?? (() => generateTemporaryPassword());

  const orgId = await ensureOrganization(executor);
  const houseIds: string[] = [];
  const accounts: SeedAccount[] = [];

  const houseCount = options.houses ?? HOUSE_COUNT;

  for (let number = 1; number <= houseCount; number += 1) {
    houseIds.push(await ensureHouse(executor, orgId, number));
  }

  const superadminPassword = passwordFor(SUPERADMIN_PHONE);
  const superadmin = await ensureUser(executor, {
    orgId,
    phone: SUPERADMIN_PHONE,
    role: 'superadmin',
    houseId: null,
    password: superadminPassword,
  });

  accounts.push({
    phone: SUPERADMIN_PHONE,
    role: 'superadmin',
    ...(superadmin.created ? { temporaryPassword: superadminPassword } : {}),
  });

  for (let number = 1; number <= houseCount; number += 1) {
    const phone = adminPhone(number);
    const password = passwordFor(phone);
    const admin = await ensureUser(executor, {
      orgId,
      phone,
      role: 'admin',
      houseId: houseIds[number - 1] ?? null,
      password,
    });

    accounts.push({
      phone,
      role: 'admin',
      house: `Дом ${number}`,
      ...(admin.created ? { temporaryPassword: password } : {}),
    });
  }

  await ensureDocumentTypes(executor, orgId);
  await ensureContractTemplate(executor, orgId);
  await ensureAccounts(executor, orgId, houseIds);

  /*
   * Наполнение — отдельный шаг: прогон приёмок обходится каркасом,
   * а живой установке нужна сеть, в которой уже есть кого расселять.
   */
  const content =
    options.withContent === false
      ? { residents: 0 }
      : await seedContent(executor, orgId, houseIds, passwordFor);

  return { orgId, houseIds, accounts, residents: content.residents };
}
