import { getDb, type Executor } from '@/db/client';
import { putTemplateSettings, readTemplateSettings } from '@/db/repositories/rotations';
import { assertCan } from '@/lib/authz';

import { AUDIT_ACTIONS, recordAudit } from './audit';

import type { UserActor } from './users';

/**
 * Шапки и футеры шаблона дня (docs/03-BUSINESS-RULES.md §6.7).
 *
 * Хранятся по локалям: колонки называются `header_i18n` и `footer_i18n`,
 * а текст пишет человек — на том языке, на котором ведёт дом. Интерфейс
 * показывает поле текущей локали и в неё же сохраняет: заставлять админа
 * писать одно и то же трижды §6.7 не просит.
 */
export interface TemplatesDeps {
  executor?: Executor;
}

function executorOf(deps: TemplatesDeps): Executor {
  return deps.executor ?? getDb();
}

type ChecklistType = 'regular' | 'general';

export interface TemplateText {
  header: string;
  footer: string;
}

/** Текст локали; если её нет — первый заполненный: язык дома один. */
function pick(value: unknown, locale: string): string {
  if (typeof value !== 'object' || value === null) {
    return '';
  }

  const map = value as Record<string, unknown>;
  const exact = map[locale];

  if (typeof exact === 'string') {
    return exact;
  }

  for (const candidate of Object.values(map)) {
    if (typeof candidate === 'string' && candidate !== '') {
      return candidate;
    }
  }

  return '';
}

export async function readTemplateText(
  actor: UserActor,
  houseId: string,
  type: ChecklistType,
  locale: string,
  deps: TemplatesDeps = {},
): Promise<TemplateText> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'rotation.read', { houseId, userId: actor.context.userId });

  const settings = await readTemplateSettings(actor.context, houseId, type, executor);

  return {
    header: pick(settings?.headerI18n, locale),
    footer: pick(settings?.footerI18n, locale),
  };
}

export async function saveTemplateText(
  actor: UserActor,
  houseId: string,
  type: ChecklistType,
  locale: string,
  text: TemplateText,
  deps: TemplatesDeps = {},
): Promise<TemplateText> {
  const executor = executorOf(deps);

  assertCan(actor.context, 'rotation.manage', { houseId });

  const current = await readTemplateSettings(actor.context, houseId, type, executor);

  const headerI18n = { ...asMap(current?.headerI18n), [locale]: text.header };
  const footerI18n = { ...asMap(current?.footerI18n), [locale]: text.footer };

  return executorOf(deps).transaction(async (tx) => {
    await putTemplateSettings(actor.context, houseId, type, { headerI18n, footerI18n }, tx);

    await recordAudit(
      { context: actor.context, ip: actor.ip, requestId: actor.requestId },
      {
        action: AUDIT_ACTIONS.rotationTemplateSaved,
        entityType: 'house',
        entityId: houseId,
        after: { type, locale },
      },
      tx,
    );

    return text;
  });
}

function asMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }

  const result: Record<string, string> = {};

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') {
      result[key] = item;
    }
  }

  return result;
}
