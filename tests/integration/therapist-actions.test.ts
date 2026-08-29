import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { publishTherapistProfile, retireTherapist } from "@/domain/cms/therapist-actions";
import { publishEntityRecord } from "@/lib/cms/actions";

/**
 * セラピスト管理 Server Actions の統合テスト（フェーズ4）。
 *
 * 検証の骨子:
 * 1. publishTherapistProfile: 未同意写真があれば ok:false + 日本語エラー
 * 2. publishTherapistProfile: 全件同意済みなら ok:true + entity_records.published 更新
 * 3. retireTherapist: therapists.status=retired + entity_records.published=null + media.is_hidden=true
 *
 * 前提: docker の DB が起動し、migrate + seed 済み（pnpm db:reset 後に実行）。
 * テスト専用データは beforeAll で挿入し afterAll で削除する（冪等クリーンアップ）。
 * Server Action は getDevSession() 経由で owner セッションを取得するため、
 * ADMIN_DEV_SESSION=1 が必要（vitest.config.ts の env: が .env から読む）。
 */

const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/deli01";
const sql = postgres(url, { max: 1, onnotice: () => {} });

const TEST_THERAPIST_SLUG_BLOCKED = "test-blocked-publish";
const TEST_THERAPIST_SLUG_OK = "test-ok-publish";
const TEST_THERAPIST_SLUG_RETIRE = "test-retire-therapist";

const TEST_MEDIA_UNCONSENTED = "cccccccc-0000-4000-8000-000000000011";
const TEST_MEDIA_CONSENTED = "cccccccc-0000-4000-8000-000000000012";
const TEST_MEDIA_RETIRE = "cccccccc-0000-4000-8000-000000000013";

beforeAll(async () => {
  await sql`select 1`;

  await sql`
    insert into media (id, alt, tags, consent_flag, is_placeholder)
    values
      (${TEST_MEDIA_UNCONSENTED}::uuid, 'テスト未同意写真', '{}', false, false),
      (${TEST_MEDIA_CONSENTED}::uuid,   'テスト同意済み写真', '{}', true, false),
      (${TEST_MEDIA_RETIRE}::uuid,      'テスト退職写真',    '{}', true, false)
    on conflict (id) do update
      set alt = excluded.alt, consent_flag = excluded.consent_flag, is_hidden = false
  `;

  await sql`
    insert into field_definitions (entity, key, label, type, sort_order, is_public)
    values ('therapist', 'test_photo', 'テスト写真', 'image'::field_type, 9999, false)
    on conflict (entity, key) do nothing
  `;

  await sql`
    insert into therapists (slug, status, display_order)
    values (${TEST_THERAPIST_SLUG_BLOCKED}, 'active', 990)
    on conflict (slug) do update set status = 'active'
  `;
  await sql`
    insert into entity_records (entity, slug, draft)
    values (
      'therapist',
      ${TEST_THERAPIST_SLUG_BLOCKED},
      ${sql.json({ test_photo: TEST_MEDIA_UNCONSENTED })}
    )
    on conflict (entity, slug) do update
      set draft = excluded.draft, published = null, published_at = null
  `;

  await sql`
    insert into therapists (slug, status, display_order)
    values (${TEST_THERAPIST_SLUG_OK}, 'active', 991)
    on conflict (slug) do update set status = 'active'
  `;
  await sql`
    insert into entity_records (entity, slug, draft)
    values (
      'therapist',
      ${TEST_THERAPIST_SLUG_OK},
      ${sql.json({ test_photo: TEST_MEDIA_CONSENTED })}
    )
    on conflict (entity, slug) do update
      set draft = excluded.draft, published = null, published_at = null
  `;

  await sql`
    insert into therapists (slug, status, display_order)
    values (${TEST_THERAPIST_SLUG_RETIRE}, 'active', 992)
    on conflict (slug) do update set status = 'active', retired_at = null
  `;
  await sql`
    insert into entity_records (entity, slug, draft, published, published_at)
    values (
      'therapist',
      ${TEST_THERAPIST_SLUG_RETIRE},
      ${sql.json({ test_photo: TEST_MEDIA_RETIRE })},
      ${sql.json({ test_photo: TEST_MEDIA_RETIRE })},
      now()
    )
    on conflict (entity, slug) do update
      set draft = excluded.draft,
          published = excluded.published,
          published_at = excluded.published_at
  `;
  await sql`update media set is_hidden = false where id = ${TEST_MEDIA_RETIRE}::uuid`;
});

afterAll(async () => {
  await sql`
    delete from entity_records
    where entity = 'therapist'
      and slug in (
        ${TEST_THERAPIST_SLUG_BLOCKED},
        ${TEST_THERAPIST_SLUG_OK},
        ${TEST_THERAPIST_SLUG_RETIRE}
      )
  `;
  await sql`
    delete from therapists
    where slug in (
      ${TEST_THERAPIST_SLUG_BLOCKED},
      ${TEST_THERAPIST_SLUG_OK},
      ${TEST_THERAPIST_SLUG_RETIRE}
    )
  `;
  await sql`
    delete from media
    where id in (
      ${TEST_MEDIA_UNCONSENTED}::uuid,
      ${TEST_MEDIA_CONSENTED}::uuid,
      ${TEST_MEDIA_RETIRE}::uuid
    )
  `;
  await sql`
    delete from field_definitions
    where entity = 'therapist' and key = 'test_photo'
  `;
  await sql.end({ timeout: 5 });
});

