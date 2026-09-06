/**
 * Хранилище файлов за адаптером (docs/01-ARCHITECTURE.md).
 * Драйверы `gdrive` и `supabase` появятся в фазе 2 вместе с двухшаговой
 * загрузкой; здесь интерфейс и полностью рабочий драйвер `local`.
 *
 * Метаданные файла — mime, размер, владелец — живут в таблице `files`,
 * которая тоже относится к фазе 2. Хранилище знает только байты и ключ:
 * иначе получилось бы два источника правды об одном файле.
 */
export type StorageDriver = 'gdrive' | 'local' | 'supabase';

export type StorageHealth =
  | { status: 'ok'; driver: StorageDriver }
  | { status: 'skipped'; driver: StorageDriver; reason: string }
  | { status: 'error'; driver: StorageDriver; reason: string };

export interface StoredObject {
  /** Ключ внутри хранилища, всегда с прямыми слэшами. */
  key: string;
  sizeBytes: number;
}

export interface UploadMeta {
  mime: string;
  /** Размер, заявленный клиентом. Сверяется с фактическим на шаге завершения. */
  sizeBytes: number;
}

/**
 * Куда клиент отправляет байты на втором шаге загрузки
 * (docs/01-ARCHITECTURE.md). Форма ответа одна для всех драйверов:
 * бизнес-код не должен знать, где он исполняется (CLAUDE.md §5).
 */
export type UploadTarget =
  /** Хранилище принимает байты само: presigned PUT или resumable session. */
  | {
      kind: 'external';
      url: string;
      method: 'PUT' | 'POST';
      headers: Record<string, string>;
      /** Идентификатор объекта у провайдера, если он известен заранее. */
      externalId: string | null;
    }
  /** Прямого адреса нет — байты принимает приложение (драйвер `local`). */
  | { kind: 'app' };

export interface StorageProvider {
  readonly driver: StorageDriver;
  checkHealth: () => Promise<StorageHealth>;
  /** Кладёт объект, перезаписывая существующий по тому же ключу. */
  put: (key: string, data: Uint8Array) => Promise<StoredObject>;
  /** Читает объект целиком. `null` — объекта нет. */
  get: (key: string) => Promise<Uint8Array | null>;
  /** Размер объекта без чтения содержимого. `null` — объекта нет. */
  head: (key: string) => Promise<StoredObject | null>;
  /** Открывает сессию прямой загрузки под уже известный ключ. */
  createUploadTarget: (key: string, meta: UploadMeta) => Promise<UploadTarget>;
  /** Отдаёт объект потоком: файлы бывают крупнее, чем стоит держать в памяти. */
  stream: (key: string) => Promise<ReadableStream<Uint8Array> | null>;
  exists: (key: string) => Promise<boolean>;
  /** Удаление несуществующего объекта — не ошибка. */
  delete: (key: string) => Promise<void>;
}
