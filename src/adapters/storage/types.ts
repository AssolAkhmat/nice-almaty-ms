/**
 * Хранилище файлов за адаптером (docs/01-ARCHITECTURE.md).
 * В фазе 0 интерфейс содержит только проверку доступности: она нужна
 * эндпоинту /api/health. Загрузка и отдача файлов появляются в фазе 2.
 */
export type StorageDriver = 'gdrive' | 'local' | 'supabase';

export type StorageHealth =
  | { status: 'ok'; driver: StorageDriver }
  | { status: 'skipped'; driver: StorageDriver; reason: string }
  | { status: 'error'; driver: StorageDriver; reason: string };

export interface StorageProvider {
  readonly driver: StorageDriver;
  checkHealth: () => Promise<StorageHealth>;
}
