import { getTranslations } from 'next-intl/server';

import { Card, CardHeader, CardTitle } from '@/components/ui/card';

import { ProfileForm } from '../../profile/profile-form';

import type { DeclaredFieldView } from '@/services/profile-fields';
import type { ProfileView } from '@/services/resident-profiles';

/**
 * Профиль жильца с правкой прямо в карточке (модуль 1: «профиль
 * (редактируемый)»; указание владельца, 25 сентября 2026).
 *
 * Форма та же, что у жильца в «Моём профиле», и действие то же: своя копия
 * однажды разошлась бы с оригиналом. Чей профиль правим — говорит скрытое
 * поле, а право проверяет сервис по цели.
 *
 * Комната и место здесь только для чтения, как и у жильца: их меняют
 * на «Схеме мест».
 */
export async function ProfileSection({
  profile,
  declaredFields,
  userId,
  room,
  bed,
  canReplaceSecrets,
}: {
  profile: ProfileView;
  declaredFields: DeclaredFieldView[];
  userId: string;
  room: string | null;
  bed: string | null;
  canReplaceSecrets: boolean;
}) {
  const t = await getTranslations('profile');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>

      <div className="p-4 pt-0">
        <ProfileForm
          canReplaceSecrets={canReplaceSecrets}
          declaredFields={declaredFields}
          placement={{ room, bed }}
          userId={userId}
          values={{
            lastName: profile.lastName ?? '',
            firstName: profile.firstName ?? '',
            middleName: profile.middleName ?? '',
            sex: profile.sex ?? '',
            birthDate: profile.birthDate ?? '',
            phone: profile.phone ?? '',
            idDocIssuer: profile.idDocIssuer ?? '',
            registrationAddress: profile.registrationAddress ?? '',
            university: profile.university ?? '',
            course: profile.course === null ? '' : String(profile.course),
            major: profile.major ?? '',
            emergencyName: profile.emergencyName ?? '',
            emergencyPhone: profile.emergencyPhone ?? '',
            emergencyRelation: profile.emergencyRelation ?? '',
            preferredPayment: profile.preferredPayment ?? '',
            noEpilepsy: profile.noEpilepsy === true,
            noAsthma: profile.noAsthma === true,
            iinMasked: profile.iinMasked,
            idDocNumberMasked: profile.idDocNumberMasked,
          }}
        />
      </div>
    </Card>
  );
}
