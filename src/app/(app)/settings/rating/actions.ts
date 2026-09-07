'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { AppError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { copyRatingRules, saveRatingRule } from '@/services/rating-rules';

export interface RatingRulesActionState {
  error?: string;
  done?: string;
}

async function actorOf() {
  const session = await getCurrentSession();

  if (session === null) {
    return null;
  }

  const store = await headers();

  return {
    context: session.context,
    ip: store.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined,
  };
}

function text(formData: FormData, key: string): string {
  const value = formData.get(key);

  return typeof value === 'string' ? value.trim() : '';
}

function houseOf(formData: FormData): string | null {
  const house = text(formData, 'houseId');

  return house === '' ? null : house;
}

/**
 * Сохранение правил: в базу уходит только изменённое.
 *
 * Иначе выбор дома сам по себе создавал бы переопределение на каждый код,
 * и будущая правка сети до этого дома уже не дошла бы.
 */
export async function saveRatingRulesAction(
  _previous: RatingRulesActionState,
  formData: FormData,
): Promise<RatingRulesActionState> {
  const actor = await actorOf();

  if (actor === null) {
    return { error: 'settings.errors.unauthorized' };
  }

  const houseId = houseOf(formData);

  try {
    for (const [name, raw] of formData.entries()) {
      if (!name.startsWith('value:') || typeof raw !== 'string') {
        continue;
      }

      const code = name.slice('value:'.length);
      const base = text(formData, `base:${code}`);

      if (raw.trim() === base) {
        continue;
      }

      const value = Number(raw);

      if (!Number.isSafeInteger(value)) {
        return { error: 'rating.errors.notInteger' };
      }

      if (code.startsWith('score:')) {
        await saveRatingRule(actor, {
          houseId,
          kind: 'score_delta',
          code,
          config: { score: Number(code.slice('score:'.length)), delta: value },
        });

        continue;
      }

      if (code.startsWith('down:')) {
        const threshold = Number(code.slice('down:'.length));

        await saveRatingRule(actor, {
          houseId,
          kind: 'threshold_down',
          code,
          config: {
            threshold,
            actions: text(formData, `actions:${code}`).split(',').filter(Boolean),
            fine_amount: value,
          },
        });

        continue;
      }

      if (code.startsWith('up:')) {
        await saveRatingRule(actor, {
          houseId,
          kind: 'threshold_up',
          code,
          config: { threshold: Number(code.slice('up:'.length)), discount_amount: value },
        });

        continue;
      }

      await saveRatingRule(actor, {
        houseId,
        kind: 'admin_action',
        code,
        config: { delta: value },
      });
    }

    revalidatePath('/settings/rating');

    return { done: 'rating.rules.saved' };
  } catch (error) {
    if (error instanceof AppError) {
      return { error: `rating.errors.${error.code}` };
    }

    throw error;
  }
}

export async function copyRatingRulesAction(
  _previous: RatingRulesActionState,
  formData: FormData,
): Promise<RatingRulesActionState> {
  const actor = await actorOf();

  if (actor === null) {
    return { error: 'settings.errors.unauthorized' };
  }

  const toHouseId = houseOf(formData);
  const fromHouseId = text(formData, 'fromHouseId');

  if (toHouseId === null || fromHouseId === '') {
    return { error: 'rating.errors.houseRequired' };
  }

  try {
    await copyRatingRules(actor, { fromHouseId, toHouseId });

    revalidatePath('/settings/rating');

    return { done: 'rating.rules.copied' };
  } catch (error) {
    if (error instanceof AppError) {
      return { error: `rating.errors.${error.code}` };
    }

    throw error;
  }
}
