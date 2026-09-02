import type { Metadata } from 'next';
import { listPendingPhotoSubmissions } from '@/lib/cms/photo-review-actions';
import PhotoReviewClient from './PhotoReviewClient';

export const metadata: Metadata = { title: '写真承認' };
export const dynamic = 'force-dynamic';

/**
 * キャストが提出したプロフィール写真の承認/却下（機能H）。owner/admin のみ。
 * 承認すると media 化＋当該セラピストの下書きギャラリーに追加される（公開は掲載ボタンで）。
 */
export default async function PhotoSubmissionsPage() {
  const res = await listPendingPhotoSubmissions();

  return (
    <div>
      <h1 className="text-xl font-semibold text-adm-text mb-1">写真承認</h1>
      <p className="text-sm text-adm-muted mb-4">
        キャストが提出した写真を確認し、承認/却下します。承認すると下書きに追加され、
        各セラピストの「掲載」で公開されます（承認だけでは公開されません）。
      </p>
      {!res.ok ? (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm">
          {res.error}
        </div>
      ) : (
        <PhotoReviewClient initialItems={res.data ?? []} />
      )}
    </div>
  );
}
