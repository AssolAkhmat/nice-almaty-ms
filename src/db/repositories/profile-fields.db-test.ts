import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import * as schema from '@/db/schema';
import { testDatabaseUrl } from '@/db/testing/database-url';
import { parseInstant } from '@/lib/time';

import {
  clearFieldValue,
  createFieldDef,
  listFieldDefs,
  listFieldValues,
  listFieldValuesOf,
  setFieldValue,
  updateFieldDef,
} from './profile-fields';

import type { AccessContext } from '../access';
import type { Database, Transaction } from '../client';

/**
 * Хранилище дополнительных полей профиля (T12.1).
 *
 * Проверки идут мимо сервиса, прямо в базу: утверждение «сервис не даст
 * записать чужое» держится на том, что мимо сервиса никто не ходит, а это
 * ничем не проверено. Поэтому каждое «так нельзя» здесь ломается запросом.
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

function errorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;

  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }

  return parts.join(' | ');
}

async function failureText(
  tx: Transaction,
  body: (inner: Transaction) => Promise<unknown>,
): Promise<string> {
  try {
    await tx.transaction(async (inner) => {
      await body(inner);
    });
    return '';
  } catch (error) {
    return errorChain(error);
  }
}

async function seed(tx: Transaction, suffix: string) {
  const [org] = await tx
    .insert(schema.organizations)
    .values({ name: 'Nice Almaty', slug: `field-${suffix}` })
    .returning();
  const orgId = org?.id ?? '';

  const [other] = await tx
    .insert(schema.organizations)
    .values({ name: 'Другая сеть', slug: `field-other-${suffix}` })
    .returning();
  const otherOrgId = other?.id ?? '';

  const [resident] = await tx
    .insert(schema.users)
    .values({ orgId, phone: `+77081${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();
  const [stranger] = await tx
    .insert(schema.users)
    .values({ orgId: otherOrgId, phone: `+77082${suffix}`, passwordHash: 'x', role: 'resident' })
    .returning();

  const superadmin: AccessContext = {
    orgId,
    userId: '00000000-0000-0000-0000-000000000000',
    role: 'superadmin',
    houseId: null,
  };

  return {
    orgId,
    otherOrgId,
    residentId: resident?.id ?? '',
    strangerId: stranger?.id ?? '',
    superadmin,
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

describe('объявленные поля профиля', () => {
  it('перечисляются по порядку, архивированные — только по требованию', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2001');

      await createFieldDef(fixture.superadmin, { ...TEXT_FIELD, code: 'vtoroe', sortOrder: 2 }, tx);
      const first = await createFieldDef(fixture.superadmin, TEXT_FIELD, tx);
      const archived = await createFieldDef(
        fixture.superadmin,
        { ...TEXT_FIELD, code: 'staroe', sortOrder: 3 },
        tx,
      );
      await updateFieldDef(
        fixture.superadmin,
        archived.id,
        { archivedAt: parseInstant('2026-09-01T00:00:00Z') },
        tx,
      );

      const live = await listFieldDefs(fixture.superadmin, {}, tx);
      const all = await listFieldDefs(fixture.superadmin, { includeArchived: true }, tx);

      expect(live.map((def) => def.code)).toEqual(['kafedra', 'vtoroe']);
      expect(all.map((def) => def.code)).toEqual(['kafedra', 'vtoroe', 'staroe']);
      expect(first.code).toBe('kafedra');
    });
  });

  it('код архивированного поля не освобождается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2002');
      const def = await createFieldDef(fixture.superadmin, TEXT_FIELD, tx);

      await updateFieldDef(
        fixture.superadmin,
        def.id,
        { archivedAt: parseInstant('2026-09-01T00:00:00Z') },
        tx,
      );

      const failure = await failureText(tx, (inner) =>
        createFieldDef(fixture.superadmin, TEXT_FIELD, inner),
      );

      expect(failure).toContain('profile_field_defs_org_code_unique');
    });
  });

  it('код не по форме токена база не принимает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2003');

      const failure = await failureText(tx, (inner) =>
        createFieldDef(fixture.superadmin, { ...TEXT_FIELD, code: 'Кафедра.1' }, inner),
      );

      expect(failure).toContain('profile_field_defs_code_shape');
    });
  });

  it('шестого типа не существует', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2004');

      const failure = await failureText(tx, (inner) =>
        inner.execute(sql`
          insert into profile_field_defs (org_id, code, type)
          values (${fixture.orgId}, 'fajl', 'file')
        `),
      );

      expect(failure).toContain('profile_field_type');
    });
  });

  it('выбор без вариантов и число с вариантами отвергаются', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2005');

      const emptyChoice = await failureText(tx, (inner) =>
        createFieldDef(fixture.superadmin, { ...TEXT_FIELD, type: 'choice' }, inner),
      );
      const numberWithOptions = await failureText(tx, (inner) =>
        createFieldDef(
          fixture.superadmin,
          { ...TEXT_FIELD, code: 'kurs', type: 'number', options: ['1', '2'] },
          inner,
        ),
      );

      expect(emptyChoice).toContain('profile_field_defs_options_shape');
      expect(numberWithOptions).toContain('profile_field_defs_options_shape');
    });
  });
});

describe('значения объявленных полей', () => {
  it('записываются, перезаписываются и стираются', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2101');
      const def = await createFieldDef(fixture.superadmin, TEXT_FIELD, tx);

      await setFieldValue(
        fixture.superadmin,
        { userId: fixture.residentId, fieldId: def.id, value: 'Механика' },
        tx,
      );
      await setFieldValue(
        fixture.superadmin,
        { userId: fixture.residentId, fieldId: def.id, value: 'Физика' },
        tx,
      );

      const afterWrite = await listFieldValues(fixture.superadmin, fixture.residentId, tx);

      await clearFieldValue(
        fixture.superadmin,
        { userId: fixture.residentId, fieldId: def.id },
        tx,
      );

      const afterClear = await listFieldValues(fixture.superadmin, fixture.residentId, tx);

      expect(afterWrite.map((row) => row.value)).toEqual(['Физика']);
      expect(afterClear).toEqual([]);
    });
  });

  it('значения нескольких людей читаются одним запросом', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2102');
      const def = await createFieldDef(fixture.superadmin, TEXT_FIELD, tx);

      await setFieldValue(
        fixture.superadmin,
        { userId: fixture.residentId, fieldId: def.id, value: 'Механика' },
        tx,
      );

      const rows = await listFieldValuesOf(
        fixture.superadmin,
        [fixture.residentId, fixture.strangerId],
        tx,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBe(fixture.residentId);
    });
  });

  it('значение не того типа база не принимает', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2103');
      const number = await createFieldDef(
        fixture.superadmin,
        { ...TEXT_FIELD, code: 'kurs', type: 'number' },
        tx,
      );
      const date = await createFieldDef(
        fixture.superadmin,
        { ...TEXT_FIELD, code: 'vydan', type: 'date' },
        tx,
      );
      const flag = await createFieldDef(
        fixture.superadmin,
        { ...TEXT_FIELD, code: 'obshchezhitie', type: 'boolean' },
        tx,
      );
      const choice = await createFieldDef(
        fixture.superadmin,
        { ...TEXT_FIELD, code: 'forma', type: 'choice', options: ['grant', 'platnoe'] },
        tx,
      );

      const notNumber = await failureText(tx, (inner) =>
        setFieldValue(
          fixture.superadmin,
          { userId: fixture.residentId, fieldId: number.id, value: 'скоро' },
          inner,
        ),
      );
      const notDate = await failureText(tx, (inner) =>
        setFieldValue(
          fixture.superadmin,
          { userId: fixture.residentId, fieldId: date.id, value: '2026-02-31' },
          inner,
        ),
      );
      const notFlag = await failureText(tx, (inner) =>
        setFieldValue(
          fixture.superadmin,
          { userId: fixture.residentId, fieldId: flag.id, value: 'да' },
          inner,
        ),
      );
      const notOption = await failureText(tx, (inner) =>
        setFieldValue(
          fixture.superadmin,
          { userId: fixture.residentId, fieldId: choice.id, value: 'skidka' },
          inner,
        ),
      );
      /* Пустоту проверяем на строковом поле: у числа раньше сработает тип. */
      const text = await createFieldDef(fixture.superadmin, TEXT_FIELD, tx);
      const empty = await failureText(tx, (inner) =>
        setFieldValue(
          fixture.superadmin,
          { userId: fixture.residentId, fieldId: text.id, value: '  ' },
          inner,
        ),
      );

      expect(notNumber).toContain('объявлено числом');
      expect(notDate).toContain('такой даты нет');
      expect(notFlag).toContain('объявлено да/нет');
      expect(notOption).toContain('не имеет варианта');
      expect(empty).toContain('пустое значение не хранится');
    });
  });

  it('в архивированное поле новое значение не пишется, прежнее читается', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2104');
      const def = await createFieldDef(fixture.superadmin, TEXT_FIELD, tx);

      await setFieldValue(
        fixture.superadmin,
        { userId: fixture.residentId, fieldId: def.id, value: 'Механика' },
        tx,
      );
      await updateFieldDef(
        fixture.superadmin,
        def.id,
        { archivedAt: parseInstant('2026-09-01T00:00:00Z') },
        tx,
      );

      const failure = await failureText(tx, (inner) =>
        setFieldValue(
          fixture.superadmin,
          { userId: fixture.residentId, fieldId: def.id, value: 'Физика' },
          inner,
        ),
      );
      const readable = await listFieldValues(fixture.superadmin, fixture.residentId, tx);

      expect(failure).toContain('архивировано');
      expect(readable.map((row) => row.value)).toEqual(['Механика']);
    });
  });

  it('значение поля чужой сети отвергает база, а не фильтр в сервисе', async () => {
    await inRollback(async (tx) => {
      const fixture = await seed(tx, '2105');
      const def = await createFieldDef(fixture.superadmin, TEXT_FIELD, tx);

      /* Человек из другой сети: составной ключ `(user_id, org_id)` не сойдётся. */
      const foreignUser = await failureText(tx, (inner) =>
        inner.execute(sql`
          insert into profile_field_values (org_id, user_id, field_id, value)
          values (${fixture.orgId}, ${fixture.strangerId}, ${def.id}, 'Механика')
        `),
      );

      /* То же поле, но сеть в строке подменена: не сойдётся ключ на поле. */
      const foreignField = await failureText(tx, (inner) =>
        inner.execute(sql`
          insert into profile_field_values (org_id, user_id, field_id, value)
          values (${fixture.otherOrgId}, ${fixture.strangerId}, ${def.id}, 'Механика')
        `),
      );

      expect(foreignUser).toContain('profile_field_values_user_org_fk');
      expect(foreignField).toContain('profile_field_values_field_org_fk');
    });
  });
});
