import { describe, expect, it } from 'vitest';

import { createGdriveStorage, type GdriveConfig, type GdriveRootFolder } from './gdrive';

/**
 * Драйвер Google Drive (docs/01-ARCHITECTURE.md, «Google Drive: как именно», D3).
 *
 * Живого Drive в тестах нет и быть не должно. Вместо мока на каждый вызов
 * поднят маленький Drive: он помнит папки и файлы и отвечает так же, как
 * настоящий. Подделка на уровне ответов проверяла бы порядок вызовов;
 * подделка на уровне состояния проверяет поведение — например, что цепочка
 * папок не создаётся заново при каждой загрузке.
 */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

interface DriveNode {
  id: string;
  name: string;
  parent: string;
  mime: string;
  bytes?: Uint8Array;
}

interface FakeDriveOptions {
  /** Сколько секунд живёт выдаваемый токен. Ноль — истёк сразу. */
  expiresIn?: number;
  /** Ответ вместо успешного: так проверяются отказы Google. */
  fail?: { when: (url: string, method: string) => boolean; status: number; error: string };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Разбор `q` из запроса поиска: Drive не знает путей, только имя внутри родителя. */
function parseQuery(query: string): { name: string; parent: string; folderOnly: boolean } {
  return {
    name: /name\s*=\s*'([^']*)'/.exec(query)?.[1] ?? '',
    parent: /'([^']*)'\s+in\s+parents/.exec(query)?.[1] ?? '',
    // Именно `=`, а не `!=`: у поиска файла в условии стоит тот же тип со знаком отрицания.
    folderOnly: new RegExp(String.raw`mimeType\s*=\s*'${FOLDER_MIME}'`).test(query),
  };
}

function fakeDrive(options: FakeDriveOptions = {}) {
  const nodes = new Map<string, DriveNode>();
  const calls: {
    url: string;
    method: string;
    body: string | null;
    headers: Record<string, string>;
  }[] = [];
  const uploads = new Map<string, { name: string; parent: string; mime: string }>();
  let counter = 0;

  const fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const rawBody = init?.body;
    const body = typeof rawBody === 'string' ? rawBody : null;

    calls.push({
      url,
      method,
      body,
      headers: Object.fromEntries(
        [...new Headers(init?.headers).entries()].map(([name, value]) => [
          name.toLowerCase(),
          value,
        ]),
      ),
    });

    if (options.fail?.when(url, method) === true) {
      return json({ error: { message: options.fail.error } }, options.fail.status);
    }

    if (url === TOKEN_URL) {
      return json({
        access_token: `token-${String(++counter)}`,
        expires_in: options.expiresIn ?? 3600,
      });
    }

    const parsed = new URL(url);
    const path = parsed.pathname;

    // Поиск по имени внутри родителя.
    if (path === '/drive/v3/files' && method === 'GET') {
      const { name, parent, folderOnly } = parseQuery(parsed.searchParams.get('q') ?? '');
      const files = [...nodes.values()]
        .filter((node) => node.name === name && node.parent === parent)
        .filter((node) => (folderOnly ? node.mime === FOLDER_MIME : node.mime !== FOLDER_MIME))
        .map((node) => ({ id: node.id, name: node.name, mimeType: node.mime }));

      return json({ files });
    }

    // Создание папки.
    if (path === '/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(body ?? '{}') as {
        name: string;
        parents: string[];
        mimeType: string;
      };
      const id = `node-${String(++counter)}`;
      nodes.set(id, {
        id,
        name: meta.name,
        parent: meta.parents[0] ?? '',
        mime: meta.mimeType,
      });

      return json({ id, name: meta.name, mimeType: meta.mimeType });
    }

    // Открытие сессии прямой загрузки.
    if (path === '/upload/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(body ?? '{}') as {
        name: string;
        parents: string[];
        mimeType: string;
      };
      const session = `https://www.googleapis.com/upload/drive/v3/files?upload_id=${String(++counter)}`;
      uploads.set(session, {
        name: meta.name,
        parent: meta.parents[0] ?? '',
        mime: meta.mimeType,
      });

      return new Response(null, { status: 200, headers: { location: session } });
    }

    // Байты, дошедшие по сессии прямой загрузки.
    if (uploads.has(url) && method === 'PUT') {
      const meta = uploads.get(url);
      const id = `node-${String(++counter)}`;
      const bytes = new Uint8Array(await new Response(rawBody as BodyInit).arrayBuffer());
      nodes.set(id, {
        id,
        name: meta?.name ?? '',
        parent: meta?.parent ?? '',
        mime: meta?.mime ?? '',
        bytes,
      });

      return json({ id, name: meta?.name, size: String(bytes.byteLength) });
    }

    const nodeId = /^\/drive\/v3\/files\/([^/]+)$/.exec(path)?.[1];

    if (nodeId !== undefined && method === 'GET') {
      const node = nodes.get(nodeId);
      if (node === undefined) {
        return json({ error: { message: 'File not found' } }, 404);
      }

      if (parsed.searchParams.get('alt') === 'media') {
        return new Response((node.bytes ?? new Uint8Array()) as unknown as BodyInit, {
          status: 200,
        });
      }

      return json({ id: node.id, name: node.name, size: String(node.bytes?.byteLength ?? 0) });
    }

    if (nodeId !== undefined && method === 'DELETE') {
      nodes.delete(nodeId);

      return new Response(null, { status: 204 });
    }

    return json({ error: { message: `неизвестный запрос ${method} ${url}` } }, 500);
  };

  /** Кладёт объект так, как это сделал бы клиент: сессия плюс байты. */
  async function seedObject(
    storage: ReturnType<typeof createGdriveStorage>,
    key: string,
    bytes: Uint8Array,
  ) {
    const target = await storage.createUploadTarget(key, {
      mime: 'image/jpeg',
      sizeBytes: bytes.byteLength,
    });
    if (target.kind !== 'external') {
      throw new Error('ожидался внешний адрес загрузки');
    }

    await fetcher(target.url, { method: 'PUT', body: bytes as unknown as BodyInit });
  }

  return { calls, fetcher, nodes, seedObject, rootId: 'root-folder' };
}

