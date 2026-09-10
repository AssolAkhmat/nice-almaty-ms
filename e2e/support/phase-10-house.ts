import { and, eq } from 'drizzle-orm';

import * as schema from '../../src/db/schema';
import { houseSlug } from '../../src/db/seed';
import { hashPassword } from '../../src/lib/password';
import { openDb, type E2eDb } from './db';

/**
 * Дом раздела 3 плана фазы 10: пятнадцать жильцов на местах и двое,
 * заселяющихся позже, семь общих зон с чек-листами.
 *
 * Строится прямо в базе: через экраны пятнадцать заселений с депозитами
 * заняли бы больше времени, чем вся проверка модели, а проверяется здесь
 * не заселение — оно принято в фазе 2, — а ряды, нормы и сетка. Ряды,
 * составы, нормы, расписание и правки идут через интерфейс.
 *
 * Сборка идемпотентна по именам и номерам: `global-setup` убирает жильцов
 * по префиксу номера и ряды дома перед каждым прогоном, комнаты и зоны
 * переживают прогон и находятся заново.
 */
export const PHASE_TEN_ZONES = {
  kitchen: 'Кухня',
  bathroom: 'Санузел',
  corridor: 'Коридор',
  hall: 'Зал/лестница + 2 этаж + прихожая',
  yard: 'Двор',
  fridge: 'Холодильник',
  veranda: 'Веранда',
} as const;

export type PhaseTenZone = keyof typeof PHASE_TEN_ZONES;

/** A–O живут с самого начала, P и Q заселяются по ходу сценария (раздел 3). */
export const PHASE_TEN_LETTERS = [...'ABCDEFGHIJKLMNOPQ'];

/** Номера жильцов дома фазы 10: `global-setup` убирает их по этому префиксу. */
export const PHASE_TEN_PHONE_PREFIX = '+7703';

const PASSWORD = 'parol-zhiltsa-faza-10';

export interface PhaseTenResident {
  letter: string;
  userId: string;
  bedId: string;
  /** Фамилия, по которой жилец узнаётся в календаре. */
  name: string;
}

export interface PhaseTenHouse {
  houseId: string;
  zoneIds: Record<PhaseTenZone, string>;
  residents: PhaseTenResident[];
}

function residentPhone(houseNumber: number, index: number): string {
  return `${PHASE_TEN_PHONE_PREFIX}${String(houseNumber).padStart(2, '0')}${String(index).padStart(5, '0')}`;
}

async function ensureArea(
  db: E2eDb,
  houseId: string,
  name: string,
  type: 'living' | 'common',
  sortOrder: number,
): Promise<string> {
  const [existing] = await db
    .select({ id: schema.areas.id })
    .from(schema.areas)
    .where(and(eq(schema.areas.houseId, houseId), eq(schema.areas.name, name)))
    .limit(1);

  if (existing !== undefined) {
    return existing.id;
  }

  const [created] = await db
    .insert(schema.areas)
    .values({ houseId, type, name, sortOrder })
    .returning();

  return created?.id ?? '';
}

async function ensureBed(
  db: E2eDb,
  houseId: string,
  areaId: string,
  label: string,
  number: number,
): Promise<string> {
  const [existing] = await db
    .select({ id: schema.beds.id })
    .from(schema.beds)
    .where(and(eq(schema.beds.houseId, houseId), eq(schema.beds.label, label)))
    .limit(1);

  if (existing !== undefined) {
    return existing.id;
  }

  const [created] = await db
    .insert(schema.beds)
    .values({ houseId, areaId, label, number, tier: 'lower', defaultPrice: 70_000 })
    .returning();

  return created?.id ?? '';
}

async function ensureChecklist(db: E2eDb, areaId: string, title: string, people: number) {
  const [existing] = await db
    .select({ id: schema.areaChecklists.id })
    .from(schema.areaChecklists)
    .where(and(eq(schema.areaChecklists.areaId, areaId), eq(schema.areaChecklists.type, 'regular')))
    .limit(1);

  if (existing !== undefined) {
    return;
  }

  await db.insert(schema.areaChecklists).values({
    areaId,
    type: 'regular',
    title,
    peopleNeeded: people,
    items: ['Убрать'],
  });
}

