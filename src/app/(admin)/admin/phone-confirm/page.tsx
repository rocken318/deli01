import type { Metadata } from 'next';
import { listUnconfirmedReservations } from '../orders/actions';
import PhoneConfirmList from './PhoneConfirmList';

export const metadata: Metadata = {
  title: '電話確認一覧',
};

/**
 * 電話確認画面（Server Component）。
 * Web 予約で phone_confirmed_at が null の予約一覧を表示し、
 * 架電結果を記録できる。
 */
export default async function PhoneConfirmPage() {
  const result = await listUnconfirmedReservations();
  const reservations = result.ok ? (result.data ?? []) : [];
  const error = result.ok ? undefined : result.error;

  return (
    <div>
      <h1 className="text-xl font-semibold text-adm-text mb-2">電話確認一覧</h1>
      <p className="text-sm text-adm-muted mb-6">
        Web 予約で電話確認が未完了の予約一覧です。確認後に「確認記録」ボタンで結果を記録してください。
      </p>
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm mb-4">
          {error}
        </div>
      )}
      <PhoneConfirmList initialReservations={reservations} />
    </div>
  );
}