const CONFIG: Omit<GdriveConfig, 'fetch'> = {
  clientId: 'client',
  clientSecret: 'secret',
  refreshToken: 'refresh',
  rootFolderId: 'root-folder',
};

const KEY = 'dom-a/residency-1/fluorography/file-1.jpg';

function storageOf(drive: ReturnType<typeof fakeDrive>) {
  return createGdriveStorage({ ...CONFIG, fetch: drive.fetcher });
}

describe('доступ от имени владельца диска', () => {
  it('меняет refresh_token на access_token и не ходит за ним дважды подряд', async () => {
    const drive = fakeDrive();
    drive.nodes.set('root-folder', {
      id: 'root-folder',
      name: 'root',
      parent: '',
      mime: FOLDER_MIME,
    });

    const storage = storageOf(drive);

    expect(await storage.checkHealth()).toEqual({ status: 'ok', driver: 'gdrive' });
    expect(await storage.checkHealth()).toEqual({ status: 'ok', driver: 'gdrive' });

    const tokenCalls = drive.calls.filter((call) => call.url === TOKEN_URL);
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.body).toContain('grant_type=refresh_token');
    expect(tokenCalls[0]?.body).toContain('refresh_token=refresh');
    expect(tokenCalls[0]?.body).toContain('client_secret=secret');
  });

  it('истёкший токен обновляется, а не переиспользуется', async () => {
    const drive = fakeDrive({ expiresIn: 0 });
    drive.nodes.set('root-folder', {
      id: 'root-folder',
      name: 'root',
      parent: '',
      mime: FOLDER_MIME,
    });

    const storage = storageOf(drive);
    await storage.checkHealth();
    await storage.checkHealth();

    expect(drive.calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(2);
  });

  it('отказ в выдаче токена виден целиком, а не как «что-то пошло не так»', async () => {
    const drive = fakeDrive({
      fail: { when: (url) => url === TOKEN_URL, status: 400, error: 'invalid_grant' },
    });

    const health = await storageOf(drive).checkHealth();

    expect(health.status).toBe('error');
    expect(health.status === 'error' ? health.reason : '').toContain('invalid_grant');
  });

  it('запросы идут с полученным токеном', async () => {
    const drive = fakeDrive();
    drive.nodes.set('root-folder', {
      id: 'root-folder',
      name: 'root',
      parent: '',
      mime: FOLDER_MIME,
    });

    await storageOf(drive).checkHealth();

    expect(drive.calls.some((call) => call.url.includes('/drive/v3/files/root-folder'))).toBe(true);
  });
});