describe("publishEntityRecord: therapist は汎用公開を拒否する（Critical Fix 1 / spec 3-7）", () => {
  it("entity='therapist' は掲載同意ゲート付きの専用公開へ誘導するエラーを返す", async () => {
    const result = await publishEntityRecord("therapist", TEST_THERAPIST_SLUG_OK);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "セラピストの公開は掲載同意チェックのある専用公開を使ってください",
    );
  });

  it("汎用公開が拒否されても entity_records.published は書き換わらない", async () => {
    // このテストは他の describe より前に走る保証がないため、published の状態ではなく
    // 「汎用公開経由では published を触らない」ことを、専用公開前の slug で確認する。
    await publishEntityRecord("therapist", TEST_THERAPIST_SLUG_BLOCKED);
    const rows = await sql<{ published: unknown }[]>`
      select published from entity_records
      where entity = 'therapist' and slug = ${TEST_THERAPIST_SLUG_BLOCKED}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.published).toBeNull();
  });
});

describe("publishTherapistProfile: 未同意写真がある場合", () => {
  it("ok:false を返す", async () => {
    const result = await publishTherapistProfile(TEST_THERAPIST_SLUG_BLOCKED);
    expect(result.ok).toBe(false);
  });

  it("日本語の同意エラーメッセージを含む", async () => {
    const result = await publishTherapistProfile(TEST_THERAPIST_SLUG_BLOCKED);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("掲載同意の無い写真が含まれるため公開できません");
    expect(result.error).toContain("テスト未同意写真");
  });

  it("公開ブロック後も entity_records.published は null のまま", async () => {
    const rows = await sql<{ published: unknown }[]>`
      select published from entity_records
      where entity = 'therapist' and slug = ${TEST_THERAPIST_SLUG_BLOCKED}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.published).toBeNull();
  });
});

describe("publishTherapistProfile: 全件同意済みの場合", () => {
  it("ok:true を返す", async () => {
    const result = await publishTherapistProfile(TEST_THERAPIST_SLUG_OK);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("entity_records.published が draft の内容と一致する", async () => {
    const rows = await sql<{
      draft: Record<string, unknown>;
      published: Record<string, unknown> | null;
      published_at: string | null;
    }[]>`
      select draft, published, published_at
      from entity_records
      where entity = 'therapist' and slug = ${TEST_THERAPIST_SLUG_OK}
    `;
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.published).not.toBeNull();
    expect(row.published_at).not.toBeNull();
    expect(row.published).toEqual(row.draft);
  });
});

describe("retireTherapist", () => {
  it("ok:true を返す", async () => {
    const result = await retireTherapist(TEST_THERAPIST_SLUG_RETIRE);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("therapists.status が retired になり retired_at が設定される", async () => {
    const rows = await sql<{ status: string; retired_at: Date | null }[]>`
      select status, retired_at from therapists
      where slug = ${TEST_THERAPIST_SLUG_RETIRE}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("retired");
    expect(rows[0]!.retired_at).not.toBeNull();
  });

  it("entity_records.published が null になる", async () => {
    const rows = await sql<{ published: unknown; published_at: unknown }[]>`
      select published, published_at from entity_records
      where entity = 'therapist' and slug = ${TEST_THERAPIST_SLUG_RETIRE}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.published).toBeNull();
    expect(rows[0]!.published_at).toBeNull();
  });

  it("関連メディアの is_hidden が true になる", async () => {
    const rows = await sql<{ is_hidden: boolean }[]>`
      select is_hidden from media where id = ${TEST_MEDIA_RETIRE}::uuid
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.is_hidden).toBe(true);
  });
});

describe("シードのゲート発火（Critical Fix 2 / spec 3-7・2-2）", () => {
  // seed.ts は therapist に image_gallery 型の photo フィールドを定義し、
  // minato の draft.photo に consent_flag=false のメディアを入れる。
  // これにより publishTherapistProfile の掲載同意ゲートが発火し、公開が拒否される。
  it("field_definitions に image_gallery 型の photo フィールドが存在する", async () => {
    const rows = await sql<{ type: string; is_public: boolean }[]>`
      select type, is_public from field_definitions
      where entity = 'therapist' and key = 'photo' and deleted_at is null
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.type).toBe("image_gallery");
    expect(rows[0]!.is_public).toBe(true);
  });

  it("minato（未同意写真）の専用公開はゲートで拒否される", async () => {
    const result = await publishTherapistProfile("minato");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("掲載同意の無い写真が含まれるため公開できません");

    // published は null のまま（公開されていない）
    const rows = await sql<{ published: unknown }[]>`
      select published from entity_records
      where entity = 'therapist' and slug = 'minato'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.published).toBeNull();
  });
});
