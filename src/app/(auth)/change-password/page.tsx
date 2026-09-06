import { redirect } from 'next/navigation';

import { getCurrentSession } from '@/lib/session';

import { ChangePasswordForm } from './change-password-form';

export const dynamic = 'force-dynamic';

export default async function ChangePasswordPage() {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  return <ChangePasswordForm required={session.user.mustChangePassword} />;
}
