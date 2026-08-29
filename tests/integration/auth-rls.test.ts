import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { withUser } from "@/lib/auth/with-user";
import type { Session } from "@/lib/auth/session";
import type { Role } from "@/domain/auth";

/**
 * フェーズ1の統合テスト（実 Postgres / spec 15章「権限」）。
 * RLS はモックでは検証できないため、migrate + seed 済みの DB に対して行う。
 *
 * 検証の骨子:
 * - withUser()（GUC + set local role app_runtime）で張ったセッションに RLS が効く
 * - therapist は自分以外の app_users 行が見えない（15章「他人の〜を取得できない」の
 *   代理検証。addresses / payouts が入るフェーズで同型のポリシーに拡張する）
 * - audit_logs は追記専用で、actor の詐称ができず、閲覧は owner/admin のみ
 * - public スキーマの全テーブルで RLS が有効（将来の張り忘れを検出する網）
 *
 * ここでの素の `sql`（withUser なし）は superuser = RLS 素通りの保守経路であり、
 * 期待値の突き合わせ（全件数の取得など）に使う。
 */
const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/deli01";
const sql = postgres(url, { max: 1, onnotice: () => {} });

/** seed 済みテストアカウント（scripts/seed.ts）をロールで引く */
const seedUsers = new Map<Role, { id: string }>();

function sessionOf(role: Role): Session {
  const u = seedUsers.get(role);
  if (!u) throw new Error(`seed に ${role} のテストアカウントがない`);
  return { userId: u.id, role };
}

beforeAll(async () => {
  const rows = await sql<{ id: string; role: Role }[]>`
    select id, role from app_users where display_name like '（ダミー）%'
  `;
  for (const r of rows) seedUsers.set(r.role, { id: r.id });
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("RLS の網羅性", () => {
  it("public の全テーブルで RLS が有効（extension 由来と schema_migrations を除く）", async () => {
    const rows = await sql<{ relname: string }[]>`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and not c.relrowsecurity
        and c.relname <> 'schema_migrations'
        and not exists (
          select 1 from pg_depend d
          where d.objid = c.oid and d.deptype = 'e'
        )
    `;
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
});

describe("app_users の RLS（spec 15章の代理検証）", () => {
  it("therapist ロールでは自分以外の app_users 行が見えない", async () => {
    const me = sessionOf("therapist");
    const visible = await withUser(sql, me, async (tx) => {
      return tx<{ id: string }[]>`select id from app_users`;
    });
    expect(visible.length).toBe(1);
    expect(visible[0]?.id).toBe(me.userId);
  });

  it("admin ロールでは全ロールのアカウントが見える", async () => {
    const all = await sql<{ n: string }[]>`select count(*)::text as n from app_users`;
    const visible = await withUser(sql, sessionOf("admin"), async (tx) => {
      return tx<{ id: string }[]>`select id from app_users`;
    });
    expect(visible.length).toBe(Number(all[0]?.n));
    expect(visible.length).toBeGreaterThanOrEqual(4);
  });

  it("therapist ロールでは app_users に行を作れない（RLS 違反で拒否）", async () => {
    await expect(
      withUser(sql, sessionOf("therapist"), async (tx) => {
        await tx`
          insert into app_users (role, display_name)
          values ('admin'::app_role, '侵入テスト')
        `;
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("withUser を通らないアプリ相当の接続（app_runtime・GUC なし）では自分の行すら見えない = fail-closed", async () => {
    const visible = await sql.begin(async (tx) => {
      await tx`select set_config('role', 'app_runtime', true)`;
      return tx<{ id: string }[]>`select id from app_users`;
    });
    expect(visible.length).toBe(0);
  });
});

describe("audit_logs（spec 3章・13-3: 住所閲覧の記録 / 追記専用）", () => {
  it("therapist が住所閲覧ログ（action='view', entity='address'）を残せる", async () => {
    const me = sessionOf("therapist");
    const addressId = randomUUID();
    await withUser(sql, me, async (tx) => {
      await tx`
        insert into audit_logs (actor_user_id, action, entity, entity_id)
        values (${me.userId}, 'view', 'address', ${addressId})
      `;
    });
    const rows = await sql`
      select 1 from audit_logs
      where actor_user_id = ${me.userId}
        and action = 'view' and entity = 'address' and entity_id = ${addressId}
    `;
    expect(rows.length).toBe(1);
  });

  it("actor_user_id を他人に詐称した insert は拒否される", async () => {
    const admin = sessionOf("admin");
    await expect(
      withUser(sql, sessionOf("therapist"), async (tx) => {
        await tx`
          insert into audit_logs (actor_user_id, action, entity)
          values (${admin.userId}, 'view', 'address')
        `;
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("therapist は監査ログを読めない / admin は読める", async () => {
    const asTherapist = await withUser(sql, sessionOf("therapist"), async (tx) => {
      return tx<{ id: string }[]>`select id from audit_logs`;
    });
    expect(asTherapist.length).toBe(0);

    const asAdmin = await withUser(sql, sessionOf("admin"), async (tx) => {
      return tx<{ id: string }[]>`select id from audit_logs`;
    });
    expect(asAdmin.length).toBeGreaterThan(0);
  });

  it("追記専用: admin でも update / delete できない（grant なし）", async () => {
    await expect(
      withUser(sql, sessionOf("admin"), async (tx) => {
        await tx`update audit_logs set action = 'tampered'`;
      }),
    ).rejects.toThrow(/permission denied/);

    await expect(
      withUser(sql, sessionOf("admin"), async (tx) => {
        await tx`delete from audit_logs`;
      }),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("CMS テーブルの RLS", () => {
  it("terminology は therapist セッションでも読める（公開側が参照するため）", async () => {
    const rows = await withUser(sql, sessionOf("therapist"), async (tx) => {
      return tx<{ key: string }[]>`select key from terminology`;
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  it("reception は site_settings を書き換えられない / admin は書き換えられる", async () => {
    await expect(
      withUser(sql, sessionOf("reception"), async (tx) => {
        await tx`
          insert into site_settings (key, value)
          values ('rls_test_key', '"x"'::jsonb)
        `;
      }),
    ).rejects.toThrow(/row-level security/);

    await withUser(sql, sessionOf("admin"), async (tx) => {
      await tx`
        insert into site_settings (key, value)
        values ('rls_test_key', '"x"'::jsonb)
        on conflict (key) do update set value = excluded.value
      `;
    });
    // 後片付け（保守経路 = superuser）
    await sql`delete from site_settings where key = 'rls_test_key'`;
  });
});
