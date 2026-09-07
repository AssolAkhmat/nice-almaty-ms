import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { requireArea, requireBed } from '@/db/repositories/areas';
import { findOpenAssignment, listResidencies } from '@/db/repositories/residencies';
import { getCurrentSession } from '@/lib/session';
import { listOwnPushSubscriptions, pushKeyForBrowser } from '@/services/notifications';
import { readProfile } from '@/services/resident-profiles';

import { ProfileForm, type PlacementView, type ProfileFormValues } from './profile-form';
import { PushSubscription } from './push-subscription';

export const dynamic = 'force-dynamic';

/**
 * «Мой профиль» (docs/04-MODULES/01-onboarding.md).
 * Комната и место — только чтение: их назначает админ.
 */
export default async function ProfilePage() {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const t = await getTranslations('profile');
  const { context } = session;

  const profile = await readProfile({ context }, session.user.id);

  const subscriptions = await listOwnPushSubscriptions(context);

  const [residency] = await listResidencies(context, {});
  const assignment = residency === undefined ? null : await findOpenAssignment(residency.id);

  let placement: PlacementView = { room: null, bed: null };
  if (assignment !== null) {
    const bed = await requireBed(context, assignment.bedId);
    const area = await requireArea(context, bed.areaId);
    placement = { room: area.name, bed: bed.label };
  }

  const values: ProfileFormValues = {
    lastName: profile.lastName ?? '',
    firstName: profile.firstName ?? '',
    middleName: profile.middleName ?? '',
    sex: profile.sex ?? '',
    birthDate: profile.birthDate ?? '',
    phone: profile.phone ?? session.user.phone,
    idDocIssuer: profile.idDocIssuer ?? '',
    registrationAddress: profile.registrationAddress ?? '',
    university: profile.university ?? '',
    course: profile.course === null ? '' : String(profile.course),
    major: profile.major ?? '',
    emergencyName: profile.emergencyName ?? '',
    emergencyPhone: profile.emergencyPhone ?? '',
    emergencyRelation: profile.emergencyRelation ?? '',
    preferredPayment: profile.preferredPayment ?? '',
    noEpilepsy: profile.noEpilepsy ?? false,
    noAsthma: profile.noAsthma ?? false,
    iinMasked: profile.iinMasked,
    idDocNumberMasked: profile.idDocNumberMasked,
  };

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1>{t('title')}</h1>
        <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
      </div>

      <ProfileForm placement={placement} values={values} />

      <PushSubscription active={subscriptions.length > 0} publicKey={pushKeyForBrowser()} />
    </section>
  );
}
