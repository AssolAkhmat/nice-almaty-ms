/**
 * Минимальный zip-архив без сжатия (метод `stored`).
 *
 * Нужен только для xlsx: книга из пяти небольших XML сжимается на
 * килобайты, а несжатый архив открывается теми же программами и не
 * требует ни зависимостей, ни разного поведения в edge-рантайме.
 */
export interface ZipEntry {
  name: string;
  content: string;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

/** Тот же полином, что и в PNG: zip и png считают контрольную сумму одинаково. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

function bytes(size: number, write: (view: DataView) => void): Uint8Array {
  const buffer = new ArrayBuffer(size);
  write(new DataView(buffer));

  return new Uint8Array(buffer);
}

export function storedZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const content = encoder.encode(entry.content);
    const checksum = crc32(content);

    const local = bytes(30, (view) => {
      view.setUint32(0, LOCAL_HEADER, true);
      view.setUint16(4, 20, true); // требуемая версия
      // Бит 11: имена файлов в UTF-8. Кириллицы в них нет, но флаг честнее.
      view.setUint16(6, 0x0800, true);
      view.setUint16(8, 0, true); // метод: без сжатия
      view.setUint16(10, 0, true); // время
      view.setUint16(12, 0, true); // дата
      view.setUint32(14, checksum, true);
      view.setUint32(18, content.length, true);
      view.setUint32(22, content.length, true);
      view.setUint16(26, name.length, true);
      view.setUint16(28, 0, true);
    });

    const central = bytes(46, (view) => {
      view.setUint32(0, CENTRAL_HEADER, true);
      view.setUint16(4, 20, true); // версия создателя
      view.setUint16(6, 20, true); // требуемая версия
      view.setUint16(8, 0x0800, true);
      view.setUint16(10, 0, true);
      view.setUint16(12, 0, true);
      view.setUint16(14, 0, true);
      view.setUint32(16, checksum, true);
      view.setUint32(20, content.length, true);
      view.setUint32(24, content.length, true);
      view.setUint16(28, name.length, true);
      view.setUint16(30, 0, true);
      view.setUint16(32, 0, true);
      view.setUint16(34, 0, true);
      view.setUint16(36, 0, true);
      view.setUint32(38, 0, true);
      view.setUint32(42, offset, true);
    });

    locals.push(local, name, content);
    centrals.push(central, name);
    offset += local.length + name.length + content.length;
  }

  const centralBytes = concat(centrals);
  const end = bytes(22, (view) => {
    view.setUint32(0, END_OF_CENTRAL, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, entries.length, true);
    view.setUint16(10, entries.length, true);
    view.setUint32(12, centralBytes.length, true);
    view.setUint32(16, offset, true);
    view.setUint16(20, 0, true);
  });

  return concat([...locals, centralBytes, end]);
}
