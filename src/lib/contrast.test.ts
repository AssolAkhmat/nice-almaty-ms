import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { contrastRatio, MIN_CONTRAST_LARGE, MIN_CONTRAST_TEXT } from './contrast';

const GLOBALS_CSS = join(import.meta.dirname, '..', 'app', 'globals.css');

/** Разбирает блок объявлений вида `--token: #rrggbb;`. */
function readTokens(selector: string): Record<string, string> {
  const css = readFileSync(GLOBALS_CSS, 'utf8');
  const block = new RegExp(selector + String.raw`\s*\{([^}]*)\}`).exec(css);

  expect(block, `в globals.css нет блока ${selector}`).not.toBeNull();

  const tokens: Record<string, string> = {};
  for (const [, name, value] of (block?.[1] ?? '').matchAll(
    /(--[\w-]+):\s*(#[0-9a-fA-F]{3,6});/g,
  )) {
    if (name !== undefined && value !== undefined) {
      tokens[name] = value;
    }
  }

  return tokens;
}

const light = readTokens(':root');
const dark = readTokens('[.]dark');

describe('расчёт контраста', () => {
  it('совпадает с числами из дизайн-системы', () => {
    expect(contrastRatio('#004aad', '#ffffff')).toBeCloseTo(8.1, 1);
    expect(contrastRatio('#fee274', '#ffffff')).toBeCloseTo(1.3, 1);
    expect(contrastRatio('#0b0b0c', '#fee274')).toBeCloseTo(15, 0);
    expect(contrastRatio('#4c8df6', '#0b0f17')).toBeCloseTo(5.9, 1);
  });

  it('одинаковые цвета дают 1, чёрное на белом — 21', () => {
    expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 5);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });
});

describe('палитра из globals.css', () => {
  it('содержит обе темы', () => {
    expect(Object.keys(light).length).toBeGreaterThan(10);
    expect(Object.keys(dark).length).toBeGreaterThan(10);
  });

  for (const [name, tokens] of [
    ['светлая', light],
    ['тёмная', dark],
  ] as const) {
    describe(`тема ${name}`, () => {
      it('основной текст читаем на фоне и на поверхностях', () => {
        for (const surface of ['--bg', '--surface', '--surface-2'] as const) {
          expect(
            contrastRatio(tokens['--text'] ?? '', tokens[surface] ?? ''),
            `--text на ${surface}`,
          ).toBeGreaterThanOrEqual(MIN_CONTRAST_TEXT);
        }
      });

      it('приглушённый текст читаем на фоне', () => {
        expect(
          contrastRatio(tokens['--text-muted'] ?? '', tokens['--bg'] ?? ''),
        ).toBeGreaterThanOrEqual(MIN_CONTRAST_TEXT);
      });

      it('текст на первичной кнопке читаем', () => {
        expect(
          contrastRatio(tokens['--primary-fg'] ?? '', tokens['--primary'] ?? ''),
        ).toBeGreaterThanOrEqual(MIN_CONTRAST_TEXT);
      });

      it('первичный цвет годится для ссылок и иконок на фоне', () => {
        expect(
          contrastRatio(tokens['--primary'] ?? '', tokens['--bg'] ?? ''),
        ).toBeGreaterThanOrEqual(MIN_CONTRAST_LARGE);
      });

      it('текст на жёлтом бейдже читаем', () => {
        expect(
          contrastRatio(tokens['--accent-fg'] ?? '', tokens['--accent'] ?? ''),
        ).toBeGreaterThanOrEqual(MIN_CONTRAST_TEXT);
      });

      it('статусные цвета различимы на фоне', () => {
        for (const token of ['--success', '--warning', '--danger'] as const) {
          expect(
            contrastRatio(tokens[token] ?? '', tokens['--bg'] ?? ''),
            `${token} на --bg`,
          ).toBeGreaterThanOrEqual(MIN_CONTRAST_LARGE);
        }
      });
    });
  }

  it('жёлтый нечитаем как текст на светлом фоне — поэтому им нельзя писать', () => {
    expect(contrastRatio(light['--accent'] ?? '', light['--bg'] ?? '')).toBeLessThan(
      MIN_CONTRAST_LARGE,
    );
  });

  it('фирменный синий нечитаем на тёмном фоне — поэтому в тёмной теме он осветлён', () => {
    expect(contrastRatio('#004aad', dark['--bg'] ?? '')).toBeLessThan(MIN_CONTRAST_LARGE);
    expect(dark['--primary']).toBe('#4c8df6');
  });
});
