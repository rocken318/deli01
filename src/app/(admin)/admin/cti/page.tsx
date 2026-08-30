/**
 * CTI 着信ポップ（フェーズ22・下地のみ / spec 付録A#6・L1074）。
 * 直近の着信（cti_events）を新しい順に表示する。着信 webhook（/api/cti/incoming）が
 * 積んだ行をここで見せる＝「着信ポップ」の下地。リアルタイム push は先送り（force-dynamic 表示）。
 */

import { getClient } from '@/lib/db-client';
import { getDevSession } from '@/lib/cms/dev-session';
import { withUser } from '@/lib/auth/with-user';
import { formatInTimeZone } from 'date-fns-tz';

export const dynamic = 'force-dynamic';

const TZ = 'Asia/Tokyo';

export default async function CtiPage() {
  const session = await getDevSession();
  if (!session) return <p className="text-adm-muted">認証が必要です。</p>;

  const sql = getClient();
  const rows = await withUser(sql, session, async (tx) => {
    return tx<{
      id: string;
      phone: string;
      customer_id: string | null;
      matched_name: string | null;
      occurred_at: Date;
    }[]>`
      select id::text, phone, customer_id, matched_name, occurred_at
      from cti_events
      order by occurred_at desc
      limit 50
    `;
  });

  return (
    <div>
      <h1 className="text-lg font-semibold mb-2">着信ポップ</h1>
      <p className="text-sm text-adm-muted mb-4">
        直近の着信です（着信 webhook 経由・下地）。回線契約とリアルタイム表示は事業判断後に配線します。
      </p>
      {rows.length === 0 ? (
        <p className="text-adm-muted">着信はまだありません。</p>
      ) : (
        <div className="bg-adm-surface border border-adm-border" style={{ borderRadius: '4px' }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-adm-border text-left text-xs text-adm-muted">
                <th className="px-3 py-2">着信時刻</th>
                <th className="px-3 py-2">電話番号</th>
                <th className="px-3 py-2">顧客</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-adm-border last:border-0">
                  <td className="px-3 py-2">
                    {formatInTimeZone(new Date(r.occurred_at), TZ, 'M/d HH:mm:ss')}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    <a href={`tel:${r.phone}`} className="text-adm-primary">{r.phone}</a>
                  </td>
                  <td className="px-3 py-2">
                    {r.matched_name ? (
                      <span className="font-semibold">{r.matched_name}</span>
                    ) : (
                      <span className="text-adm-muted">新規（未登録）</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
