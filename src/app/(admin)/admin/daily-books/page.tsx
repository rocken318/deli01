import type { Metadata } from "next";
import { getDailyBooks, listExpenses } from "@/lib/accounting/actions";
import type { ExpenseItem } from "@/lib/accounting/queries";
import { todayISOInTokyo, type BooksPeriod } from "@/domain/accounting";
import DailyBooksClient from "./DailyBooksClient";

export const metadata: Metadata = { title: "日次会計" };
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * G 日次会計（受付表の確認用 / SGS 形）。
 * ?date=YYYY-MM-DD & ?period=day|week|month で指定。営業日は 06:00 JST 境界。
 * 既存台帳の読み取りレンズ（締めロックなし / 発注者確認 2026-09-02）。
 */
export default async function DailyBooksPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; period?: string }>;
}) {
  const params = await searchParams;
  const period: BooksPeriod =
    params.period === "week" || params.period === "month" ? params.period : "day";
  const todayISO = todayISOInTokyo(Date.now());
  const dateISO = typeof params.date === "string" && DATE_RE.test(params.date) ? params.date : todayISO;

  const booksRes = await getDailyBooks({ dateISO, period });
  const books = booksRes.ok ? (booksRes.data ?? null) : null;
  const error = booksRes.ok ? undefined : booksRes.error;

  let expenses: ExpenseItem[] = [];
  if (books) {
    const expRes = await listExpenses({ fromDate: books.fromDate, toDate: books.toDate });
    if (expRes.ok) expenses = expRes.data ?? [];
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-adm-text mb-1">日次会計</h1>
      <p className="text-sm text-adm-muted mb-4">
        営業日ごとの売上・バック（自動計算）・経費・粗利の確認用。営業日は 06:00〜翌06:00（深夜分は前営業日）。
        経費はこの画面で手入力できます。締めロックはありません（確認用）。
      </p>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm mb-4">{error}</div>
      )}

      <DailyBooksClient
        dateISO={dateISO}
        period={period}
        todayISO={todayISO}
        books={books}
        expenses={expenses}
      />
    </div>
  );
}
