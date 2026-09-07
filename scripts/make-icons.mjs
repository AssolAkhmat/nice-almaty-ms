import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Иконки приложения для установки на телефон (docs/05-DESIGN-SYSTEM.md).
 *
 * Рисуются кодом, а не картинкой из редактора: знак простой — синий
 * квадрат и жёлтый дом, — и держать ради него бинарный файл, который
 * никто не может пересобрать, ни к чему. Зависимостей нет: PNG собирается
 * из тех же кусков, что и любой другой PNG, а сжатие даёт `node:zlib`.
 *
 * Запуск: `node scripts/make-icons.mjs`
 */
const BLUE = [0x00, 0x4a, 0xad];
const YELLOW = [0xfe, 0xe2, 0x74];

/** Полезная область maskable-иконки — центральные 80%: края система срежет. */
const SAFE = 0.8;

function crc32(buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, checksum]);
}

/** Дом: треугольная крыша и прямоугольный корпус с проёмом двери. */
function isHouse(x, y, size) {
  const half = size / 2;
  const scale = (size * SAFE) / 2;

  const dx = (x - half) / scale;
  const dy = (y - half) / scale;

  const roof = dy >= -0.62 && dy <= -0.06 && Math.abs(dx) <= (dy + 0.62) * 1.25;
  const walls = dy > -0.06 && dy <= 0.62 && Math.abs(dx) <= 0.52;
  const door = dy > 0.18 && dy <= 0.62 && Math.abs(dx) <= 0.16;

  return (roof || walls) && !door;
}

function png(size) {
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);

  for (let y = 0; y < size; y += 1) {
    const row = y * stride;
    raw[row] = 0;

    for (let x = 0; x < size; x += 1) {
      const color = isHouse(x, y, size) ? YELLOW : BLUE;
      const at = row + 1 + x * 3;
      raw[at] = color[0];
      raw[at + 1] = color[1];
      raw[at + 2] = color[2];
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // бит на канал
  header[9] = 2; // truecolor RGB
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const directory = fileURLToPath(new URL('../public/icons/', import.meta.url));
mkdirSync(directory, { recursive: true });

for (const size of [192, 512]) {
  writeFileSync(new URL(`icon-${size}.png`, `file://${directory}`), png(size));
  process.stdout.write(`icon-${size}.png\n`);
}
