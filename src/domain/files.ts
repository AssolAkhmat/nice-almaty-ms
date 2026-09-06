/**
 * Правила загрузки файла (docs/01-ARCHITECTURE.md, «Ограничение Vercel»).
 *
 * Ни предела размера, ни списка разрешённых типов в ТЗ нет. Выбраны
 * консервативные значения, запись — в docs/08-DECISIONS.md: справка с телефона
 * и скан помещаются с запасом, а всё, что умеет исполняться в браузере,
 * в хранилище не попадает вовсе.
 *
 * Чистые функции: ни БД, ни времени, ни хранилища.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

export type AllowedMime = (typeof ALLOWED_MIME_TYPES)[number];

/** Причина отказа — код, а не готовый текст: перевод подставляет интерфейс. */
export type UploadRejection = 'files.mimeNotAllowed' | 'files.tooLarge' | 'files.empty';

const EXTENSIONS: Readonly<Record<AllowedMime, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/** `image/jpeg; charset=binary` и `IMAGE/JPEG` — тот же тип. */
function normalizeMime(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

export function isAllowedMime(mime: string): mime is AllowedMime {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(normalizeMime(mime));
}

export function asAllowedMime(mime: string): AllowedMime {
  const normalized = normalizeMime(mime);

  if (!isAllowedMime(normalized)) {
    throw new RangeError(`Тип «${mime}» к загрузке не разрешён`);
  }

  return normalized;
}

/**
 * Проверка заявки на загрузку. `null` — возражений нет.
 * Тип проверяется раньше размера: маленький исполняемый файл опаснее
 * большой фотографии.
 */
export function checkUpload(input: { mime: string; sizeBytes: number }): UploadRejection | null {
  if (!isAllowedMime(input.mime)) {
    return 'files.mimeNotAllowed';
  }

  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    return 'files.empty';
  }

  return input.sizeBytes > MAX_UPLOAD_BYTES ? 'files.tooLarge' : null;
}

export function extensionForMime(mime: AllowedMime): string {
  return EXTENSIONS[mime];
}

const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

function assertSegment(value: string, name: string): string {
  if (value === '' || value === '.' || value === '..' || !SEGMENT_PATTERN.test(value)) {
    throw new RangeError(`Недопустимый сегмент пути (${name}): «${value}»`);
  }

  return value;
}

export interface DocumentKeyParts {
  houseSlug: string;
  residencyId: string;
  documentType: string;
  fileId: string;
  mime: string;
}

/**
 * Путь хранения документа из docs/01-ARCHITECTURE.md:
 * `/{house_slug}/{residency_id}/{document_type}/`.
 *
 * Имя файла — идентификатор записи, а не имя, пришедшее от пользователя:
 * оригинальное имя хранится в `files.original_name` и в путь не попадает.
 * Хранилище проверит ключ ещё раз своей мерой — две проверки ловят
 * разные ошибки.
 */
export function documentStorageKey(parts: DocumentKeyParts): string {
  const extension = extensionForMime(asAllowedMime(parts.mime));

  return [
    assertSegment(parts.houseSlug, 'дом'),
    assertSegment(parts.residencyId, 'проживание'),
    assertSegment(parts.documentType, 'тип документа'),
    `${assertSegment(parts.fileId, 'файл')}.${extension}`,
  ].join('/');
}

const MAGIC: readonly { mime: AllowedMime; bytes: readonly number[] }[] = [
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];

const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.byteLength < offset + prefix.length) {
    return false;
  }

  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * Тип по первым байтам. Объявленный клиентом тип — это его слово;
 * байты не врут, поэтому там, где содержимое проходит через приложение,
 * сверяется именно оно.
 */
export function sniffMime(bytes: Uint8Array): AllowedMime | null {
  for (const { mime, bytes: prefix } of MAGIC) {
    if (startsWith(bytes, prefix)) {
      return mime;
    }
  }

  // RIFF — контейнер: без метки WEBP это может быть звук, а не картинка.
  return startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8) ? 'image/webp' : null;
}
