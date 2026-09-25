import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { ForbiddenError, ValidationError } from '@/lib/errors';

import {
  archiveDeclaration,
  assertDeclaredFieldsFilled,
  declareField,
  readDeclaredFields,
  saveDeclaredFields,
} from './profile-fields';

import type { AccessContext } from '@/db/access';
import type { Database, Transaction } from '@/db/client';
import type { UserActor } from './users';

/**
 * Дополнительные поля профиля: доступ, запись, журнал (T12.2).
 *
 * Обязательность проверяется здесь запросом мимо формы: «браузер не пустит»
 * ничего не значит для `/api/v1` и бота, а значит и для данных.
 */
const url = testDatabaseUrl();
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

async function refusal(body: () => Promise<unknown>): Promise<{
  code: string;
  field: unknown;
}> {
  try {
    await body();
  } catch (error) {
    const thrown = error as { details?: { field?: unknown }; message: string };

    return { code: thrown.message, field: thrown.details?.field };
  }

  throw new Error('ожидался отказ, а его не было');
}

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `pf-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [house] = await tx
    .insert(schema.houses)
    .values({ orgId, name: 'Дом A', slug: `pf-a-${suffix}` })
    .returning();
  const houseId = house?.id ?? '';

  const [superUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7770${suffix}`, passwordHash: 'x', role: 'superadmin' })
    .returning();

  const [adminUser] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7771${suffix}`, passwordHash: 'x', role: 'admin', houseId })
    .returning();

  const [resident] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+7772${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  const context = (
    role: AccessContext['role'],
    userId: string,
    ownHouse: string | null,
  ): AccessContext => ({ orgId, userId, role, houseId: ownHouse });

  return {
    orgId,
    houseId,
    residentId: resident?.id ?? '',
    superadmin: { context: context('superadmin', superUser?.id ?? '', null) } as UserActor,
    admin: { context: context('admin', adminUser?.id ?? '', houseId) } as UserActor,
    resident: { context: context('resident', resident?.id ?? '', null) } as UserActor,
  };
}

const TEXT_FIELD = {
  code: 'kafedra',
  nameI18n: { ru: 'Кафедра', kk: 'Кафедра', en: 'Department' },
  type: 'text' as const,
  isRequired: false,
  options: [],
  sortOrder: 1,
};

describe('объявление полей', () => {
  it('заводит суперадмин, админу отказано', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3001');

      const created = await declareField(fixture.superadmin, TEXT_FIELD, tx);

      await expect(
        declareField(fixture.admin, { ...TEXT_FIELD, code: 'svoe' }, tx),
      ).rejects.toThrow(ForbiddenError);
      expect(created.code).toBe('kafedra');
    });
  });

  it('объявление пишется в журнал', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3002');
      const created = await declareField(fixture.superadmin, TEXT_FIELD, tx);

      const entries = await tx
        .select()
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.entityType, 'profile_field_def'),
            eq(schema.auditLog.entityId, created.id),
          ),
        );

      expect(entries.map((entry) => entry.action)).toEqual(['profile_field.declared']);
    });
  });

  it('код занят и архивированным полем', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3003');
      const created = await declareField(fixture.superadmin, TEXT_FIELD, tx);

      await archiveDeclaration(fixture.superadmin, created.id, true, tx);

      await expect(declareField(fixture.superadmin, TEXT_FIELD, tx)).rejects.toThrow(
        ValidationError,
      );
    });
  });

  it('выбор без вариантов не объявляется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3004');

      expect(
        await refusal(() =>
          declareField(fixture.superadmin, { ...TEXT_FIELD, type: 'choice' }, tx),
        ),
      ).toEqual({ code: 'profileFieldOptionsRequired', field: undefined });
    });
  });
});

describe('значения полей у жильца', () => {
  it('пишутся, читаются и дают по записи в журнал на поле', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3101');
      await declareField(fixture.superadmin, TEXT_FIELD, tx);
      await declareField(
        fixture.superadmin,
        { ...TEXT_FIELD, code: 'kurs', type: 'number', sortOrder: 2 },
        tx,
      );

      const saved = await saveDeclaredFields(
        fixture.superadmin,
        fixture.residentId,
        { kafedra: 'Механика', kurs: '3' },
        tx,
      );

      const entries = await tx
        .select()
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.entityType, 'profile_field_value'),
            eq(schema.auditLog.entityId, fixture.residentId),
          ),
        );

      expect(saved.map((field) => [field.code, field.value])).toEqual([
        ['kafedra', 'Механика'],
        ['kurs', '3'],
      ]);
      expect(entries).toHaveLength(2);
    });
  });

  it('неизменённое значение журнал не тревожит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3102');
      await declareField(fixture.superadmin, TEXT_FIELD, tx);

      await saveDeclaredFields(fixture.superadmin, fixture.residentId, { kafedra: 'Механика' }, tx);
      await saveDeclaredFields(fixture.superadmin, fixture.residentId, { kafedra: 'Механика' }, tx);

      const entries = await tx
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.entityType, 'profile_field_value'));

      expect(entries).toHaveLength(1);
    });
  });

  it('обязательное поле мимо формы не проходит, и отказ называет поле', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3103');
      await declareField(fixture.superadmin, { ...TEXT_FIELD, isRequired: true }, tx);

      expect(
        await refusal(() =>
          saveDeclaredFields(fixture.superadmin, fixture.residentId, { kafedra: '' }, tx),
        ),
      ).toEqual({ code: 'profileFieldRequired', field: 'kafedra' });
    });
  });

  it('значение не того типа мимо формы не проходит', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3104');
      await declareField(fixture.superadmin, { ...TEXT_FIELD, code: 'kurs', type: 'number' }, tx);

      expect(
        await refusal(() =>
          saveDeclaredFields(fixture.superadmin, fixture.residentId, { kurs: 'скоро' }, tx),
        ),
      ).toEqual({ code: 'profileFieldNotNumber', field: 'kurs' });
    });
  });

  it('незаявленный код не проходит молча', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3105');
      await declareField(fixture.superadmin, TEXT_FIELD, tx);

      expect(
        await refusal(() =>
          saveDeclaredFields(fixture.superadmin, fixture.residentId, { vydumka: 'x' }, tx),
        ),
      ).toEqual({ code: 'profileFieldUnknown', field: 'vydumka' });
    });
  });

  it('архивированное поле читается со значением, но не перезаписывается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3106');
      const def = await declareField(fixture.superadmin, TEXT_FIELD, tx);

      await saveDeclaredFields(fixture.superadmin, fixture.residentId, { kafedra: 'Механика' }, tx);
      await archiveDeclaration(fixture.superadmin, def.id, true, tx);

      const fields = await readDeclaredFields(fixture.superadmin, fixture.residentId, tx);

      expect(fields.map((field) => [field.code, field.value, field.isArchived])).toEqual([
        ['kafedra', 'Механика', true],
      ]);
      expect(
        await refusal(() =>
          saveDeclaredFields(fixture.superadmin, fixture.residentId, { kafedra: 'Физика' }, tx),
        ),
      ).toEqual({ code: 'profileFieldArchived', field: 'kafedra' });
    });
  });

  it('архивация соседнего поля чужому сохранению не мешает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3111');
      const first = await declareField(fixture.superadmin, TEXT_FIELD, tx);
      await declareField(
        fixture.superadmin,
        { ...TEXT_FIELD, code: 'kurs', type: 'number', sortOrder: 2 },
        tx,
      );

      await archiveDeclaration(fixture.superadmin, first.id, true, tx);

      /*
       * Форма отрисовалась до архивации и присылает пустое значение
       * архивированного поля вместе с новым значением живого. Отказывать
       * тут нечему: ничего в архив не пишется.
       */
      const saved = await saveDeclaredFields(
        fixture.superadmin,
        fixture.residentId,
        { kafedra: '', kurs: '3' },
        tx,
      );

      expect(saved.map((field) => [field.code, field.value])).toEqual([['kurs', '3']]);
    });
  });

  it('прежнее значение архивированного поля присылать можно, новое — нельзя', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3112');
      const def = await declareField(fixture.superadmin, TEXT_FIELD, tx);

      await saveDeclaredFields(fixture.superadmin, fixture.residentId, { kafedra: 'Механика' }, tx);
      await archiveDeclaration(fixture.superadmin, def.id, true, tx);

      const unchanged = await saveDeclaredFields(
        fixture.superadmin,
        fixture.residentId,
        { kafedra: 'Механика' },
        tx,
      );

      expect(unchanged.map((field) => field.value)).toEqual(['Механика']);
      expect(
        await refusal(() =>
          saveDeclaredFields(fixture.superadmin, fixture.residentId, { kafedra: 'Физика' }, tx),
        ),
      ).toEqual({ code: 'profileFieldArchived', field: 'kafedra' });
    });
  });

  it('архивированное поле без значения в карточке не появляется', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3107');
      const def = await declareField(fixture.superadmin, TEXT_FIELD, tx);

      await archiveDeclaration(fixture.superadmin, def.id, true, tx);

      expect(await readDeclaredFields(fixture.superadmin, fixture.residentId, tx)).toEqual([]);
    });
  });

  it('обязательное архивированное поле заселению не мешает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3108');
      const def = await declareField(fixture.superadmin, { ...TEXT_FIELD, isRequired: true }, tx);

      await archiveDeclaration(fixture.superadmin, def.id, true, tx);

      await expect(
        assertDeclaredFieldsFilled(fixture.superadmin, fixture.residentId, tx),
      ).resolves.toBeUndefined();
    });
  });

  it('незаполненное обязательное поле останавливает шаг, требующий профиля', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3109');
      await declareField(fixture.superadmin, { ...TEXT_FIELD, isRequired: true }, tx);

      await expect(
        assertDeclaredFieldsFilled(fixture.superadmin, fixture.residentId, tx),
      ).rejects.toThrow(ValidationError);
    });
  });

  it('жилец своих полей не правит чужому', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '3110');
      await declareField(fixture.superadmin, TEXT_FIELD, tx);

      await expect(
        saveDeclaredFields(
          fixture.resident,
          fixture.superadmin.context.userId,
          { kafedra: 'x' },
          tx,
        ),
      ).rejects.toThrow();
    });
  });
});
