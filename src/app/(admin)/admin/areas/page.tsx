/**
 * /admin/areas — 派遣エリア台帳（spec 3-3 / 12-2）。
 *
 * areas テーブルを管理画面から追加・有効/無効・改名できる。
 * is_active=true のエリアが出勤設定（/admin/shifts）の対応エリアチェックに自動で出る。
 * マイグレーション不要（既存 RLS areas_owner_admin で owner/admin が CRUD 可）。
 *
 * デザイン: spec 12-2 / 白基調・角丸4pxまで・影なし罫線区切り・1280px 想定
 */

import type { Metadata } from "next";
import Link from "next/link";
import { can } from "@/domain/auth";
import { toActor } from "@/lib/auth/session";
import { getDevSession } from "@/lib/cms/dev-session";
import { listDispatchAreas } from "@/lib/cms/area-actions";
import { AreaListClient } from "./AreaListClient";

export const metadata: Metadata = { title: "派遣エリア" };
export const dynamic = "force-dynamic";

export default async function AdminAreasPage() {
  const session = await getDevSession();

  // 権限ゲート（未ログイン・非 owner/admin）
  if (!session || !can(toActor(session), "manage_cms")) {
    return (
      <div
        role="alert"
        className="border border-adm-danger p-4 text-sm text-adm-danger"
        style={{ borderRadius: "4px" }}
      >
        <p className="font-medium">アクセス権限がありません</p>
        <p className="mt-1 text-xs">
          このページは owner または admin のロールが必要です。
        </p>
      </div>
    );
  }

  // エリア一覧取得
  let areas;
  try {
    areas = await listDispatchAreas();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return (
      <div
        role="alert"
        className="border border-adm-danger p-4 text-sm text-adm-danger"
        style={{ borderRadius: "4px" }}
      >
        <p className="font-medium">エリア一覧の読み込みに失敗しました</p>
        <p className="mt-1 text-xs">{msg}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ヘッダー */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-adm-text">派遣エリア台帳</h1>
        <Link
          href="/admin/shifts"
          className="border border-adm-border px-3 py-1.5 text-sm text-adm-text hover:border-adm-primary hover:text-adm-primary"
          style={{ borderRadius: "4px" }}
        >
          出勤設定へ
        </Link>
      </div>

      {/* クライアント側コンポーネント（追加・トグル・改名） */}
      <AreaListClient areas={areas} />
    </div>
  );
}
