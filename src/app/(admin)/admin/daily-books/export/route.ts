import { type NextRequest, NextResponse } from "next/server";
import { getDevSession } from "@/lib/cms/dev-session";
import { getClient } from "@/lib/db-client";
import { getDailyBooksCore } from "@/lib/accounting/daily-books";
import { listExpensesCore } from "@/lib/accounting/queries";
import type { ExpenseCategory } from "@/lib/accounting/queries";
import { businessDayRange, type BooksPeriod } from "@/domain/accounting";

/**
 * G2 日次会計 CSV エクスポート（UTF-8 BOM・Excel 直開き可）。
 *
 * GET /admin/daily-books/export?date=YYYY-MM-DD&period=day|week|month&type=summary|expenses
 * - summary  : 個人別（件数/売上/バック/店取分）＋末尾に店舗合計行
 * - expenses : 経費明細（日付/カテゴリ/金額/メモ）
 * 営業日 06:00 JST 境界は businessDayRange に委譲（画面と同じ集計）。金額は整数円。
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  oil: "オイル",
  supplies: "備品",
  parking: "駐車場代",
  ads: "広告費",
  other: "その他",
};

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getDevSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });

  const { searchParams } = request.nextUrl;
  const date = searchParams.get("date");
  const periodRaw = searchParams.get("period") ?? "day";
  const type = searchParams.get("type") ?? "summary";

  if (!date || !DATE_RE.test(date)) return new NextResponse("date required", { status: 400 });
  if (!["day", "week", "month"].includes(periodRaw)) return new NextResponse("unknown period", { status: 400 });
  if (!["summary", "expenses"].includes(type)) return new NextResponse("unknown type", { status: 400 });
  const period = periodRaw as BooksPeriod;

  const range = businessDayRange(date, period);
  const BOM = "﻿";
  let csv = BOM;

  const sql = getClient();
  try {
    if (type === "summary") {
      csv += "セラピスト,件数,売上,バック,店取分\n";
      const books = await getDailyBooksCore(sql, session, range);
      for (const t of books.byTherapist) {
        csv += `${csvEscape(t.therapistName)},${t.reservationCount},${t.revenue},${t.payout},${t.storeShare}\n`;
      }
      // 店舗合計（経費・粗利込み）
      const s = books.storeTotal;
      csv += `店舗合計,${s.reservationCount},${s.revenue},${s.payout},${s.revenue - s.payout}\n`;
      csv += `（経費）,,,,${s.expenses}\n`;
      csv += `（粗利=売上−バック−経費）,,,,${s.grossProfit}\n`;
      csv += `（交通費お預り・売上外/ドライバー代相殺）,,,,${books.transportPassthrough}\n`;
    } else {
      csv += "日付,カテゴリ,金額,メモ\n";
      const items = await listExpensesCore(sql, session, { fromDate: range.fromDate, toDate: range.toDate });
      for (const e of items) {
        csv += `${csvEscape(e.spentOn)},${csvEscape(CATEGORY_LABEL[e.category] ?? e.category)},${e.amount},${csvEscape(e.note ?? "")}\n`;
      }
    }
  } catch (e) {
    console.error("daily-books CSV export failed:", e);
    return new NextResponse("サーバーエラー", { status: 500 });
  }

  const filename = `daily-books_${type}_${period}_${range.anchorDate}.csv`;
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
