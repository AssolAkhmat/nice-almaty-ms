import { redirect } from 'next/navigation';

import { getCurrentSession } from '@/lib/session';

import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getCurrentSession();
  if (session !== null) {
    redirect(session.user.mustChangePassword ? '/change-password' : '/');
  }

  const params = await searchParams;

  return <LoginForm passwordChanged={params.changed === '1'} />;
}
