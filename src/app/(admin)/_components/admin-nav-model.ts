/**
 * 管理サイドバーのナビ定義（設計 2章）とアクティブ判定（純関数）。
 * 既存の全ページをグループへ分類する（リンク欠落を作らない）。
 * 「主要」は電話受付/案内表/配車ボード/予約管理/当日給料をピン留め。
 */
export interface AdminNavItem {
  href: string;
  label: string;
}

export interface AdminNavGroup {
  label: string;
  items: AdminNavItem[];
}

export const ADMIN_NAV_GROUPS: AdminNavGroup[] = [
  {
    label: "主要",
    items: [
      { href: "/admin/orders", label: "電話受付" },
      { href: "/admin/reservation-list", label: "予約一覧" },
      { href: "/admin/annai", label: "案内表" },
      { href: "/admin/dispatch-board", label: "配車ボード" },
      { href: "/admin/todays-pay", label: "当日給料" },
    ],
  },
  {
    label: "受付・配車",
    items: [
      { href: "/admin/reservations", label: "予約管理" },
      { href: "/admin/cti", label: "着信" },
      { href: "/admin/phone-confirm", label: "電話確認" },
      { href: "/admin/waitlists", label: "キャンセル待ち" },
      { href: "/admin/history", label: "接客履歴" },
      { href: "/admin/dispatch", label: "配車テキスト" },
      { href: "/admin/dispatch-roster", label: "配車名簿" },
      { href: "/admin/drivers", label: "ドライバー登録" },
      { href: "/admin/direction-groups", label: "方面グループ" },
      { href: "/admin/transport-ledger", label: "送り台帳" },
      { href: "/admin/hotel-lookup", label: "ホテルリスト" },
    ],
  },
  {
    label: "会計・報酬",
    items: [
      { href: "/admin/accounting", label: "会計" },
      { href: "/admin/daily-books", label: "日次会計" },
      { href: "/admin/payouts", label: "報酬" },
      { href: "/admin/back-prices", label: "バック単価表" },
      { href: "/admin/analytics", label: "集計" },
      { href: "/admin/points", label: "ポイント" },
    ],
  },
  {
    label: "セラピスト・出勤",
    items: [
      { href: "/admin/therapists", label: "セラピスト" },
      { href: "/admin/shifts", label: "出勤登録" },
      { href: "/admin/photo-submissions", label: "写真承認" },
    ],
  },
  {
    label: "コンテンツ・設定",
    items: [
      { href: "/admin/fields", label: "入力項目" },
      { href: "/admin/records", label: "コンテンツ" },
      { href: "/admin/pages", label: "固定ページ" },
      { href: "/admin/lineup", label: "表ページ並び順" },
      { href: "/admin/media", label: "メディア" },
      { href: "/admin/settings", label: "サイト設定" },
      { href: "/admin/areas", label: "派遣エリア" },
      { href: "/admin/hotels", label: "派遣ホテル" },
      { href: "/admin/message-templates", label: "送信テンプレート" },
      { href: "/admin/notifications", label: "通知" },
      { href: "/admin/preview/home", label: "プレビュー" },
      { href: "/admin/ai", label: "AI" },
    ],
  },
];

/**
 * pathname に対応するナビ項目を返す（完全一致 or 前方一致 "href + /"）。
 * 複数一致した時は最長 href を優先（/admin/preview/home が /admin に勝つ）。
 */
export function findActiveNavItem(
  groups: AdminNavGroup[],
  pathname: string,
): AdminNavItem | null {
  let best: AdminNavItem | null = null;
  for (const group of groups) {
    for (const item of group.items) {
      if (pathname === item.href || pathname.startsWith(item.href + "/")) {
        if (best === null || item.href.length > best.href.length) {
          best = item;
        }
      }
    }
  }
  return best;
}
