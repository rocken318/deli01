'use server';

/**
 * 管理側: キャスト提出写真の承認/却下（機能H・承認制）。owner/admin のみ。
 * 承認時のみ media を作成し（consent_flag は本人同意を引き継ぐ）、当該セラピストの
 * entity_records 下書きの画像ギャラリーに追加する。公開は従来の掲載ボタン
 * （publishTherapistProfile・同意ゲート）を経る＝AI/自動でなく人が公開する ethos。
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { can } from '@/domain/auth';
import { toActor } from '@/lib/auth/session';
import { getDevSession } from '@/lib/cms/dev-session';
import { getClient } from '@/lib/db-client';
import { withUser } from '@/lib/auth/with-user';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface PendingPhotoSubmission {
  id: string;
  therapistId: string;
  therapistName: string;
  therapistSlug: string;
  url: string;
  consentFlag: boolean;
  castNote: string | null;
  createdAt: string;
}

const uuid = z.string().uuid();
const faceSchema = z.enum(['face', 'eyes', 'none']);

async function guard() {
  const session = await getDevSession();
  if (!session) return { session: null, error: '認証が必要です' as const };
  if (!can(toActor(session), 'manage_cms')) {
    return { session: null, error: '権限がありません' as const };
  }
  return { session, error: null };
}

/** 承認待ちの提出一覧（owner/admin）。 */
export async function listPendingPhotoSubmissions(): Promise<
  ActionResult<PendingPhotoSubmission[]>
> {
  const g = await guard();
  if (!g.session) return { ok: false, error: g.error };
  try {
    const sql = getClient();
    const rows = await withUser(sql, g.session, (tx) =>
      tx<
        {
          id: string;
          therapist_id: string;
          name: string | null;
          slug: string;
          url: string;
          consent_flag: boolean;
          cast_note: string | null;
          created_at: string;
        }[]
      >`
        select s.id, s.therapist_id,
               coalesce(er.published ->> 'name', er.draft ->> 'name', t.slug) as name,
               t.slug, s.url, s.consent_flag, s.cast_note,
               to_char(s.created_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') as created_at
        from therapist_photo_submissions s
        join therapists t on t.id = s.therapist_id
        left join entity_records er on er.entity = 'therapist' and er.slug = t.slug
        where s.status = 'pending'
        order by s.created_at asc
      `,
    );
    return {
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        therapistId: r.therapist_id,
        therapistName: r.name ?? r.slug,
        therapistSlug: r.slug,
        url: r.url,
        consentFlag: r.consent_flag,
        castNote: r.cast_note,
        createdAt: r.created_at,
      })),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '取得に失敗しました' };
  }
}

const approveSchema = z.object({
  id: uuid,
  faceVisibility: faceSchema.default('face'),
  alt: z.string().max(300).optional(),
});

/**
 * 承認: media を作成し、当該セラピストの下書きギャラリーに追加。提出を approved に。
 * media.consent_flag は本人同意（submission.consent_flag）を引き継ぐ＝未同意は公開ゲートで弾かれる。
 */
