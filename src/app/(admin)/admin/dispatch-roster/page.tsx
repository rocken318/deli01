import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { getDevSession } from '@/lib/cms/dev-session';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { listTaxiCompanies, listDriverMessages } from '@/lib/dispatch-roster/actions';
import { DispatchRosterClient } from './DispatchRosterClient';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: '配車名簿' };

export default async function DispatchRosterPage() {
  const session = await getDevSession();
  if (!session) redirect('/login');

  const [taxiResult, messageResult] = await Promise.all([
    listTaxiCompanies(),
    listDriverMessages(50),
  ]);

  return (
    <DispatchRosterClient
      initialTaxiCompanies={taxiResult.ok ? (taxiResult.data ?? []) : []}
      initialMessages={messageResult.ok ? (messageResult.data ?? []) : []}
      taxiError={taxiResult.ok ? undefined : taxiResult.error}
      messageError={messageResult.ok ? undefined : messageResult.error}
      canWrite={can(toActor(session), 'manage_cms')}
    />
  );
}