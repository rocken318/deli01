/**
 * /admin/hotels — 派遣ホテル台帳（spec 8-2 / 12-2）。
 *
 * - owner/admin のみアクセス可（manage_cms）
 * - hotels テーブルを一覧・新規追加・編集・削除・受け入れ停止（is_blocked）できる
 * - エリアは areas(is_active=true) の select から選ぶ
 * - migration 不要（既存 hotels テーブル + RLS hotels_owner_admin）
 *
 * デザイン: spec 12-2 / 白基調・角丸4pxまで・影なし罫線区切り・1280px 想定
 */

import type { Metadata } from "next";
import { can } from "@/domain/auth";
import { toActor } from "@/lib/auth/session";
import { getDevSession } from "@/lib/cms/dev-session";
import { getClient } from "@/lib/db-client";
import { withUser } from "@/lib/auth/with-user";
import { listHotelsAdmin } from "@/lib/hotels/hotel-admin-actions";
import { HotelListClient } from "./HotelListClient";

export const metadata: Metadata = { title: "派遣ホテル" };
export const dynamic = "force-dynamic";

interface AreaOption {
  id: string;
  name: string;
}

export default async function AdminHotelsPage() {
  const session = await getDevSession();

  if (!session || !can(toActor(session), "manage_cms")) {
    return (
      <div
        role="alert"
        className="border border-adm-danger p-4 text-sm text-adm-danger"
        style={{ borderRadius: "4px" }}
      >
        <p className="font-medium">アクセス権限がありません</p>
        <p className="mt-1 text-xs">このページは owner または admin のロールが必要です。</p>
      </div>
    );
  }

  let hotels;
  let areas: AreaOption[] = [];

  try {
    const [hotelsResult, areaRows] = await Promise.all([
      listHotelsAdmin(),
      (async () => {
        const sql = getClient();
        return withUser(sql, session, async (tx) => {
          return tx<AreaOption[]>`
            select id, name from areas
            where is_active = true
            order by sort_order asc, name asc
          `;
        });
      })(),
    ]);

    if (!hotelsResult.ok) {
      throw new Error(hotelsResult.error ?? "不明なエラー");
    }
    hotels = hotelsResult.data ?? [];
    areas = areaRows;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return (
      <div
        role="alert"
        className="border border-adm-danger p-4 text-sm text-adm-danger"
        style={{ borderRadius: "4px" }}
      >
        <p className="font-medium">ホテル一覧の読み込みに失敗しました</p>
        <p className="mt-1 text-xs">{msg}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-adm-text">派遣ホテル台帳</h1>
      </div>
      <HotelListClient hotels={hotels} areas={areas} />
    </div>
  );
}