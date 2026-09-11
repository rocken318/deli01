import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getDevSession } from '@/lib/cms/dev-session';
import { listHotelsLookup } from '@/lib/hotels/hotel-lookup-actions';
import { HotelLookupClient } from './HotelLookupClient';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'ホテルリスト' };

export default async function HotelLookupPage() {
  const session = await getDevSession();
  if (!session) redirect('/login');
  const result = await listHotelsLookup();
  return (
    <div>
      <h1 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 2px' }}>ホテルリスト</h1>
      <p style={{ fontSize: 12, color: '#6B7776', margin: '0 0 14px' }}>
        予約中に「このホテル入れる？迎え方は？」を即答。名前で検索→実績・迎え方・注意が一目。
      </p>
      <HotelLookupClient
        initialRows={result.ok ? (result.data ?? []) : []}
        loadError={result.ok ? undefined : result.error}
      />
    </div>
  );
}
