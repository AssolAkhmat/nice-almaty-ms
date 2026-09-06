import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import en from '../../../messages/en.json';
import kk from '../../../messages/kk.json';
import ru from '../../../messages/ru.json';
import { DEFAULT_LOCALE, isLocale, LOCALES } from './config';

type MessageTree = { [key: string]: string | MessageTree };

const catalogues: Record<string, MessageTree> = { ru, kk, en };

function flatten(tree: MessageTree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return typeof value === 'string' ? [path] : flatten(value, path);
  });
}

describe('локали', () => {
  it('перечислены ru, kk, en, по умолчанию ru', () => {
    expect(LOCALES).toEqual(['ru', 'kk', 'en']);
    expect(DEFAULT_LOCALE).toBe('ru');
  });

  it('распознаёт только известные коды', () => {
    expect(isLocale('kk')).toBe(true);
    expect(isLocale('de')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it('каждой локали соответствует файл сообщений', () => {
    for (const locale of LOCALES) {
      expect(catalogues[locale]).toBeDefined();
    }
  });

  it('во всех трёх локалях одинаковый набор ключей', () => {
    const reference = flatten(catalogues[DEFAULT_LOCALE] ?? {}).sort();

    for (const locale of LOCALES) {
      const keys = flatten(catalogues[locale] ?? {}).sort();

      expect(keys, `локаль ${locale}`).toEqual(reference);
    }
  });

  it('ни одно значение не пустое', () => {
    for (const locale of LOCALES) {
      const tree = catalogues[locale] ?? {};

      for (const key of flatten(tree)) {
        const value = key
          .split('.')
          .reduce<string | MessageTree | undefined>(
            (node, part) => (typeof node === 'object' ? node[part] : undefined),
            tree,
          );

        expect(typeof value === 'string' && value.trim().length > 0, `${locale}: ${key}`).toBe(
          true,
        );
      }
    }
  });

  /**
   * Журнал аудита показывает сущности словами. Каждая новая сущность
   * приносит с собой запись в словаре: без неё экран показывал бы код,
   * а до появления запасного варианта — падал целиком (P2-45).
   */
  it('в словаре есть каждая сущность, о которой пишется журнал', () => {
    const types = new Set<string>();

    function walk(directory: string): void {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);

        if (entry.isDirectory()) {
          walk(path);
          continue;
        }

        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) {
          continue;
        }

        for (const match of readFileSync(path, 'utf8').matchAll(/entityType: '([a-z_]+)'/g)) {
          const type = match[1];
          if (type !== undefined) {
            types.add(type);
          }
        }
      }
    }

    walk(join(import.meta.dirname, '..', '..'));

    expect(types.size).toBeGreaterThan(0);

    for (const locale of LOCALES) {
      const entities = (catalogues[locale]?.audit as MessageTree | undefined)?.entities;

      for (const type of types) {
        expect(
          typeof (entities as MessageTree | undefined)?.[type],
          `${locale}: audit.entities.${type}`,
        ).toBe('string');
      }
    }
  });
});
