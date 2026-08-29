import "server-only";
import { getClient } from "@/lib/db-client";

/**
 * 公開側の読み取り（spec 2章 / 2-7）。
 *
 * 方針:
 * - **published のみ**を読む。draft は公開側に一切出さない。
 * - media は published/consent・is_hidden を尊重（同意なし・非表示は出さない）。
 * - therapists は status='active' かつ entity_records.published が非 null のものだけ。
 *   退職（retired）・未公開（published is null）は一覧・個人ページに出さない。
 * - RLS 対象テーブルでもここが読むのは公開可能な published 列のみなので、
 *   セッション不要で getClient()（BYPASSRLS）から読み、クエリ側で公開条件を絞る。
 *   （getEntityRecord は draft も返し RLS を要するため公開側では使わない）
 *
 * キャッシュ（spec 2-7）はページ側の revalidate 指定で扱う。空き枠はキャッシュしない。
 */

/** 公開セラピスト1件（一覧カード・個人ページ共通の素材） */
export interface PublicTherapist {
  slug: string;
  displayOrder: number;
  /** entity_records.published（field_definitions 駆動で描画する生の値） */
  published: Record<string, unknown>;
  publishedAt: Date | null;
}

/** 公開可能なメディア（consent 済み・非表示でない） */
export interface PublicMedia {
  id: string;
  url: string;
  alt: string;
  faceVisibility: "face" | "eyes" | "none";
  width: number | null;
  height: number | null;
}

interface TherapistRow {
  slug: string;
  display_order: number;
  published: Record<string, unknown> | null;
  published_at: Date | null;
}

/**
 * 公開中のセラピスト一覧を display_order 順で返す。
 * status='active' かつ entity_records.published が非 null のものだけ。
 */
export async function listPublicTherapists(): Promise<PublicTherapist[]> {
  const sql = getClient();
  const rows = await sql<TherapistRow[]>`
    select t.slug, t.display_order, r.published, r.published_at
    from therapists t
    join entity_records r
      on r.entity = 'therapist' and r.slug = t.slug
    where t.status = 'active'
      and r.published is not null
    order by t.display_order asc, t.created_at asc
  `;
  return rows
    .filter((r): r is TherapistRow & { published: Record<string, unknown> } => r.published !== null)
    .map((r) => ({
      slug: r.slug,
      displayOrder: r.display_order,
      published: r.published,
      publishedAt: r.published_at,
    }));
}

/**
 * slug から公開中のセラピストを1件返す。
 * status='active' かつ published が非 null でなければ null（退職・未公開は 404 相当）。
 */
export async function getPublicTherapist(slug: string): Promise<PublicTherapist | null> {
  const sql = getClient();
  const rows = await sql<TherapistRow[]>`
    select t.slug, t.display_order, r.published, r.published_at
    from therapists t
    join entity_records r
      on r.entity = 'therapist' and r.slug = t.slug
    where t.status = 'active'
      and r.published is not null
      and t.slug = ${slug}
    limit 1
  `;
  const row = rows[0];
  if (!row || row.published === null) return null;
  return {
    slug: row.slug,
    displayOrder: row.display_order,
    published: row.published,
    publishedAt: row.published_at,
  };
}

interface MediaRow {
  id: string;
  url: string;
  alt: string;
  face_visibility: "face" | "eyes" | "none";
  width: number | null;
  height: number | null;
}

/**
 * 指定 id 群のうち、公開可能なメディアだけを id→media のマップで返す。
 *
 * - is_hidden=true は常に除外（退職処理・手動非表示 / spec 3-7）。
 * - requireConsent=true（既定）のときは consent_flag=true のものだけ。
 *   人物写真（セラピスト）は掲載同意が必須（spec 3-7 / 4章）。
 * - CMS ブロック画像（ヒーロー/コース案内など人物でない素材）は
 *   requireConsent=false で呼び、is_hidden のみを尊重する。
 *
 * 同意なし・非表示は結果に含めない（＝公開側で描画されない）。
 */
export async function getPublicMediaMap(
  ids: string[],
  opts: { requireConsent?: boolean } = {},
): Promise<Map<string, PublicMedia>> {
  const requireConsent = opts.requireConsent ?? true;
  const map = new Map<string, PublicMedia>();
  const valid = ids.filter((id) => typeof id === "string" && id.length > 0);
  if (valid.length === 0) return map;

  const sql = getClient();
  const rows = await sql<MediaRow[]>`
    select id, url, alt, face_visibility, width, height
    from media
    where id = any(${valid}::uuid[])
      and is_hidden = false
      and (${!requireConsent} or consent_flag = true)
  `;
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      url: r.url,
      alt: r.alt,
      faceVisibility: r.face_visibility,
      width: r.width,
      height: r.height,
    });
  }
  return map;
}
