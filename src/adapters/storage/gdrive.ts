import { now } from '@/lib/time';

import { assertSafeKey } from './paths';

import type {
  StorageHealth,
  StorageProvider,
  StoredObject,
  UploadMeta,
  UploadTarget,
} from './types';

/**
 * Google Drive от имени владельца диска (docs/01-ARCHITECTURE.md, D3).
 *
 * У сервисного аккаунта нет собственной квоты: загрузка в папку личного диска
 * падает с `storageQuotaExceeded`, если нет Shared Drive. Поэтому здесь OAuth
 * владельца — одноразовая авторизация, `refresh_token` в окружении, файлы
 * лежат в его квоте.
 *
 * Drive не знает путей: у него есть только имена внутри родителя. Ключ вида
 * `{house_slug}/{residency_id}/{document_type}/{file_id}.{ext}` разворачивается
 * в цепочку папок от корневой; найденные папки запоминаются, иначе каждая
 * загрузка стоила бы трёх лишних запросов.
 *
 * Корневая папка берётся из `rootFolderId`, а без него заводится сама: область
 * `drive.file` видит только объекты, созданные приложением, поэтому папку,
 * созданную владельцем в браузере, драйверу не отдать (P7-20).
 *
 * Публичные ссылки не выдаются никогда: права на файлы Drive не меняются,
 * запросов к `permissions` в драйвере нет вовсе.
 */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Папка приложения, когда её идентификатор не задан в окружении.
 * Заводится самим драйвером: область `drive.file` не видит папку, созданную
 * владельцем в браузере, и обращение к ней отвечает 404 (P7-20).
 */
const ROOT_FOLDER_NAME = 'Nice Almaty';

/** Псевдоним «Моего диска» в запросах Drive: у корня нет обычного идентификатора. */
const MY_DRIVE = 'root';

/** Запас на дорогу: токен, который истекает через секунду, уже бесполезен. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** Корневая папка, о которой драйвер сообщает один раз за процесс. */
export interface GdriveRootFolder {
  id: string;
  /** `true` — папку завёл этот запуск, `false` — нашлась созданная раньше. */
  created: boolean;
}

export interface GdriveConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Пусто — драйвер заведёт «Nice Almaty» в «Моём диске» сам. */
  rootFolderId?: string | undefined;
  /** Подмена сети: в тестах Drive поднимается локально. */
  fetch?: typeof fetch;
  /**
   * Куда сообщить идентификатор папки, найденной без окружения.
   * Зовётся один раз за процесс: владельцу он нужен, чтобы положить его
   * в `GDRIVE_ROOT_FOLDER_ID` и не искать папку при каждом запуске.
   */
  onRootFolder?: (folder: GdriveRootFolder) => void;
}

interface DriveFile {
  id: string;
  name?: string;
  size?: string;
}

/** Текст ошибки Google целиком: он объясняет причину лучше любого пересказа. */
async function driveError(response: Response, what: string): Promise<Error> {
  const text = await response.text().catch(() => '');

  return new Error(`Google Drive: ${what} — ${String(response.status)} ${text}`);
}

