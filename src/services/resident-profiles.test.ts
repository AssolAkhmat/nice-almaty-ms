import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `decryptForContract` расшифровывает ИИН и номер удостоверения **без
 * проверки полномочия** — ей это и положено: договор собирает сервер,
 * и значение уходит в документ, а не человеку на экран (указание владельца,
 * 23 сентября 2026).
 *
 * Ровно поэтому у неё должно быть одно место вызова. Проверка сканирует
 * исходники: второй вызов роняет прогон, и обойти полномочие «раскрыть
 * ИИН» тихой заменой одной функции на другую не получится.
 */
const SERVICES = new URL('.', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

const ALLOWED = new Set(['contracts.ts', 'resident-profiles.ts']);

describe('расшифровка секретов в обход полномочия', () => {
  it('зовётся только из сборки договора', () => {
    const offenders = readdirSync(SERVICES)
      .filter((name) => name.endsWith('.ts') && !name.includes('.test.'))
      .filter((name) => !ALLOWED.has(name))
      .filter((name) => readFileSync(join(SERVICES, name), 'utf8').includes('decryptForContract'));

    expect(offenders).toEqual([]);
  });

  it('сама проверка ловит лишний вызов', () => {
    const fixture = 'const value = await decryptForContract(actor, userId, "iin", tx);';

    expect(fixture.includes('decryptForContract')).toBe(true);
  });
});
