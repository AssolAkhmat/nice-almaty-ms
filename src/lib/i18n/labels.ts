/**
 * Подпись сущности в журнале аудита.
 *
 * Журнал переживает те части системы, которых при его написании не было:
 * запись о зоне, месте или счёте появилась в фазе 2, а экран — в фазе 1.
 * Незнакомый код показывается как есть — экран не падает целиком из-за
 * одной строки (P2-45). Полноту словаря стережёт тест сообщений.
 */
export interface LabelSource {
  has: (key: string) => boolean;
  get: (key: string) => string;
}

export function auditEntityLabel(entityType: string, source: LabelSource): string {
  const key = `audit.entities.${entityType}`;

  return source.has(key) ? source.get(key) : entityType;
}
