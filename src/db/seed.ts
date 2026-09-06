import { eq } from 'drizzle-orm';

import { generateTemporaryPassword, hashPassword } from '@/lib/password';

import { getDb, type Executor } from './client';
import { houses, organizations, users } from './schema';

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

export const HOUSE_COUNT = 5;

export const SUPERADMIN_PHONE = '+77010000000';

/** Телефоны админов: по одному на дом, номер совпадает с номером дома. */
export function adminPhone(houseNumber: number): string {
  return `+7701000000${houseNumber}`;
}

export function houseSlug(houseNumber: number): string {
  return `dom-${houseNumber}`;
}

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
}

export interface SeedOptions {
  executor?: Executor;
  /**
   * Пароль для создаваемой учётной записи. По умолчанию случайный.
   * Тесты передают предсказуемый, чтобы не выуживать его из вывода.
   */
  passwordFor?: (phone: string) => string;
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

export async function seedNetwork(options: SeedOptions = {}): Promise<SeedResult> {
  const executor = options.executor ?? getDb();
  const passwordFor = options.passwordFor ?? (() => generateTemporaryPassword());

  const orgId = await ensureOrganization(executor);
  const houseIds: string[] = [];
  const accounts: SeedAccount[] = [];

  for (let number = 1; number <= HOUSE_COUNT; number += 1) {
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

  for (let number = 1; number <= HOUSE_COUNT; number += 1) {
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

  return { orgId, houseIds, accounts };
}
