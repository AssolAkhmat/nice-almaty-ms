import { describe, expect, it } from 'vitest';

import {
  ALLOWED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  checkUpload,
  documentStorageKey,
  extensionForMime,
  houseFileStorageKey,
  sniffMime,
} from './files';

/**
 * Правила загрузки файла (docs/01-ARCHITECTURE.md, двухшаговая загрузка).
 * Ни размера, ни списка типов в ТЗ нет: значения выбраны консервативно
 * и записаны в docs/08-DECISIONS.md. Здесь они закреплены числами,
 * чтобы их нельзя было тихо расширить.
 */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = new TextEncoder().encode('%PDF-1.7\n');
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

describe('допустимость загрузки', () => {
  it('разрешены только фотографии и PDF', () => {
    expect([...ALLOWED_MIME_TYPES]).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
    ]);
  });

  it('предел размера — 10 МБ', () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });

  it('обычная фотография проходит', () => {
    expect(checkUpload({ mime: 'image/jpeg', sizeBytes: 3_500_000 })).toBeNull();
  });

  it('файл ровно на пределе проходит, на байт больше — нет', () => {
    expect(checkUpload({ mime: 'image/jpeg', sizeBytes: MAX_UPLOAD_BYTES })).toBeNull();
    expect(checkUpload({ mime: 'image/jpeg', sizeBytes: MAX_UPLOAD_BYTES + 1 })).toBe(
      'files.tooLarge',
    );
  });

  it('пустой файл не принимается', () => {
    expect(checkUpload({ mime: 'image/jpeg', sizeBytes: 0 })).toBe('files.empty');
    expect(checkUpload({ mime: 'image/jpeg', sizeBytes: -1 })).toBe('files.empty');
  });

  it('дробный размер — не размер', () => {
    expect(checkUpload({ mime: 'image/jpeg', sizeBytes: 1.5 })).toBe('files.empty');
  });

  /** Исполняемое под видом справки — главное, ради чего список закрытый. */
  it('чужие типы отклоняются', () => {
    for (const mime of ['application/octet-stream', 'text/html', 'image/svg+xml', '']) {
      expect(checkUpload({ mime, sizeBytes: 1000 })).toBe('files.mimeNotAllowed');
    }
  });

  it('тип с параметрами и в верхнем регистре — тот же тип', () => {
    expect(checkUpload({ mime: 'IMAGE/JPEG', sizeBytes: 1000 })).toBeNull();
    expect(checkUpload({ mime: 'image/jpeg; charset=binary', sizeBytes: 1000 })).toBeNull();
  });

  it('тип проверяется раньше размера: неизвестный тип не спасёт малый размер', () => {
    expect(checkUpload({ mime: 'text/html', sizeBytes: MAX_UPLOAD_BYTES + 1 })).toBe(
      'files.mimeNotAllowed',
    );
  });
});

describe('расширение по типу', () => {
  it('каждому разрешённому типу соответствует расширение', () => {
    expect(extensionForMime('image/jpeg')).toBe('jpg');
    expect(extensionForMime('image/png')).toBe('png');
    expect(extensionForMime('image/webp')).toBe('webp');
    expect(extensionForMime('application/pdf')).toBe('pdf');
  });
});

/**
 * Тип, объявленный клиентом, — это его слово. Байты не врут:
 * их и проверяем там, где они проходят через приложение.
 */
describe('распознавание типа по первым байтам', () => {
  it('узнаёт разрешённые типы', () => {
    expect(sniffMime(JPEG)).toBe('image/jpeg');
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(WEBP)).toBe('image/webp');
    expect(sniffMime(PDF)).toBe('application/pdf');
  });

  it('не узнаёт ничего в постороннем содержимом', () => {
    expect(sniffMime(new TextEncoder().encode('<html><script>'))).toBeNull();
    expect(sniffMime(new Uint8Array([0x4d, 0x5a, 0x90, 0x00]))).toBeNull();
  });

  it('короткий кусок не выдаётся за файл', () => {
    expect(sniffMime(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(sniffMime(new Uint8Array())).toBeNull();
  });

  /** RIFF без метки WEBP — это, например, звук, а не картинка. */
  it('RIFF без метки WEBP не считается картинкой', () => {
    const riffWave = new Uint8Array(WEBP);
    riffWave.set(new TextEncoder().encode('WAVE'), 8);

    expect(sniffMime(riffWave)).toBeNull();
  });
});

describe('ключ хранения документа', () => {
  const key = {
    houseSlug: 'nice-almaty-1',
    residencyId: '3f2b1a44-0000-4000-8000-000000000001',
    documentType: 'photo_3x4',
    fileId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    mime: 'image/jpeg',
  } as const;

  /** Путь из docs/01-ARCHITECTURE.md: /{house_slug}/{residency_id}/{document_type}/. */
  it('складывается по схеме из архитектуры', () => {
    expect(documentStorageKey(key)).toBe(
      'nice-almaty-1/3f2b1a44-0000-4000-8000-000000000001/photo_3x4/7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg',
    );
  });

  it('имя файла — идентификатор записи, а не имя от пользователя', () => {
    expect(documentStorageKey(key)).toContain(key.fileId);
  });

  it('переход вверх в любом сегменте — ошибка, а не путь наружу', () => {
    expect(() => documentStorageKey({ ...key, houseSlug: '../../etc' })).toThrow(RangeError);
    expect(() => documentStorageKey({ ...key, documentType: '..' })).toThrow(RangeError);
    expect(() => documentStorageKey({ ...key, residencyId: 'a/b' })).toThrow(RangeError);
  });

  it('пустой сегмент — ошибка', () => {
    expect(() => documentStorageKey({ ...key, houseSlug: '' })).toThrow(RangeError);
    expect(() => documentStorageKey({ ...key, documentType: '' })).toThrow(RangeError);
  });

  it('неразрешённый тип не доходит до ключа', () => {
    expect(() => documentStorageKey({ ...key, mime: 'text/html' })).toThrow(RangeError);
  });
});

/**
 * Путь чека дома (T3.12). У чека к ущербу, расходу и строке коммуналки
 * проживания нет: он принадлежит дому. Поэтому и путь другой — без сегмента
 * проживания, иначе чек лёг бы в чужую папку и попал бы под видимость,
 * которая к нему не относится.
 */
describe('путь хранения файла дома', () => {
  it('складывается из дома, назначения и идентификатора записи', () => {
    expect(
      houseFileStorageKey({
        houseSlug: 'dom-1',
        purpose: 'damage-receipt',
        fileId: 'aaaabbbb-cccc-dddd-eeee-ffff00001111',
        mime: 'image/jpeg',
      }),
    ).toBe('dom-1/damage-receipt/aaaabbbb-cccc-dddd-eeee-ffff00001111.jpg');
  });

  it('имя от пользователя в путь не попадает: расширение из типа', () => {
    expect(
      houseFileStorageKey({
        houseSlug: 'dom-1',
        purpose: 'expense-receipt',
        fileId: 'file-1',
        mime: 'application/pdf',
      }),
    ).toBe('dom-1/expense-receipt/file-1.pdf');
  });

  it('обход каталога отвергается сегмент за сегментом', () => {
    for (const parts of [
      { houseSlug: '../etc', purpose: 'damage-receipt', fileId: 'f', mime: 'image/png' },
      { houseSlug: 'dom-1', purpose: '..', fileId: 'f', mime: 'image/png' },
      { houseSlug: 'dom-1', purpose: 'damage-receipt', fileId: 'a/b', mime: 'image/png' },
    ]) {
      expect(() => houseFileStorageKey(parts)).toThrow(RangeError);
    }
  });
});
