import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Иконки установки (T6.6). Файлы лежат в репозитории, а рисует их
 * `scripts/make-icons.mjs`: тест стережёт то, что без иконок заявленного
 * размера браузер просто не предложит установку, и заметить это можно
 * было бы только на телефоне.
 */
const SIZES = [192, 512] as const;

function iconAt(size: number): Buffer {
  return readFileSync(fileURLToPath(new URL(`../public/icons/icon-${size}.png`, import.meta.url)));
}

describe('иконки приложения', () => {
  it.each(SIZES)('icon-%i.png — настоящий PNG заявленного размера', (size) => {
    const bytes = iconAt(size);

    // Подпись PNG: восемь байт, одинаковых у любого корректного файла.
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    // Ширина и высота лежат в заголовке IHDR, сразу после его имени.
    expect(bytes.readUInt32BE(16)).toBe(size);
    expect(bytes.readUInt32BE(20)).toBe(size);
  });

  it('иконка не пустая: в ней есть и фон, и знак', () => {
    const small = iconAt(192);
    const large = iconAt(512);

    /*
     * Однотонный квадрат сжимается в считанные байты. Знак внутри даёт
     * заметно больший файл — это и отличает иконку от пустой заливки.
     */
    expect(small.length).toBeGreaterThan(200);
    expect(large.length).toBeGreaterThan(small.length);
  });
});
