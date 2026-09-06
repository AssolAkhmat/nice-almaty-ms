import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { parseBusinessDate } from '@/lib/time';

import { readOnboarding, type OnboardingStepKey } from './onboarding';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Мастер заселения (§1.2): шаги закрываются в том порядке, в каком идут,
 * и ни один не закрывается сам по себе. Проверяется по состоянию базы,
 * а не по флагу: флаг однажды разойдётся с данными.
 */
const url = process.env.TEST_DATABASE_URL ?? 'postgres://nice:nice@localhost:5432/nice_almaty';
const client = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => undefined });
const db = drizzle(client, { schema }) as unknown as Database;

afterAll(async () => {
  await client.end();
});

class Rollback extends Error {}

async function inRollback(body: (tx: Transaction) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await body(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error;
    }
  }
}

const TODAY = parseBusinessDate('2026-09-15');

function stepDone(
  steps: readonly { key: OnboardingStepKey; done: boolean }[],
  key: OnboardingStepKey,
) {
  return steps.find((step) => step.key === key)?.done ?? false;
}

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `onb-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `onb-a-${suffix}` })
    .returning();

  const [user] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7700${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  const [residency] = await tx
    .insert(schema.residencies)
    .values({ orgId, userId: user?.id ?? '', houseId: house?.id ?? '' })
    .returning();

  const [type] = await tx
    .insert(schema.documentTypes)
    .values({
      orgId,
      code: 'photo_3x4',
      nameI18n: { ru: 'Фото 3×4' },
      validityMonths: null,
      requiresIssueDate: false,
      isRequired: true,
    })
    .returning();

  const context: AccessContext = {
    orgId,
    userId: user?.id ?? '',
    role: 'resident',
    houseId: null,
  };

  return {
    orgId,
    houseId: house?.id ?? '',
    userId: user?.id ?? '',
    residencyId: residency?.id ?? '',
    typeId: type?.id ?? '',
    actor: { context } satisfies UserActor,
  };
}

describe('шаги заселения', () => {
  it('без проживания все шаги открыты, а модули закрыты', async () => {
    await inRollback(async (tx) => {
      const [org] = await tx
        .insert(schema.organizations)
        .values({ name: 'Nice Almaty', slug: 'onb-empty' })
        .returning();
      const [user] = await tx
        .insert(schema.users)
        .values({
          orgId: org?.id ?? '',
          phone: '+77009000',
          passwordHash: 'x',
          role: 'resident',
        })
        .returning();

      const view = await readOnboarding(
        {
          context: {
            orgId: org?.id ?? '',
            userId: user?.id ?? '',
            role: 'resident',
            houseId: null,
          },
        },
        { executor: tx, today: TODAY },
      );

      expect(view.residency).toBeNull();
      expect(view.scope).toBe('onboarding');
      expect(view.steps.every((step) => !step.done)).toBe(true);
    });
  });

  it('пустой профиль шага не закрывает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9001');

      const view = await readOnboarding(fixture.actor, { executor: tx, today: TODAY });

      expect(stepDone(view.steps, 'profile')).toBe(false);
    });
  });

  it('заполненный профиль закрывает первый шаг', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9002');
      await tx.insert(schema.residentProfiles).values({
        userId: fixture.userId,
        lastName: 'Иванов',
        firstName: 'Иван',
        sex: 'male',
        birthDate: '2005-01-01',
        phone: '+77009999999',
        university: 'КБТУ',
        course: 2,
        major: 'ИТ',
        emergencyName: 'Мама',
        emergencyPhone: '+77009999998',
        preferredPayment: 'kaspi',
        iinLast4: '0123',
        idDocLast4: '4567',
      });

      const view = await readOnboarding(fixture.actor, { executor: tx, today: TODAY });

      expect(stepDone(view.steps, 'profile')).toBe(true);
    });
  });

  it('назначенное место закрывает второй шаг', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9003');

      const [area] = await tx
        .insert(schema.areas)
        .values({ houseId: fixture.houseId, name: 'Комната 1', type: 'living' })
        .returning();
      const [bed] = await tx
        .insert(schema.beds)
        .values({
          houseId: fixture.houseId,
          areaId: area?.id ?? '',
          number: 1,
          tier: 'lower',
          label: 'Место 1',
          defaultPrice: 100_000,
        })
        .returning();

      await tx.insert(schema.bedAssignments).values({
        residencyId: fixture.residencyId,
        bedId: bed?.id ?? '',
        price: 100_000,
        period: '[2026-09-15,)',
      });

      const view = await readOnboarding(fixture.actor, { executor: tx, today: TODAY });

      expect(stepDone(view.steps, 'bed')).toBe(true);
    });
  });

  it('подписанный договор закрывает третий шаг', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9004');
      await tx
        .update(schema.residencies)
        .set({ contractSignedAt: new Date('2026-09-10T10:00:00.000Z') });

      const view = await readOnboarding(fixture.actor, { executor: tx, today: TODAY });

      expect(stepDone(view.steps, 'contract')).toBe(true);
    });
  });

  it('документ на проверке шага не закрывает, а принятый — закрывает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9005');

      const [file] = await tx
        .insert(schema.files)
        .values({
          orgId: fixture.orgId,
          residencyId: fixture.residencyId,
          provider: 'local',
          path: `onb-9005/photo`,
          mime: 'image/jpeg',
          sizeBytes: 100,
          originalName: 'photo.jpg',
          uploadedBy: fixture.userId,
          status: 'ready',
        })
        .returning();

      const [document] = await tx
        .insert(schema.documents)
        .values({
          orgId: fixture.orgId,
          userId: fixture.userId,
          residencyId: fixture.residencyId,
          documentTypeId: fixture.typeId,
          fileId: file?.id ?? '',
          validFrom: '2026-09-15',
          status: 'uploaded',
        })
        .returning();

      expect(
        stepDone(
          (await readOnboarding(fixture.actor, { executor: tx, today: TODAY })).steps,
          'documents',
        ),
      ).toBe(false);

      await tx.update(schema.documents).set({ status: 'approved' });
      void document;

      expect(
        stepDone(
          (await readOnboarding(fixture.actor, { executor: tx, today: TODAY })).steps,
          'documents',
        ),
      ).toBe(true);
    });
  });

  it('просроченный документ шаг не закрывает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9006');

      const [file] = await tx
        .insert(schema.files)
        .values({
          orgId: fixture.orgId,
          residencyId: fixture.residencyId,
          provider: 'local',
          path: `onb-9006/photo`,
          mime: 'image/jpeg',
          sizeBytes: 100,
          originalName: 'photo.jpg',
          uploadedBy: fixture.userId,
          status: 'ready',
        })
        .returning();

      await tx.insert(schema.documents).values({
        orgId: fixture.orgId,
        userId: fixture.userId,
        residencyId: fixture.residencyId,
        documentTypeId: fixture.typeId,
        fileId: file?.id ?? '',
        validFrom: '2025-09-15',
        validUntil: '2026-09-14',
        status: 'approved',
      });

      const view = await readOnboarding(fixture.actor, { executor: tx, today: TODAY });

      expect(stepDone(view.steps, 'documents')).toBe(false);
    });
  });

  it('оплаченный депозит закрывает последний шаг и снимает блокировку', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9007');
      await tx.update(schema.residencies).set({ status: 'active', moveInDate: '2026-09-15' });

      const view = await readOnboarding(fixture.actor, { executor: tx, today: TODAY });

      expect(stepDone(view.steps, 'deposit')).toBe(true);
      expect(view.scope).toBe('full');
    });
  });

  it('порядок шагов — тот же, что в §1.2', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '9008');

      const view = await readOnboarding(fixture.actor, { executor: tx, today: TODAY });

      expect(view.steps.map((step) => step.key)).toEqual([
        'profile',
        'bed',
        'contract',
        'documents',
        'deposit',
      ]);
    });
  });
});