describe('путь из архитектуры', () => {
  it('создаёт цепочку папок /{house_slug}/{residency_id}/{document_type}/', async () => {
    const drive = fakeDrive();
    const storage = storageOf(drive);

    await storage.createUploadTarget(KEY, { mime: 'image/jpeg', sizeBytes: 4 });

    const folders = [...drive.nodes.values()].filter((node) => node.mime === FOLDER_MIME);
    const house = folders.find((folder) => folder.name === 'dom-a');
    const residency = folders.find((folder) => folder.name === 'residency-1');
    const documentType = folders.find((folder) => folder.name === 'fluorography');

    expect(folders).toHaveLength(3);
    expect(house?.parent).toBe('root-folder');
    expect(residency?.parent).toBe(house?.id);
    expect(documentType?.parent).toBe(residency?.id);
  });

  it('уже созданные папки не создаются заново', async () => {
    const drive = fakeDrive();
    const storage = storageOf(drive);

    await storage.createUploadTarget(KEY, { mime: 'image/jpeg', sizeBytes: 4 });
    const afterFirst = drive.calls.filter(
      (call) => call.url.endsWith('/drive/v3/files') && call.method === 'POST',
    ).length;

    await storage.createUploadTarget('dom-a/residency-1/fluorography/file-2.jpg', {
      mime: 'image/jpeg',
      sizeBytes: 4,
    });

    const afterSecond = drive.calls.filter(
      (call) => call.url.endsWith('/drive/v3/files') && call.method === 'POST',
    ).length;

    expect(afterFirst).toBe(3);
    expect(afterSecond).toBe(3);
  });

  it('небезопасный ключ до сети не доходит', async () => {
    const drive = fakeDrive();
    const storage = storageOf(drive);

    await expect(
      storage.createUploadTarget('../секрет/файл.jpg', { mime: 'image/jpeg', sizeBytes: 4 }),
    ).rejects.toThrow();

    expect(drive.calls).toHaveLength(0);
  });
});

describe('прямая загрузка', () => {
  it('открывает resumable session и отдаёт её адрес клиенту', async () => {
    const drive = fakeDrive();
    const storage = storageOf(drive);

    const target = await storage.createUploadTarget(KEY, { mime: 'image/jpeg', sizeBytes: 1024 });

    expect(target.kind).toBe('external');
    if (target.kind !== 'external') {
      return;
    }

    expect(target.method).toBe('PUT');
    expect(target.url).toContain('upload_id=');

    const session = drive.calls.find(
      (call) => call.url.includes('uploadType=resumable') && call.method === 'POST',
    );
    const meta = JSON.parse(session?.body ?? '{}') as { name: string; parents: string[] };

    // Имя в Drive — идентификатор записи, а не имя, пришедшее от пользователя.
    expect(meta.name).toBe('file-1.jpg');
    expect(meta.parents).toHaveLength(1);
  });

  it('размер и тип объявляются до загрузки: Drive отвергает лишнее сам', async () => {
    const drive = fakeDrive();
    const storage = storageOf(drive);

    await storage.createUploadTarget(KEY, { mime: 'image/jpeg', sizeBytes: 1024 });

    const session = drive.calls.find((call) => call.url.includes('uploadType=resumable'));

    expect(session?.headers['x-upload-content-type']).toBe('image/jpeg');
    expect(session?.headers['x-upload-content-length']).toBe('1024');
  });

  it('публичных ссылок драйвер не выдаёт никогда', async () => {
    const drive = fakeDrive();
    const storage = storageOf(drive);

    await storage.createUploadTarget(KEY, { mime: 'image/jpeg', sizeBytes: 1024 });
    await drive.seedObject(storage, KEY, new Uint8Array([1, 2, 3]));

    expect(drive.calls.some((call) => call.url.includes('/permissions'))).toBe(false);
  });
});

