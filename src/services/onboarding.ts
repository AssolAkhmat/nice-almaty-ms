import { getDb, type Executor } from '@/db/client';
import { findPlacementOfResidency } from '@/db/repositories/areas';
import { listDocuments, listDocumentTypes } from '@/db/repositories/documents';
import { listResidencies } from '@/db/repositories/residencies';
import { findProfile } from '@/db/repositories/resident-profiles';
import { documentValidity } from '@/domain/documents';
import { parseBusinessDate, todayInAlmaty, type BusinessDate } from '@/lib/time';

import type { Residency, ResidentProfile } from '@/db/schema';
import type { UserActor } from './users';

/**
 * Мастер заселения (docs/03-BUSINESS-RULES.md §1.2, docs/04-MODULES/01-onboarding.md).
 *
 * Последовательность жёсткая: профиль → место → договор → документы → депозит.
 * До оплаты депозита жильцу доступны только профиль, документы и свои счета,
 * поэтому здесь же считается признак блокировки остальных модулей.
 */
export const ONBOARDING_STEPS = ['profile', 'bed', 'contract', 'documents', 'deposit'] as const;

export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingStep {
  key: OnboardingStepKey;
  done: boolean;
}

export interface OnboardingView {
  residency: Residency | null;
  steps: OnboardingStep[];
  /** Остальные модули закрыты, пока депозит не оплачен (§1.2). */
  isBlocked: boolean;
}

export interface OnboardingDeps {
  executor?: Executor;
  today?: BusinessDate;
}

/**
 * Обязательные поля профиля. В модуле 1 перечислен состав формы, но не сказано,
 * что из этого обязательно; выбран консервативный набор — всё, кроме отчества
 * и степени родства контакта, которых может не быть (P2-27).
 */
const REQUIRED_PROFILE_FIELDS = [
  'lastName',
  'firstName',
  'sex',
  'birthDate',
  'phone',
  'university',
  'course',
  'major',
  'emergencyName',
  'emergencyPhone',
  'preferredPayment',
] as const satisfies readonly (keyof ResidentProfile)[];

function isProfileComplete(profile: ResidentProfile | null): boolean {
  if (profile === null) {
    // Профиля ещё нет вовсе: он заводится при первом сохранении.
    return false;
  }

  const filled = REQUIRED_PROFILE_FIELDS.every((field) => {
    const value = profile[field];

    return value !== null && value !== undefined && value !== '';
  });

  // ИИН и УДЛ хранятся шифрованными: заполненность видна по последним знакам.
  return filled && profile.iinLast4 !== null && profile.idDocLast4 !== null;
}

export async function readOnboarding(
  actor: UserActor,
  deps: OnboardingDeps = {},
): Promise<OnboardingView> {
  const executor = deps.executor ?? getDb();
  const today = deps.today ?? todayInAlmaty();

  const [residency] = await listResidencies(actor.context, {}, executor);

  if (residency === undefined) {
    return {
      residency: null,
      steps: ONBOARDING_STEPS.map((key) => ({ key, done: false })),
      isBlocked: true,
    };
  }

  const [profile, placement, types, documents] = await Promise.all([
    findProfile(actor.context, residency.userId, executor),
    findPlacementOfResidency(actor.context, residency.id, executor),
    listDocumentTypes(actor.context, {}, executor),
    listDocuments(actor.context, { residencyId: residency.id }, executor),
  ]);

  const approved = new Set(
    documents
      .filter((document) => document.status === 'approved')
      .filter((document) => {
        const validUntil =
          document.validUntil === null ? null : parseBusinessDate(document.validUntil);

        return documentValidity(validUntil, today) !== 'expired';
      })
      .map((document) => document.documentTypeId),
  );

  const requiredTypes = types.filter((type) => type.isRequired);
  const documentsDone =
    requiredTypes.length > 0 && requiredTypes.every((type) => approved.has(type.id));

  const done: Readonly<Record<OnboardingStepKey, boolean>> = {
    profile: isProfileComplete(profile),
    bed: placement !== null,
    contract: residency.contractSignedAt !== null,
    documents: documentsDone,
    deposit: residency.status === 'active',
  };

  return {
    residency,
    steps: ONBOARDING_STEPS.map((key) => ({ key, done: done[key] })),
    isBlocked: residency.status !== 'active',
  };
}