async function ensureResident(
  db: E2eDb,
  input: {
    orgId: string;
    houseId: string;
    phone: string;
    passwordHash: string;
    letter: string;
    bedId: string;
  },
): Promise<PhaseTenResident> {
  const name = `Жилец-${input.letter}`;

  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.phone, input.phone))
    .limit(1);

  const userId =
    existing?.id ??
    (
      await db
        .insert(schema.users)
        .values({
          orgId: input.orgId,
          phone: input.phone,
          passwordHash: input.passwordHash,
          role: 'resident',
          mustChangePassword: false,
        })
        .returning()
    )[0]?.id ??
    '';

  const [profile] = await db
    .select({ userId: schema.residentProfiles.userId })
    .from(schema.residentProfiles)
    .where(eq(schema.residentProfiles.userId, userId))
    .limit(1);

  if (profile === undefined) {
    await db
      .insert(schema.residentProfiles)
      .values({ userId, firstName: 'Тест', lastName: name, sex: 'male' });
  }

  const [residency] = await db
    .select({ id: schema.residencies.id })
    .from(schema.residencies)
    .where(and(eq(schema.residencies.userId, userId), eq(schema.residencies.status, 'active')))
    .limit(1);

  const residencyId =
    residency?.id ??
    (
      await db
        .insert(schema.residencies)
        .values({
          orgId: input.orgId,
          userId,
          houseId: input.houseId,
          status: 'active',
          moveInDate: '2026-09-01',
        })
        .returning()
    )[0]?.id ??
    '';

  const [assignment] = await db
    .select({ id: schema.bedAssignments.id })
    .from(schema.bedAssignments)
    .where(eq(schema.bedAssignments.residencyId, residencyId))
    .limit(1);

  if (assignment === undefined) {
    await db.insert(schema.bedAssignments).values({
      residencyId,
      bedId: input.bedId,
      price: 70_000,
      period: '[2026-09-01,)',
    });
  }

  return { letter: input.letter, userId, bedId: input.bedId, name };
}

export async function buildPhaseTenHouse(houseNumber: number): Promise<PhaseTenHouse> {
  const { db, close } = openDb();

  try {
    const [house] = await db
      .select({ id: schema.houses.id, orgId: schema.houses.orgId })
      .from(schema.houses)
      .where(eq(schema.houses.slug, houseSlug(houseNumber)))
      .limit(1);

    if (house === undefined) {
      throw new Error(`Дом ${houseNumber} не заведён: global-setup должен завести его первым`);
    }

    // Шесть комнат: пять по три места и одна на двоих — семнадцать мест.
    const bedIds: string[] = [];

    for (let room = 1; room <= 6; room += 1) {
      const areaId = await ensureArea(db, house.id, `Комната ф10-${room}`, 'living', 200 + room);
      const count = room === 6 ? 2 : 3;

      for (let number = 1; number <= count; number += 1) {
        bedIds.push(await ensureBed(db, house.id, areaId, `ф10-${bedIds.length + 1}`, number));
      }
    }

    const zoneIds = {} as Record<PhaseTenZone, string>;

    for (const [index, [key, name]] of Object.entries(PHASE_TEN_ZONES).entries()) {
      const areaId = await ensureArea(db, house.id, name, 'common', 300 + index);
      await ensureChecklist(db, areaId, `Уборка: ${name}`, key === 'yard' ? 2 : 1);
      zoneIds[key as PhaseTenZone] = areaId;
    }

    const passwordHash = await hashPassword(PASSWORD);
    const residents: PhaseTenResident[] = [];

    for (const [index, letter] of PHASE_TEN_LETTERS.entries()) {
      residents.push(
        await ensureResident(db, {
          orgId: house.orgId,
          houseId: house.id,
          phone: residentPhone(houseNumber, index + 1),
          passwordHash,
          letter,
          bedId: bedIds[index] ?? '',
        }),
      );
    }

    return { houseId: house.id, zoneIds, residents };
  } finally {
    await close();
  }
}
