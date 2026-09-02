'use server';

/**
 * キャスト本人のプロフィール写真「提出」（機能H・承認制/下書き止まり）。
 * 本人が Vercel Blob にアップロード → therapist_photo_submissions に pending で積むだけ。
 * media 化・公開は管理の承認を経る（src/lib/cms/photo-review-actions.ts）。
 * media は owner/admin のみ write（0003）＝キャストは直接 media を作れない、が本設計の要。
 * セッション解決は getTherapistDevSession（RLS で本人の therapist_id のみ insert 可 / 0023）。
 */

import { put } from '@vercel/blob';
import { getClient } from '@/lib/db-client';
import { withUser } from '@/lib/auth/with-user';
import { getTherapistDevSession } from '@/lib/cms/dev-session';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

export type PhotoSubmissionStatus = 'pending' | 'approved' | 'rejected';

export interface MyPhotoSubmission {
  id: string;
  url: string;
  status: PhotoSubmissionStatus;
  consentFlag: boolean;
  castNote: string | null;
  reviewNote: string | null;
  createdAt: string;
}

const MAX_BYTES = 4.5 * 1024 * 1024;

/** 本人が写真を提出（pending）。掲載同意チェック必須。 */
export async function submitMyPhoto(
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const asSlug = (formData.get('asSlug') as string | null) ?? undefined;
  const session = await getTherapistDevSession(asSlug);
  if (!session || session.role !== 'therapist' || !session.therapistId) {
    return { ok: false, error: '認証が必要です（セラピスト）' };
  }

  const file = formData.get('file');
  const consent =
    formData.get('consent') === 'on' || formData.get('consent') === 'true';
  const note = ((formData.get('note') as string | null) ?? '').trim() || null;

  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'ファイルが選択されていません' };
  }
  if (!file.type.startsWith('image/')) {
    return { ok: false, error: '画像ファイルを選んでください' };
  }
  if (file.size > MAX_BYTES) {
    return { ok: false, error: '画像が大きすぎます（4.5MB以下に縮小してください）' };
  }
  if (!consent) {
    return { ok: false, error: '掲載への同意にチェックしてください（承認後に公開されます）' };
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
    return { ok: false, error: '画像ストレージ（Vercel Blob）が未設定です' };
  }

  const therapistId = session.therapistId;
  try {
    const blob = await put(`therapist-submissions/${file.name}`, file, {
      access: 'public',
      addRandomSuffix: true,
      contentType: file.type,
    });
    const sql = getClient();
    const res = await withUser(sql, session, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        insert into therapist_photo_submissions
          (therapist_id, url, storage_path, mime, consent_flag, cast_note, status)
        values (${therapistId}::uuid, ${blob.url}, ${blob.pathname}, ${file.type},
          ${consent}, ${note}, 'pending')
        returning id
      `;
      const row = rows[0];
      if (!row) throw new Error('提出の登録に失敗しました');
      return row;
    });
    return { ok: true, data: { id: res.id } };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'アップロードに失敗しました',
    };
  }
}

/** 本人の提出一覧（RLS で自分の分のみ）。 */
export async function listMyPhotoSubmissions(
  asSlug?: string,
): Promise<ActionResult<MyPhotoSubmission[]>> {
  const session = await getTherapistDevSession(asSlug);
  if (!session || session.role !== 'therapist') {
    return { ok: false, error: '認証が必要です（セラピスト）' };
  }
  try {
    const sql = getClient();
    const rows = await withUser(sql, session, (tx) =>
      tx<
        {
          id: string;
          url: string;
          status: PhotoSubmissionStatus;
          consent_flag: boolean;
          cast_note: string | null;
          review_note: string | null;
          created_at: string;
        }[]
      >`
        select id, url, status::text as status, consent_flag, cast_note, review_note,
               to_char(created_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') as created_at
        from therapist_photo_submissions
        order by created_at desc
        limit 50
      `,
    );
    return {
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        url: r.url,
        status: r.status,
        consentFlag: r.consent_flag,
        castNote: r.cast_note,
        reviewNote: r.review_note,
        createdAt: r.created_at,
      })),
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : '提出一覧の取得に失敗しました',
    };
  }
}