export async function approvePhotoSubmission(
  input: z.infer<typeof approveSchema>,
): Promise<ActionResult<{ mediaId: string }>> {
  const parsed = approveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力を確認してください' };
  const g = await guard();
  if (!g.session) return { ok: false, error: g.error };
  const d = parsed.data;

  try {
    const sql = getClient();
    const out = await withUser(sql, g.session, async (tx) => {
      // 1. 提出を取得（pending のみ・ロック）
      const subs = await tx<
        {
          therapist_id: string;
          url: string;
          storage_path: string;
          mime: string;
          width: number | null;
          height: number | null;
          consent_flag: boolean;
        }[]
      >`
        select therapist_id, url, storage_path, mime, width, height, consent_flag
        from therapist_photo_submissions
        where id = ${d.id}::uuid and status = 'pending'
        for update
      `;
      const sub = subs[0];
      if (!sub) return { kind: 'not_pending' as const };

      const slugRows = await tx<{ slug: string }[]>`
        select slug from therapists where id = ${sub.therapist_id}::uuid limit 1
      `;
      const slug = slugRows[0]?.slug;
      if (!slug) return { kind: 'no_therapist' as const };

      // 2. media 作成（同意は本人提出を引き継ぐ）
      const alt = d.alt?.trim() || `${slug} のプロフィール写真`;
      const mediaRows = await tx<{ id: string }[]>`
        insert into media
          (storage_path, url, mime, width, height, alt, tags, consent_flag, consent_date, face_visibility, is_placeholder)
        values (${sub.storage_path}, ${sub.url}, ${sub.mime}, ${sub.width}, ${sub.height},
          ${alt}, ${['therapist', 'cast-submitted']}::text[], ${sub.consent_flag},
          ${sub.consent_flag ? new Date() : null}, ${d.faceVisibility}::face_visibility, false)
        returning id
      `;
      const mediaId = mediaRows[0]!.id;

      // 3. ギャラリーの field key を特定（image_gallery を優先）
      const fieldRows = await tx<{ key: string; type: string }[]>`
        select key, type from field_definitions
        where entity = 'therapist' and type in ('image', 'image_gallery')
        order by (type = 'image_gallery') desc
        limit 1
      `;
      const field = fieldRows[0];
      if (!field) return { kind: 'no_field' as const };

      // 4. 下書きに追記（無ければ作成）
      const recRows = await tx<{ draft: Record<string, unknown> | null }[]>`
        select draft from entity_records
        where entity = 'therapist' and slug = ${slug}
        for update
      `;
      const draft = (recRows[0]?.draft ?? {}) as Record<string, unknown>;
      const asJson = (v: Record<string, unknown>) => tx.json(v as Parameters<typeof tx.json>[0]);
      if (field.type === 'image_gallery') {
        const cur = Array.isArray(draft[field.key])
          ? (draft[field.key] as unknown[]).filter((v): v is string => typeof v === 'string')
          : [];
        draft[field.key] = [...cur, mediaId];
      } else {
        draft[field.key] = mediaId; // 単一 image は差し替え
      }

      if (recRows.length > 0) {
        await tx`
          update entity_records set draft = ${asJson(draft)}
          where entity = 'therapist' and slug = ${slug}
        `;
      } else {
        await tx`
          insert into entity_records (entity, slug, draft)
          values ('therapist', ${slug}, ${asJson(draft)})
        `;
      }

      // 5. 提出を approved に
      await tx`
        update therapist_photo_submissions
        set status = 'approved', media_id = ${mediaId}::uuid,
            reviewed_by = ${g.session!.userId}::uuid, reviewed_at = now()
        where id = ${d.id}::uuid
      `;
      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id, after)
        values (${g.session!.userId}::uuid, 'approve', 'therapist_photo_submission', ${d.id}::uuid,
          ${tx.json({ mediaId, slug, field: field.key })})
      `;

      return { kind: 'ok' as const, mediaId, slug };
    });

    if (out.kind === 'not_pending') return { ok: false, error: '承認できません（既に処理済み、または対象外）' };
    if (out.kind === 'no_therapist') return { ok: false, error: 'セラピストが見つかりません' };
    if (out.kind === 'no_field') return { ok: false, error: 'セラピストの画像フィールド定義がありません' };

    revalidatePath('/admin/photo-submissions');
    revalidatePath(`/admin/therapists/${out.slug}`);
    return { ok: true, data: { mediaId: out.mediaId } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '承認に失敗しました' };
  }
}

const rejectSchema = z.object({ id: uuid, note: z.string().max(500).optional() });

/** 却下: 提出を rejected に（media は作らない）。 */
export async function rejectPhotoSubmission(
  input: z.infer<typeof rejectSchema>,
): Promise<ActionResult> {
  const parsed = rejectSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力を確認してください' };
  const g = await guard();
  if (!g.session) return { ok: false, error: g.error };
  const d = parsed.data;
  try {
    const sql = getClient();
    const done = await withUser(sql, g.session, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        update therapist_photo_submissions
        set status = 'rejected', review_note = ${d.note?.trim() || null},
            reviewed_by = ${g.session!.userId}::uuid, reviewed_at = now()
        where id = ${d.id}::uuid and status = 'pending'
        returning id
      `;
      return rows.length > 0;
    });
    if (!done) return { ok: false, error: '却下できません（既に処理済み）' };
    revalidatePath('/admin/photo-submissions');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '却下に失敗しました' };
  }
}