describe('чтение и уборка', () => {
  it('находит объект по ключу и отдаёт его размер', async () => {
    const drive = fakeDrive();
    const storage = storageOf(drive);
    await drive.seedObject(storage, KEY, new Uint8Array([1, 2, 3, 4, 5]));

    expect(await storage.head(KEY)).toEqual({ key: KEY, sizeBytes: 5 });
    expect(await storage.exists(KEY)).toBe(true);
  });

  it('отсутствующий объект — null, а не ошибка', async () => {
    const drive = fakeDrive();
    const storage = storageOf(drive);

    expect(await storage.head(KEY)).toBeNull();
    expect(await storage.get(KEY)).toBeNull();
    expect(await storage.stream(KEY)).toBeNull();
    expect(await storage.exists(KEY)).toBe(false);
  });

  it('отдаёт содержимое и потоком, и целиком', async () => {
    const drive = fakeDrive();
    const storage = storageOf(drive);
    await drive.seedObject(storage, KEY, new Uint8Array([9, 8, 7]));

    expect([...((await storage.get(KEY)) ?? [])]).toEqual([9, 8, 7]);

    const stream = await storage.stream(KEY);
    expect(stream).not.toBeNull();

    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    expect([...bytes]).toEqual([9, 8, 7]);
  });

  it('удаление несуществующего объекта не ошибка: уборка после сбоя должна быть повторяемой', async () => {
    const drive = fakeDrive();
    const storage = storageOf(drive);

    await expect(storage.delete(KEY)).resolves.toBeUndefined();
  });

  it('удалённый объект перестаёт находиться', async () => {
    const drive = fakeDrive();
    const storage = storageOf(drive);
    await drive.seedObject(storage, KEY, new Uint8Array([1]));

    await storage.delete(KEY);

    expect(await storage.exists(KEY)).toBe(false);
  });
});

describe('отказы Google', () => {
  it('нехватка квоты объясняется словами, а не молча ломает загрузку', async () => {
    const drive = fakeDrive({
      fail: {
        when: (url) => url.includes('uploadType=resumable'),
        status: 403,
        error: 'storageQuotaExceeded',
      },
    });

    await expect(
      storageOf(drive).createUploadTarget(KEY, { mime: 'image/jpeg', sizeBytes: 1024 }),
    ).rejects.toThrow(/storageQuotaExceeded/);
  });

  it('сессия без адреса — ошибка, а не «загрузка в никуда»', async () => {
    const drive = fakeDrive();
    const storage = createGdriveStorage({
      ...CONFIG,
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

        return url.includes('uploadType=resumable')
          ? Promise.resolve(new Response(null, { status: 200 }))
          : drive.fetcher(input, init);
      },
    });

    await expect(
      storage.createUploadTarget(KEY, { mime: 'image/jpeg', sizeBytes: 1024 }),
    ).rejects.toThrow(/Location/i);
  });

  it('проверка живости отвечает error, когда корневая папка недоступна', async () => {
    const drive = fakeDrive({
      fail: {
        when: (url) => url.includes('/drive/v3/files/root-folder'),
        status: 404,
        error: 'File not found: root-folder',
      },
    });

    const health = await storageOf(drive).checkHealth();

    expect(health.status).toBe('error');
    expect(health.status === 'error' ? health.reason : '').toContain('root-folder');
  });
});

/**
 * Корневая папка, когда `GDRIVE_ROOT_FOLDER_ID` не задан.
 *
 * Область `drive.file` видит только объекты, созданные самим приложением:
 * папка, заведённая владельцем руками в браузере, для драйвера не существует —
 * обращение к ней отвечает 404. Поэтому папку заводит сам драйвер, а её
 * идентификатор сообщает один раз, чтобы владелец положил его в окружение
 * и следующий запуск не искал папку заново.
 */
