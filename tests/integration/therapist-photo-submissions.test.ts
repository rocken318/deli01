import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";

// approve/reject アクションは revalidatePath を呼ぶ（テストはリクエストスコープ外）ためモック
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import {
  approvePhotoSubmission,
  rejectPhotoSubmission,
} from "@/lib/cms/photo-review-actions";

/**
 * 機能H（キャスト写真の提出→承認/却下）の実Postgres検証。自己完結。
 * RLS: 本人のみ自分の提出を insert/select・提出後の変更は不可。
 * approve: media 作成＋下書きギャラリー(photo)に追加＋submission=approved。reject: rejected。
 * approve/reject アクションは ADMIN_DEV_SESSION=1 の owner スタブで動く。
 */
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/deli01";
const sql = postgres(url, { max: 5, onnotice: () => {} });
const OWNER: Session = { userId: "aaaaaaaa-0000-4000-8000-000000000001", role: "owner" };

const SLUG = "ztest-photo";
const APP_USER = "cccccccc-0000-4000-8000-0000000000f1";
let therapistId = "";
let otherTherapistId = "";
let therapistSession: Session;

beforeAll(async () => {
  const t = await sql<{ id: string }[]>`
    insert into therapists (slug, status, display_order) values (${SLUG}, 'active', 9200)
    on conflict (slug) do update set status = 'active' returning id`;
  therapistId = t[0]!.id;
  await sql`
    insert into entity_records (entity, slug, draft, published, published_at)
    values ('therapist', ${SLUG}, ${sql.json({ name: "写真テスト" })}, ${sql.json({ name: "写真テスト" })}, now())
    on conflict (entity, slug) do update set draft = excluded.draft`;
  await sql`
    insert into app_users (id, role, display_name, therapist_id, is_active)
    values (${APP_USER}::uuid, 'therapist', ${"写真テスト"}, ${therapistId}::uuid, true)
    on conflict (id) do update set therapist_id = excluded.therapist_id, is_active = true`;
  therapistSession = { userId: APP_USER, role: "therapist", therapistId };
  const other = await sql<{ id: string }[]>`select id from therapists where id <> ${therapistId}::uuid limit 1`;
  otherTherapistId = other[0]!.id;
});

afterAll(async () => {
  await sql`delete from therapist_photo_submissions where therapist_id = ${therapistId}`;
  await sql`delete from media where 'cast-submitted' = any(tags) and alt like ${SLUG + "%"}`;
  await sql`delete from app_users where id = ${APP_USER}::uuid`;
  await sql`delete from entity_records where entity = 'therapist' and slug = ${SLUG}`;
  await sql`delete from therapists where id = ${therapistId}`;
  await sql.end();
});

async function insertSubmission(session: Session, tId: string) {
  return withUser(sql, session, (tx) =>
    tx<{ id: string }[]>`
      insert into therapist_photo_submissions (therapist_id, url, storage_path, mime, consent_flag, status)
      values (${tId}::uuid, ${"https://example.com/x.jpg"}, ${"p/x.jpg"}, 'image/jpeg', true, 'pending')
      returning id`,
  );
}

describe("H: RLS（本人のみ・提出後不変）", () => {
  it("本人は自分の提出を insert できる", async () => {
    const rows = await insertSubmission(therapistSession, therapistId);
    expect(rows[0]?.id).toBeTruthy();
  });

  it("本人でも他人の therapist_id では insert できない（with check 違反）", async () => {
    await expect(insertSubmission(therapistSession, otherTherapistId)).rejects.toThrow();
  });

  it("本人は自分の提出のみ select できる", async () => {
    const seen = await withUser(sql, therapistSession, (tx) =>
      tx<{ therapist_id: string }[]>`select therapist_id from therapist_photo_submissions`,
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.therapist_id === therapistId)).toBe(true);
  });

  it("本人は提出を update できない（承認/却下は管理のみ・0行で不変）", async () => {
    const [row] = await insertSubmission(therapistSession, therapistId);
    // therapist に UPDATE ポリシーが無い＝RLS で対象0行（例外でなく無変更）
    await withUser(sql, therapistSession, (tx) =>
      tx`update therapist_photo_submissions set status = 'approved' where id = ${row!.id}::uuid`,
    );
    const after = await sql<{ status: string }[]>`
      select status::text as status from therapist_photo_submissions where id = ${row!.id}::uuid`;
    expect(after[0]!.status).toBe("pending");
  });
});

describe("H: 承認/却下アクション（owner スタブ）", () => {
  it("承認で media が作られ、下書き photo ギャラリーに追加され、approved になる", async () => {
    const [sub] = await insertSubmission(therapistSession, therapistId);
    const res = await approvePhotoSubmission({ id: sub!.id, faceVisibility: "face" });
    expect(res.ok).toBe(true);
    if (!res.ok || !res.data) throw new Error("approve failed");

    // submission approved + media_id
    const s = await sql<{ status: string; media_id: string | null }[]>`
      select status::text as status, media_id from therapist_photo_submissions where id = ${sub!.id}::uuid`;
    expect(s[0]!.status).toBe("approved");
    expect(s[0]!.media_id).toBe(res.data.mediaId);

    // media 実体（consent 引き継ぎ）
    const m = await sql<{ consent_flag: boolean }[]>`
      select consent_flag from media where id = ${res.data.mediaId}::uuid`;
    expect(m[0]!.consent_flag).toBe(true);

    // 下書き photo に media id が入っている
    const rec = await sql<{ draft: { photo?: string[] } }[]>`
      select draft from entity_records where entity = 'therapist' and slug = ${SLUG}`;
    expect(rec[0]!.draft.photo).toContain(res.data.mediaId);
  });

  it("却下すると rejected になり media は作られない", async () => {
    const [sub] = await insertSubmission(therapistSession, therapistId);
    const res = await rejectPhotoSubmission({ id: sub!.id, note: "画質が低い" });
    expect(res.ok).toBe(true);
    const s = await sql<{ status: string; media_id: string | null; review_note: string | null }[]>`
      select status::text as status, media_id, review_note
      from therapist_photo_submissions where id = ${sub!.id}::uuid`;
    expect(s[0]!.status).toBe("rejected");
    expect(s[0]!.media_id).toBeNull();
    expect(s[0]!.review_note).toBe("画質が低い");
  });
});
