/**
 * Контраст по WCAG 2.1 (docs/05-DESIGN-SYSTEM.md, «Жёсткие правила контраста»).
 * Нужен, чтобы правила палитры проверялись тестом, а не глазами.
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const HEX_PATTERN = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

export function parseHex(color: string): Rgb {
  const match = HEX_PATTERN.exec(color.trim());
  if (match === null) {
    throw new RangeError(`Не шестнадцатеричный цвет: ${color}`);
  }

  const digits = match[1] ?? '';
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : digits;

  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

function channelLuminance(value: number): number {
  const channel = value / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: string): number {
  const { r, g, b } = parseHex(color);

  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** Отношение контраста, от 1 до 21. */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);

  return (lighter + 0.05) / (darker + 0.05);
}

/** Минимум для основного текста. */
export const MIN_CONTRAST_TEXT = 4.5;

/** Минимум для крупного текста и иконок. */
export const MIN_CONTRAST_LARGE = 3;