describe('корневая папка, когда её идентификатор не задан', () => {
  const KEYS = { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' };
  const OTHER_KEY = 'dom-b/residency-2/photo_3x4/file-2.jpg';
  const UPLOAD = { mime: 'image/jpeg', sizeBytes: 10 } as const;

  function withoutRoot(drive: ReturnType<typeof fakeDrive>, reported: GdriveRootFolder[] = []) {
    return createGdriveStorage({
      ...KEYS,
      fetch: drive.fetcher,
      onRootFolder: (folder) => reported.push(folder),
    });
  }

  function namedFolders(drive: ReturnType<typeof fakeDrive>) {
    return [...drive.nodes.values()].filter(
      (node) => node.name === 'Nice Almaty' && node.parent === 'root',
    );
  }

  it('заводится в «Мой диск», и цепочка ключа растёт из неё', async () => {
    const drive = fakeDrive();

    await withoutRoot(drive).createUploadTarget(KEY, UPLOAD);

    const [folder] = namedFolders(drive);
    expect(folder?.mime).toBe(FOLDER_MIME);

    const house = [...drive.nodes.values()].find((node) => node.name === 'dom-a');
    expect(house?.parent).toBe(folder?.id);
  });

  it('идентификатор новой папки сообщается один раз, сколько бы загрузок ни было', async () => {
    const drive = fakeDrive();
    const reported: GdriveRootFolder[] = [];
    const storage = withoutRoot(drive, reported);

    await storage.createUploadTarget(KEY, UPLOAD);
    await storage.createUploadTarget(OTHER_KEY, UPLOAD);

    expect(namedFolders(drive)).toHaveLength(1);
    expect(reported).toEqual([{ id: namedFolders(drive)[0]?.id, created: true }]);
  });

  it('папка прошлого запуска находится, а не дублируется', async () => {
    const drive = fakeDrive();
    drive.nodes.set('nice-almaty', {
      id: 'nice-almaty',
      name: 'Nice Almaty',
      parent: 'root',
      mime: FOLDER_MIME,
    });
    const reported: GdriveRootFolder[] = [];

    await withoutRoot(drive, reported).createUploadTarget(KEY, UPLOAD);

    expect(namedFolders(drive)).toHaveLength(1);
    expect(reported).toEqual([{ id: 'nice-almaty', created: false }]);
  });

  it('одновременные загрузки не заводят две папки', async () => {
    const drive = fakeDrive();
    const storage = withoutRoot(drive);

    await Promise.all([
      storage.createUploadTarget(KEY, UPLOAD),
      storage.createUploadTarget(OTHER_KEY, UPLOAD),
    ]);

    expect(namedFolders(drive)).toHaveLength(1);
  });

  it('чтение ничего не создаёт: пустой диск — это просто пустой ответ', async () => {
    const drive = fakeDrive();
    const reported: GdriveRootFolder[] = [];
    const storage = withoutRoot(drive, reported);

    expect(await storage.exists(KEY)).toBe(false);
    expect(await storage.get(KEY)).toBeNull();
    expect(await storage.head(KEY)).toBeNull();
    await storage.delete(KEY);

    expect(drive.nodes.size).toBe(0);
    expect(reported).toEqual([]);
  });

  it('проверка живости поднимает папку сама: с неё начинается первый запуск', async () => {
    const drive = fakeDrive();
    const reported: GdriveRootFolder[] = [];

    expect(await withoutRoot(drive, reported).checkHealth()).toEqual({
      status: 'ok',
      driver: 'gdrive',
    });
    expect(namedFolders(drive)).toHaveLength(1);
    expect(reported[0]?.created).toBe(true);
  });

  it('заданный идентификатор используется как есть: папку по имени никто не ищет', async () => {
    const drive = fakeDrive();
    drive.nodes.set('root-folder', {
      id: 'root-folder',
      name: 'root',
      parent: '',
      mime: FOLDER_MIME,
    });
    const reported: GdriveRootFolder[] = [];
    const storage = createGdriveStorage({
      ...CONFIG,
      fetch: drive.fetcher,
      onRootFolder: (folder) => reported.push(folder),
    });

    await storage.createUploadTarget(KEY, UPLOAD);

    expect(drive.calls.some((call) => /Nice(\+|%20)Almaty/.test(call.url))).toBe(false);
    expect(reported).toEqual([]);
  });
});
