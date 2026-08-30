/**
 * CTI 着信 webhook の受け口（フェーズ22・**下地のみ** / spec 付録A#6・L1074）。
 *
 * CTI ベンダー（050番号 + API 等）が着信時にこのエンドポイントを叩く想定。
 * 電話番号で顧客を引き当て、cti_events に1行積む（受付画面 /admin/cti が表示＝ポップの下地）。
 *
 * セッションは無い（ベンダーが叩く）ので、共有シークレット（CTI_WEBHOOK_SECRET・任意）で
 * 認証し、特権接続で insert する（公開予約作成と同じ system 経路）。ベンダー固有の署名検証・
 * リアルタイム push・回線契約前提の作り込みは先送り（発注者判断で下地のみ）。
 *
 * 顧客の個人情報は AI へ渡さない設計（spec 19-4）とは無関係の受付内部用途。
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getClient } from '@/lib/db-client';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  phone: z.string().regex(/^0[0-9]{9,10}$/u, '電話番号の形式が不正です'),
});

export async function POST(req: Request): Promise<NextResponse> {
  // 共有シークレットが設定されていれば検証（未設定なら下地として素通し）
  const secret = process.env.CTI_WEBHOOK_SECRET;
  if (secret) {
    const provided = req.headers.get('x-cti-secret');
    if (provided !== secret) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: '電話番号が不正です' }, { status: 400 });
  }
  const phone = parsed.data.phone;

  try {
    const sql = getClient();
    // 顧客引き当て（受付ポップ用に最小限。個人情報は受付内部でのみ扱う）
    const customers = await sql<{ id: string; name: string; note: string | null }[]>`
      select id, name, note from customers where phone = ${phone} limit 1
    `;
    const customer = customers[0] ?? null;

    // 着信イベントを記録（受付画面がこの表を読んで「ポップ」を出す下地）
    await sql`
      insert into cti_events (phone, customer_id, matched_name)
      values (${phone}, ${customer?.id ?? null}::uuid, ${customer?.name ?? null})
    `;

    return NextResponse.json({
      ok: true,
      matched: customer !== null,
      customer: customer
        ? { id: customer.id, name: customer.name, note: customer.note }
        : null,
    });
  } catch (e) {
    console.error('CTI incoming failed:', e);
    return NextResponse.json({ ok: false, error: 'internal error' }, { status: 500 });
  }
}
