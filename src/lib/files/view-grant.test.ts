import { describe, expect, it } from 'vitest';

import { parseInstant } from '@/lib/time';

import {
  deriveViewGrantKey,
  issueViewGrant,
  verifyViewGrant,
  VIEW_GRANT_TTL_SECONDS,
} from './view-grant';

/**
 * Пропуск на содержимое файла живёт пять минут (указание владельца,
 * 22 сентября 2026). Здесь — что он действительно перестаёт работать,
 * а не просто объявлен коротким: проверки ниже ломают его по одной
 * составляющей за раз.
 */
const SECRET = 'секрет-сессий-не-короче-тридцати-двух-символов';
const OTHER_SECRET = 'другой-секрет-той-же-длины-для-проверки-подписи';

const AT = parseInstant('2026-09-22T12:00:00+05:00');
const TARGET = {
  fileId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  disposition: 'inline' as const,
};

async function key(secret = SECRET) {
  return deriveViewGrantKey(secret);
}

function later(seconds: number): Date {
  return new Date(AT.getTime() + seconds * 1000);
}

describe('пропуск на содержимое файла', () => {
  it('свежий пропуск принимается', async () => {
    const signing = await key();
    const grant = await issueViewGrant(TARGET, AT, signing);

    expect(await verifyViewGrant(grant, TARGET, AT, signing)).toBe('ok');
  });

  it('живёт ровно пять минут', async () => {
    const signing = await key();
    const grant = await issueViewGrant(TARGET, AT, signing);

    expect(await verifyViewGrant(grant, TARGET, later(VIEW_GRANT_TTL_SECONDS - 1), signing)).toBe(
      'ok',
    );
    expect(await verifyViewGrant(grant, TARGET, later(VIEW_GRANT_TTL_SECONDS), signing)).toBe(
      'expired',
    );
    expect(await verifyViewGrant(grant, TARGET, later(VIEW_GRANT_TTL_SECONDS + 1), signing)).toBe(
      'expired',
    );
  });

  it('чужому человеку не подходит', async () => {
    const signing = await key();
    const grant = await issueViewGrant(TARGET, AT, signing);

    expect(
      await verifyViewGrant(
        grant,
        { ...TARGET, userId: '33333333-3333-4333-8333-333333333333' },
        AT,
        signing,
      ),
    ).toBe('invalid');
  });

  it('на другой файл не подходит', async () => {
    const signing = await key();
    const grant = await issueViewGrant(TARGET, AT, signing);

    expect(
      await verifyViewGrant(
        grant,
        { ...TARGET, fileId: '44444444-4444-4444-8444-444444444444' },
        AT,
        signing,
      ),
    ).toBe('invalid');
  });

  it('просмотр не превращается в скачивание подменой буквы в адресе', async () => {
    const signing = await key();
    const grant = await issueViewGrant(TARGET, AT, signing);

    expect(
      await verifyViewGrant(grant, { ...TARGET, disposition: 'attachment' }, AT, signing),
    ).toBe('invalid');
  });

  it('срок нельзя продлить, переписав его в самом пропуске', async () => {
    const signing = await key();
    const grant = await issueViewGrant(TARGET, AT, signing);
    const [, disposition, signature] = grant.split('.');

    const stretched = `${String(Math.floor(AT.getTime() / 1000) + 86_400)}.${String(disposition)}.${String(signature)}`;

    expect(await verifyViewGrant(stretched, TARGET, later(3_600), signing)).toBe('invalid');
  });

  it('подпись чужим ключом не принимается', async () => {
    const grant = await issueViewGrant(TARGET, AT, await key(OTHER_SECRET));

    expect(await verifyViewGrant(grant, TARGET, AT, await key())).toBe('invalid');
  });

  it('мусор вместо пропуска — отказ, а не исключение', async () => {
    const signing = await key();

    for (const token of ['', '.', 'a.b', 'a.b.c.d', 'нет.inline.deadbeef', '123.inline.']) {
      expect(await verifyViewGrant(token, TARGET, AT, signing)).toBe('invalid');
    }
  });
});