/** Одинарные кавычки в имени ломают запрос `q`: Drive требует их экранирования. */
function quote(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

export function createGdriveStorage(config: GdriveConfig): StorageProvider {
  const net = config.fetch ?? fetch;

  let token: { value: string; expiresAt: number } | null = null;
  /** Найденные папки: ключ — `родитель/имя`. */
  const folders = new Map<string, string>();
  const configuredRoot = config.rootFolderId ?? '';
  /** Одно обещание на процесс: параллельные загрузки не должны завести две папки. */
  let rootLookup: Promise<string> | null = null;

  async function accessToken(): Promise<string> {
    if (token !== null && token.expiresAt > now().getTime()) {
      return token.value;
    }

    const response = await net(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });

    if (!response.ok) {
      throw await driveError(response, 'не удалось обновить access_token');
    }

    const body = (await response.json()) as { access_token: string; expires_in: number };
    token = {
      value: body.access_token,
      expiresAt: now().getTime() + body.expires_in * 1000 - TOKEN_EXPIRY_MARGIN_MS,
    };

    return token.value;
  }

  async function authorized(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${await accessToken()}`);

    const response = await net(url, { ...init, headers });

    // Токен мог быть отозван раньше срока: одна повторная попытка со свежим.
    if (response.status === 401) {
      token = null;
      const retryHeaders = new Headers(init.headers);
      retryHeaders.set('authorization', `Bearer ${await accessToken()}`);

      return net(url, { ...init, headers: retryHeaders });
    }

    return response;
  }

  /** Один объект с таким именем внутри родителя. `null` — его нет. */
  async function findChild(
    name: string,
    parentId: string,
    folder: boolean,
  ): Promise<string | null> {
    const conditions = [
      `name = '${quote(name)}'`,
      `'${quote(parentId)}' in parents`,
      'trashed = false',
      folder ? `mimeType = '${FOLDER_MIME}'` : `mimeType != '${FOLDER_MIME}'`,
    ];

    const url = `${FILES_URL}?${new URLSearchParams({
      q: conditions.join(' and '),
      fields: 'files(id,name,mimeType)',
      pageSize: '1',
    }).toString()}`;

    const response = await authorized(url);
    if (!response.ok) {
      throw await driveError(response, `поиск «${name}»`);
    }

    const body = (await response.json()) as { files?: DriveFile[] };

    return body.files?.[0]?.id ?? null;
  }

  async function createFolder(name: string, parentId: string): Promise<string> {
    const response = await authorized(FILES_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, parents: [parentId], mimeType: FOLDER_MIME }),
    });

    if (!response.ok) {
      throw await driveError(response, `создание папки «${name}»`);
    }

    return ((await response.json()) as DriveFile).id;
  }

  async function ensureFolder(name: string, parentId: string): Promise<string> {
    const cacheKey = `${parentId}/${name}`;
    const remembered = folders.get(cacheKey);
    if (remembered !== undefined) {
      return remembered;
    }

    const existing = await findChild(name, parentId, true);
    const id = existing ?? (await createFolder(name, parentId));
    folders.set(cacheKey, id);

    return id;
  }

  /** Корневая папка приложения: найденная или заведённая этим запуском. */
  async function discoverRoot(): Promise<string> {
    const cacheKey = `${MY_DRIVE}/${ROOT_FOLDER_NAME}`;
    const existing = folders.get(cacheKey) ?? (await findChild(ROOT_FOLDER_NAME, MY_DRIVE, true));
    const id = existing ?? (await createFolder(ROOT_FOLDER_NAME, MY_DRIVE));

    folders.set(cacheKey, id);
    config.onRootFolder?.({ id, created: existing === null });

    return id;
  }

  /**
   * Идентификатор корневой папки. Задан в окружении — берётся как есть.
   *
   * `create = false` — путь чтения: пустой диск остаётся пустым. Заводить
   * папку на промахе `exists` или `delete` незачем: файлов под ней всё равно нет.
   */
  async function rootFolder(create: true): Promise<string>;
  async function rootFolder(create: boolean): Promise<string | null>;
  async function rootFolder(create: boolean): Promise<string | null> {
    if (configuredRoot !== '') {
      return configuredRoot;
    }

    if (create) {
      // Неудачную попытку не запоминаем: следующая начнёт с чистого листа.
      rootLookup ??= discoverRoot().catch((error: unknown) => {
        rootLookup = null;

        throw error;
      });

      return rootLookup;
    }

    const cacheKey = `${MY_DRIVE}/${ROOT_FOLDER_NAME}`;

    return folders.get(cacheKey) ?? (await findChild(ROOT_FOLDER_NAME, MY_DRIVE, true));
  }

  /** Разбор ключа: цепочка папок и имя файла в последней из них. */
  function splitKey(key: string): { directories: string[]; name: string } {
    const segments = assertSafeKey(key).split('/');
    const name = segments.pop() ?? '';

    return { directories: segments, name };
  }

  /** Папка под ключ. `create = false` — по дороге ничего не создаётся. */
  async function resolveParent(directories: readonly string[], create: true): Promise<string>;
  async function resolveParent(
    directories: readonly string[],
    create: boolean,
  ): Promise<string | null>;
  async function resolveParent(
    directories: readonly string[],
    create: boolean,
  ): Promise<string | null> {
    const root = await rootFolder(create);

    if (root === null) {
      return null;
    }

    let parentId: string = root;

    for (const directory of directories) {
      if (create) {
        parentId = await ensureFolder(directory, parentId);
        continue;
      }

      const cacheKey = `${parentId}/${directory}`;
      const found = folders.get(cacheKey) ?? (await findChild(directory, parentId, true));
      if (found === null) {
        return null;
      }

      folders.set(cacheKey, found);
      parentId = found;
    }

    return parentId;
  }

  /** Идентификатор объекта по ключу. `null` — объекта нет. */
  async function findByKey(key: string): Promise<string | null> {
    const { directories, name } = splitKey(key);
    const parentId = await resolveParent(directories, false);

    return parentId === null ? null : findChild(name, parentId, false);
  }

  async function metadata(id: string): Promise<DriveFile | null> {
    const response = await authorized(`${FILES_URL}/${id}?fields=id,name,size`);
    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw await driveError(response, 'чтение свойств файла');
    }

    return (await response.json()) as DriveFile;
  }

  async function media(key: string): Promise<Response | null> {
    const id = await findByKey(key);
    if (id === null) {
      return null;
    }

    const response = await authorized(`${FILES_URL}/${id}?alt=media`);
    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw await driveError(response, 'чтение содержимого');
    }

    return response;
  }

  return {
    driver: 'gdrive',

    async checkHealth(): Promise<StorageHealth> {
      try {
        const response = await authorized(`${FILES_URL}/${await rootFolder(true)}?fields=id`);
        if (!response.ok) {
          throw await driveError(response, 'корневая папка недоступна');
        }

        return { status: 'ok', driver: 'gdrive' };
      } catch (error) {
        return {
          status: 'error',
          driver: 'gdrive',
          reason: error instanceof Error ? error.message : 'Google Drive недоступен',
        };
      }
    },

    /**
     * Загрузка байтов самим приложением. Штатный путь — прямая загрузка
     * клиентом по resumable session; этот метод нужен там, где байты уже
     * в руках сервера: генерация PDF договора и уборка после сбоя.
     */
    async put(key: string, data: Uint8Array): Promise<StoredObject> {
      const { directories, name } = splitKey(key);
      const parentId = await resolveParent(directories, true);
      const existing = await findChild(name, parentId, false);

      if (existing !== null) {
        const updated = await authorized(`${UPLOAD_URL}/${existing}?uploadType=media`, {
          method: 'PATCH',
          body: data as unknown as BodyInit,
        });

        if (!updated.ok) {
          throw await driveError(updated, `перезапись «${name}»`);
        }

        return { key: assertSafeKey(key), sizeBytes: data.byteLength };
      }

      const boundary = `nice-${crypto.randomUUID()}`;
      const metadataPart = JSON.stringify({ name, parents: [parentId] });
      const encoder = new TextEncoder();
      const head = encoder.encode(
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadataPart}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`,
      );
      const tail = encoder.encode(`\r\n--${boundary}--`);
      const body = new Uint8Array(head.byteLength + data.byteLength + tail.byteLength);
      body.set(head, 0);
      body.set(data, head.byteLength);
      body.set(tail, head.byteLength + data.byteLength);

      const response = await authorized(`${UPLOAD_URL}?uploadType=multipart`, {
        method: 'POST',
        headers: { 'content-type': `multipart/related; boundary=${boundary}` },
        body: body as unknown as BodyInit,
      });

      if (!response.ok) {
        throw await driveError(response, `загрузка «${name}»`);
      }

      return { key: assertSafeKey(key), sizeBytes: data.byteLength };
    },

    async get(key: string): Promise<Uint8Array | null> {
      const response = await media(key);

      return response === null ? null : new Uint8Array(await response.arrayBuffer());
    },

    async head(key: string): Promise<StoredObject | null> {
      const id = await findByKey(key);
      if (id === null) {
        return null;
      }

      const info = await metadata(id);

      return info === null
        ? null
        : { key: assertSafeKey(key), sizeBytes: Number(info.size ?? '0') };
    },

    /**
     * Resumable upload session: клиент шлёт байты прямо в Drive, минуя
     * приложение. Ради этого вся загрузка и сделана двухшаговой (D4) —
     * лимит тела запроса на Vercel меньше, чем фотография с телефона.
     *
     * Сессия привязана к `Origin` страницы, которая пришлёт байты: сервер
     * загрузки Google отдаёт CORS-заголовки на `PUT` по адресу сессии только
     * тому origin, который был назван при её открытии. Сессия, открытая
     * сервером без `Origin`, из браузера не заполняется вовсе — браузер
     * прячет ответ без `Access-Control-Allow-Origin` за `Failed to fetch`
     * (инцидент I11; требование записано в документации Cloud Storage,
     * общий сервер загрузки у обоих API).
     */
    async createUploadTarget(key: string, meta: UploadMeta): Promise<UploadTarget> {
      const { directories, name } = splitKey(key);
      const parentId = await resolveParent(directories, true);

      const response = await authorized(`${UPLOAD_URL}?uploadType=resumable`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': meta.mime,
          'x-upload-content-length': String(meta.sizeBytes),
          ...(meta.origin !== undefined && meta.origin !== '' ? { origin: meta.origin } : {}),
        },
        body: JSON.stringify({ name, parents: [parentId], mimeType: meta.mime }),
      });

      if (!response.ok) {
        throw await driveError(response, `открытие сессии загрузки «${name}»`);
      }

      const location = response.headers.get('location');
      if (location === null || location === '') {
        // Без адреса сессии клиенту некуда слать байты, и молчать об этом нельзя.
        throw new Error('Google Drive: сессия загрузки открыта без заголовка Location');
      }

      return {
        kind: 'external',
        url: location,
        method: 'PUT',
        headers: { 'content-type': meta.mime },
        // Идентификатор файла Drive сообщает после загрузки, а не при открытии сессии.
        externalId: null,
      };
    },

    async stream(key: string): Promise<ReadableStream<Uint8Array> | null> {
      const response = await media(key);

      return response?.body ?? null;
    },

    async exists(key: string): Promise<boolean> {
      return (await findByKey(key)) !== null;
    },

    async delete(key: string): Promise<void> {
      const id = await findByKey(key);
      if (id === null) {
        // Повторная уборка после сбоя должна быть безопасной.
        return;
      }

      const response = await authorized(`${FILES_URL}/${id}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) {
        throw await driveError(response, 'удаление файла');
      }
    },
  };
}
