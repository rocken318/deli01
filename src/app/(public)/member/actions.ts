"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { getClient } from "@/lib/db-client";
import { verifyPin } from "@/lib/customer-portal/pin";

/**
 * 会員ページ ログイン（発注者決定 2026-09-06）。
 * 電話番号 + 暗証番号で本人確認し、成功したら既存の顧客ポータル /c/<token> へ通す。
 *
 * - PII 保護: 「見つからない」も「暗証番号違い」も同じ汎用エラー（列挙させない）。
 * - 総当り対策: 連続失敗5回で15分ロック。成功で失敗カウントをリセット。
 * - RLS はバイパス（公開・セッション無し）だが、phone+PIN 一致時のみトークンを露出する。
 */

const LOCK_THRESHOLD = 5;
const LOCK_MINUTES = 15;

const schema = z.object({
  phone: z.string().regex(/^0[0-9]{9,10}$/),
  pin: z.string().regex(/^[0-9]{4,6}$/),
});

export type MemberLoginResult = { ok: false; error: "invalid" | "bad_credentials" | "locked" };

export async function memberLogin(input: { phone: string; pin: string }): Promise<MemberLoginResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { phone, pin } = parsed.data;

  const sql = getClient();
  const rows = await sql<
    {
      id: string;
      portal_token: string;
      portal_pin_hash: string | null;
      locked: boolean;
    }[]
  >`
    select id, portal_token, portal_pin_hash,
           (portal_login_locked_until is not null and portal_login_locked_until > now()) as locked
    from customers where phone = ${phone} limit 1
  `;
  const row = rows[0];

  // ロック中は一律ロック応答（存在有無は明かさない）
  if (row?.locked) return { ok: false, error: "locked" };

  const good = row ? verifyPin(pin, row.portal_pin_hash) : false;

  if (!good) {
    // 失敗カウントを増やし、閾値でロック（存在する顧客のみ。存在しない番号は何もしない）
    if (row) {
      await sql`
        update customers
        set portal_login_fail_count = portal_login_fail_count + 1,
            portal_login_locked_until = case
              when portal_login_fail_count + 1 >= ${LOCK_THRESHOLD}
              then now() + (${LOCK_MINUTES} || ' minutes')::interval
              else portal_login_locked_until end
        where id = ${row.id}::uuid
      `;
    }
    return { ok: false, error: "bad_credentials" };
  }

  // 成功: 失敗カウントをリセットしてポータルへ
  await sql`
    update customers set portal_login_fail_count = 0, portal_login_locked_until = null
    where id = ${row!.id}::uuid
  `;
  redirect(`/c/${row!.portal_token}`);
}
