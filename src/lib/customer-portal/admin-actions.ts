'use server';

/**
 * 管理側: 顧客のマイページ（マジックリンク）パスを取得して受付が共有できるようにする。
 * staff（owner/admin/reception）が RLS 経由で customers.portal_token を引く。
 */

import { z } from 'zod';
import { getDevSession } from '@/lib/cms/dev-session';
import { getClient } from '@/lib/db-client';
import { withUser } from '@/lib/auth/with-user';
import { hashPin } from './pin';

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

const schema = z
  .object({
    phone: z.string().regex(/^0[0-9]{9,10}$/).optional(),
    customerId: z.string().uuid().optional(),
  })
  .refine((v) => v.phone != null || v.customerId != null, { message: '電話番号か顧客IDが必要です' });

/** 顧客ページのパス（/c/<token>）を返す。共有用。 */
export async function getCustomerPortalLink(
  input: z.infer<typeof schema>,
): Promise<ActionResult<{ path: string }>> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: '入力が不正です' };

  try {
    const sql = getClient();
    const { phone, customerId } = parsed.data;
    const rows = await withUser(sql, session, async (tx) => {
      if (phone) {
        return tx<{ portal_token: string }[]>`select portal_token from customers where phone = ${phone}`;
      }
      return tx<{ portal_token: string }[]>`select portal_token from customers where id = ${customerId!}::uuid`;
    });
    const token = rows[0]?.portal_token;
    if (!token) return { ok: false, error: '顧客が見つかりません' };
    return { ok: true, data: { path: `/c/${token}` } };
  } catch (e) {
    console.error('getCustomerPortalLink failed:', e);
    return { ok: false, error: 'リンクの取得に失敗しました' };
  }
}

const setPinSchema = z
  .object({
    phone: z.string().regex(/^0[0-9]{9,10}$/).optional(),
    customerId: z.string().uuid().optional(),
    pin: z.string().regex(/^[0-9]{4,6}$/, '暗証番号は数字4〜6桁'),
  })
  .refine((v) => v.phone != null || v.customerId != null, { message: '電話番号か顧客IDが必要です' });

/**
 * 顧客の会員ページ暗証番号を設定/変更する（staff のみ）。
 * scrypt ハッシュで保存。お客様はこの番号＋電話番号で /member からログインできる。
 */
export async function setCustomerPortalPin(
  input: z.infer<typeof setPinSchema>,
): Promise<ActionResult> {
  const session = await getDevSession();
  if (!session) return { ok: false, error: '認証が必要です' };
  const parsed = setPinSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.errors.map((e) => e.message).join(', ') };

  try {
    const sql = getClient();
    const { phone, customerId, pin } = parsed.data;
    const hash = hashPin(pin);
    const rows = await withUser(sql, session, async (tx) => {
      if (phone) {
        return tx<{ id: string }[]>`
          update customers set portal_pin_hash = ${hash} where phone = ${phone} returning id`;
      }
      return tx<{ id: string }[]>`
        update customers set portal_pin_hash = ${hash} where id = ${customerId!}::uuid returning id`;
    });
    if (!rows[0]) return { ok: false, error: '顧客が見つかりません' };
    return { ok: true };
  } catch (e) {
    console.error('setCustomerPortalPin failed:', e);
    return { ok: false, error: '暗証番号の設定に失敗しました' };
  }
}
